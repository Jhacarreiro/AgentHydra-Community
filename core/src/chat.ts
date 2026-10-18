// The chat loop (core/README.md): one turn at a time per chat, a queue behind it, a pin that moves a chat to Codex or
// ChatGPT with a handoff, a limit that moves a turn to the next account. Desk 2's rules: engine/chat-manager.ts.
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { titleFromPrompt } from '../../desk2/server/src/engine/describe'
import { ANSWER_NOW, buildHandoff, PINNED } from '../../desk2/server/src/engine/handoff'
import type { ServerEvent } from '../../desk2/shared/protocol'
import type { Store } from './store'
import type {
  Account,
  Accounts,
  Backend,
  ChatSummary,
  History,
  Image,
  Service,
  ServiceThread,
  Task,
  TranscriptItem,
  Turn,
  TurnEnd,
  TurnSink,
} from './types'

export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type Json = Record<string, unknown>

export function obj(v: unknown): Json {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new ChatError(400, 'the body must be a JSON object')
  return v as Json
}

export function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new ChatError(400, `${what} must be a string`)
  return v
}

const LABEL: Record<Service, string> = { claude: 'Claude', codex: 'Codex', chatgpt: 'ChatGPT' }
const NEW_TITLE = 'New chat'
/** A message every login throttled (a 429) waits this long between tries, for up to THROTTLE_WAIT_MS in all. */
const THROTTLE_RETRY_MS = 15_000
const THROTTLE_WAIT_MS = 4 * 60_000
const SELF = `http://127.0.0.1:${process.env.CORE_PORT ?? 7789}/api`
type UserItem = Extract<TranscriptItem, { kind: 'user' }>

/** A message waiting for its turn. `item` is what the transcript shows (queued until it goes). */
interface Queued {
  item: UserItem
  text: string
  images?: Image[]
}
/** The turn in progress: its service, and its backend turn once one has started (none while an account is picked). */
interface Running {
  service: Service
  turn?: Turn
}
interface Entry {
  chat: ChatSummary
  queue: Queued[]
  running?: Running
  interrupted: boolean
}

export interface ChatDeps {
  store: Store
  accounts: Accounts
  history: History
  backends: Backend[]
  emit: (event: ServerEvent) => void
}

export class Chats {
  private entries = new Map<string, Entry>()
  private backend = new Map<Service, Backend>()

  constructor(private d: ChatDeps) {
    for (const b of d.backends) this.backend.set(b.service, b)
    for (const chat of d.store.list()) {
      // A turn a restart cut off cannot resume: it says so, rather than look busy forever.
      if (chat.status === 'starting' || chat.status === 'working') {
        Object.assign(chat, {
          status: 'error',
          lastError: 'AgentHydra core restarted during this turn',
          activity: null,
          turnStartedAt: null,
        })
      }
      this.entries.set(chat.id, { chat, queue: [], interrupted: false })
    }
  }

  list(): ChatSummary[] {
    return [...this.entries.values()].map((e) => e.chat)
  }

  get(id: string): ChatSummary {
    return this.entry(id).chat
  }

  items(id: string): TranscriptItem[] {
    this.entry(id)
    return this.d.store.items(id)
  }

  create(body: Json): ChatSummary {
    const cwd = checkCwd(body.cwd)
    const title = body.title === undefined ? '' : str(body.title, 'title').trim()
    const chat = fresh({ title: title || NEW_TITLE, cwd })
    this.add({ chat, queue: [], interrupted: false })
    return chat
  }

  patch(id: string, body: Json): ChatSummary {
    const e = this.entry(id)
    for (const key of Object.keys(body)) {
      if (!['title', 'group', 'service'].includes(key))
        throw new ChatError(400, `${key} cannot be changed`)
    }
    const title = 'title' in body ? str(body.title, 'title').trim() : undefined
    if (title === '') throw new ChatError(400, 'title cannot be empty')
    const group = 'group' in body && body.group !== null ? str(body.group, 'group').trim() : null
    if (group === '' || (group && group.length > 60))
      throw new ChatError(400, 'group must be 1 to 60 characters')
    if (
      'service' in body &&
      body.service !== null &&
      body.service !== 'codex' &&
      body.service !== 'chatgpt'
    ) {
      throw new ChatError(400, 'service must be codex, chatgpt or null')
    }
    if (title !== undefined) e.chat.title = title
    if ('group' in body) e.chat.group = group
    if ('service' in body) this.pin(e, (body.service as 'codex' | 'chatgpt' | null) ?? null)
    this.save(e)
    return e.chat
  }

  async remove(id: string): Promise<void> {
    const e = this.entry(id)
    // Gone from the map first: nothing is sent or written for it from here on.
    this.entries.delete(id)
    e.queue = []
    e.running?.turn?.interrupt()
    await Promise.allSettled([...this.backend.values()].map((b) => b.release(id)))
    this.d.store.remove(id)
    this.d.emit({ type: 'chat.removed', chatId: id })
  }

  interrupt(id: string): void {
    const e = this.entry(id)
    if (!e.running) return
    e.interrupted = true
    e.running.turn?.interrupt()
  }

  send(id: string, body: Json): { queued: boolean } {
    const e = this.entry(id)
    const text = str(body.text, 'text')
    const imgs = images(body.images)
    if (!text.trim() && !imgs.length) throw new ChatError(400, 'text is required')
    // A chat opened empty is named by its first message.
    if (e.chat.title === NEW_TITLE && text.trim()) e.chat.title = titleFromPrompt(text)
    // Sent while a turn runs (on any service, including the one a pin just left): it waits and shows queued.
    const queued = e.running !== undefined
    const item: UserItem = {
      kind: 'user',
      id: `user:${randomUUID()}`,
      ts: Date.now(),
      text,
      ...(imgs.length ? { images: imgs } : {}),
      ...(queued ? { queued: true } : {}),
    }
    e.queue.push({ item, text, images: imgs.length ? imgs : undefined })
    this.write(e, item)
    this.save(e)
    this.pump(e)
    return { queued }
  }

  cancelQueued(id: string, body: Json): { ok: true; cancelled: boolean; message: string } {
    const e = this.entry(id)
    const itemId = str(body.itemId, 'itemId')
    const at = e.queue.findIndex((q) => q.item.id === itemId)
    if (at < 0)
      return {
        ok: true,
        cancelled: false,
        message: 'Too late to cancel: it already went into this turn.',
      }
    e.queue.splice(at, 1)
    this.d.store.drop(id, itemId)
    this.d.emit({ type: 'item.removed', chatId: id, itemId })
    this.save(e)
    return { ok: true, cancelled: true, message: 'Taken back: it is not sent.' }
  }

  /** Import an outside Claude session or Codex thread. Two imports of one session answer the same chat. */
  async importSession(body: Json): Promise<ChatSummary> {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!sessionId) throw new ChatError(400, 'sessionId is required')
    const hit = this.byOutside(sessionId)
    if (hit) return hit.chat
    const ext = await this.d.history.find(sessionId)
    if (!ext) throw new ChatError(404, `no session ${sessionId}`)
    // Checked again after the await, then inserted with no await in between: a second import lands on this chat.
    const again = this.byOutside(sessionId)
    if (again) return again.chat
    const cwd = checkCwd(ext.cwd)
    const chat = fresh({ title: ext.title || NEW_TITLE, cwd })
    if (ext.source === 'codex') {
      chat.service = 'codex'
      chat.serviceThreads = {
        codex: {
          accountId: ext.codexAccountId ?? '',
          label: ext.instance ?? 'Codex',
          threadId: sessionId,
        },
      }
    } else {
      chat.sessionId = sessionId
      if (ext.accountId)
        chat.account = { id: ext.accountId, label: ext.instance ?? ext.accountId, configDir: null }
    }
    const e: Entry = { chat, queue: [], interrupted: false }
    this.add(e)
    const page = await this.d.history.tail(sessionId).catch(() => null)
    for (const item of page?.items ?? []) this.d.store.append(chat.id, item)
    if (!page) this.line(e, 'warn', 'The earlier history could not be loaded.')
    this.save(e)
    return chat
  }

  private add(e: Entry): void {
    this.entries.set(e.chat.id, e)
    this.save(e)
  }

  private byOutside(sessionId: string): Entry | undefined {
    return [...this.entries.values()].find(
      (e) => e.chat.sessionId === sessionId || e.chat.serviceThreads?.codex?.threadId === sessionId,
    )
  }

  private entry(id: string): Entry {
    const e = this.entries.get(id)
    if (!e) throw new ChatError(404, `no chat ${id}`)
    return e
  }

  private alive(e: Entry): boolean {
    return this.entries.get(e.chat.id) === e
  }

  private save(e: Entry): void {
    if (!this.alive(e)) return
    e.chat.queuedCount = e.queue.length
    this.d.store.put(e.chat)
    this.d.emit({ type: 'chat.upsert', chat: e.chat })
  }

  private write(e: Entry, item: TranscriptItem): void {
    if (!this.alive(e)) return
    this.d.store.append(e.chat.id, item)
    this.d.emit({ type: 'item.upsert', chatId: e.chat.id, item })
  }

  private line(e: Entry, level: 'info' | 'warn' | 'error', text: string): void {
    this.write(e, { kind: 'system', id: `sys:${randomUUID()}`, ts: Date.now(), level, text })
  }

  /** Changes the pin. The turn running now finishes where it is; the next one runs on the new service. */
  private pin(e: Entry, to: 'codex' | 'chatgpt' | null): void {
    const from: Service = e.chat.service ?? 'claude'
    const target: Service = to ?? 'claude'
    if (from === target) return
    e.chat.serviceLeftAt = { ...e.chat.serviceLeftAt, [from]: Date.now() }
    e.chat.service = to
    this.line(
      e,
      'info',
      to ? `This chat now runs on ${LABEL[to]}.` : 'This chat runs on Claude again.',
    )
  }

  /** Starts the next queued message, when no turn is running. The pin is read now, so a message waits for the reply
   *  in progress and then goes to the service the chat is pinned to when that reply ends. */
  private pump(e: Entry): void {
    if (e.running || !this.alive(e) || !e.queue.length) return
    const next = e.queue.shift()!
    const { queued: _queued, ...sent } = next.item
    if (next.item.queued) this.write(e, sent)
    const running: Running = { service: e.chat.service ?? 'claude' }
    e.running = running
    e.chat.status = 'starting'
    e.chat.turnStartedAt = Date.now()
    e.chat.activity = null
    this.save(e)
    this.run(e, running, next.text, next.images, sent.id).catch((err) =>
      console.error('turn:', message(err)),
    )
  }

  private async run(
    e: Entry,
    running: Running,
    text: string,
    imgs: Image[] | undefined,
    sentId: string,
  ): Promise<void> {
    const started = Date.now()
    let end: TurnEnd
    try {
      end = await this.attempts(e, running, text, imgs, sentId, started)
    } catch (err) {
      end = { ok: false, error: message(err) }
    }
    this.finish(e, end, started)
  }

  /** One turn, on an account of the service: a limit holds that account and runs the message again on the next one. */
  private async attempts(
    e: Entry,
    running: Running,
    text: string,
    imgs: Image[] | undefined,
    sentId: string,
    started: number,
  ): Promise<TurnEnd> {
    const service = running.service
    const backend = this.backend.get(service)
    if (!backend) return { ok: false, error: `No ${LABEL[service]} backend in this core` }
    let lead = this.leadFor(e, service, sentId)
    e.chat.serviceRanOn = service === 'claude' ? undefined : service
    let thread = this.boundThread(e, service)
    const avoid = new Set<string>()
    /** Logins that throttled this message: tried again once the rest are spent, for up to THROTTLE_WAIT_MS. */
    const throttled = new Set<string>()
    for (;;) {
      const picked = await this.accountFor(service, thread, avoid)
      if (!this.alive(e)) return { ok: false }
      if ('why' in picked) {
        if (!throttled.size || Date.now() - started > THROTTLE_WAIT_MS)
          return { ok: false, error: picked.why }
        // Every login with room is throttling: a 429 passes, so the message waits and tries them again (2026-10-14,
        // probe round 5: two logins answering 429 and two at their limit, and three chats gave up at once).
        if (!(await this.backOff(e, service))) return { ok: false }
        for (const id of throttled) avoid.delete(id)
        throttled.clear()
        continue
      }
      if (e.interrupted) return { ok: false }
      this.bindAccount(e, service, picked)
      // The turn before this one may still hold the thread: its backend lets go only after it has ended (Codex's
      // unsubscribe), so a queued message waits for that here instead of resuming the thread under it.
      await backend.release(e.chat.id)
      if (!this.alive(e)) return { ok: false }
      if (e.interrupted) return { ok: false }
      const task: Task = {
        chatId: e.chat.id,
        cwd: e.chat.cwd,
        title: e.chat.title,
        text: lead ? `${lead}${ANSWER_NOW}${text}` : text,
        images: imgs,
        thread,
        permissionMode: e.chat.permissionMode,
        model: e.chat.model,
      }
      const turn = backend.start(task, picked, this.sink(e, service))
      running.turn = turn
      e.chat.status = 'working'
      this.save(e)
      const end = await turn.done
      if (!this.alive(e) || e.interrupted || (end.limitedUntil === undefined && !end.throttled))
        return end
      if (end.throttled && thread && Date.now() - started < THROTTLE_WAIT_MS) {
        // A thread lives on its login: a throttle there is waited out on the same thread, not moved.
        console.warn(
          `[core:chat] ${e.chat.id.slice(0, 8)} ${service} ${picked.id.slice(0, 8)} throttled; waiting`,
        )
        if (!(await this.backOff(e, service))) return { ok: false }
        continue
      }
      if (end.limitedUntil !== undefined) this.d.accounts.hold(picked.id, end.limitedUntil)
      else throttled.add(picked.id)
      avoid.add(picked.id)
      console.warn(
        `[core:chat] ${e.chat.id.slice(0, 8)} ${service} ${picked.id.slice(0, 8)} ${end.limitedUntil === undefined ? 'throttled' : `held until ${new Date(end.limitedUntil).toISOString()}`}: ${end.error ?? ''}`,
      )
      // The next account starts a new thread, which knows nothing yet: it reads the whole chat first, the moved turn's
      // own words included (2026-10-14, round 6: read from this turn's start only, a throttle move dropped the catch-up
      // from Claude, and Codex answered 'Unknown' for the code word).
      thread = undefined
      lead = this.handoff(e, 0, sentId, {
        why: end.throttled ? 'the provider throttled the account' : 'usage limit',
      })
    }
  }

  /** Waits THROTTLE_RETRY_MS, saying so in the chat; false once the chat is deleted or stopped meanwhile. */
  private async backOff(e: Entry, service: Service): Promise<boolean> {
    this.sink(e, service).activity(`${LABEL[service]} is busy right now; trying again shortly`)
    for (let waited = 0; waited < THROTTLE_RETRY_MS; waited += 1000) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 1000))
      if (!this.alive(e) || e.interrupted) return false
    }
    return true
  }

  private finish(e: Entry, end: TurnEnd, started: number): void {
    const interrupted = e.interrupted
    e.running = undefined
    e.interrupted = false
    if (!this.alive(e)) return
    const ok = end.ok
    const error = ok ? undefined : interrupted ? 'Interrupted' : (end.error ?? 'The turn failed')
    const stopped = ok || interrupted
    e.chat.status = stopped ? 'idle' : 'error'
    e.chat.lastError = stopped ? null : (error ?? null)
    e.chat.activity = null
    e.chat.turnStartedAt = null
    const now = Date.now()
    e.chat.updatedAt = now
    this.write(e, {
      kind: 'result',
      id: `result:${randomUUID()}`,
      ts: now,
      ok,
      durationMs: end.durationMs ?? now - started,
      costUsd: 0,
      turns: 0,
      ...(error ? { error } : {}),
    })
    this.save(e)
    this.pump(e)
  }

  private sink(e: Entry, service: Service): TurnSink {
    return {
      item: (item) => this.write(e, item),
      thread: (t) => {
        if (!this.alive(e)) return
        if (service === 'claude') e.chat.sessionId = t.threadId
        else e.chat.serviceThreads = { ...e.chat.serviceThreads, [service]: t }
        this.save(e)
      },
      activity: (text) => {
        if (!this.alive(e)) return
        e.chat.activity = text
        // Activity is shown, not kept: the emit alone, no rewrite of chats.json.
        this.d.emit({ type: 'chat.upsert', chat: e.chat })
      },
    }
  }

  /** The thread a turn on the service continues: Claude's session (on the chat's account), or the pinned service's. */
  private boundThread(e: Entry, service: Service): ServiceThread | undefined {
    if (service === 'claude') {
      return e.chat.sessionId
        ? { accountId: e.chat.account.id, label: e.chat.account.label, threadId: e.chat.sessionId }
        : undefined
    }
    return e.chat.serviceThreads?.[service]
  }

  /** The account a thread is bound to when the chat has one there, else the picker's choice. */
  private async accountFor(
    service: Service,
    thread: ServiceThread | undefined,
    avoid: ReadonlySet<string>,
  ): Promise<Account | { why: string }> {
    if (thread) {
      const bound = await this.d.accounts.find(service, thread.accountId)
      if (bound) return bound
      console.warn(
        `[core:chat] ${service} thread's account ${thread.accountId.slice(0, 8)} is not listed`,
      )
    }
    return this.d.accounts.pick(service, avoid)
  }

  private bindAccount(e: Entry, service: Service, account: Account): void {
    if (service !== 'claude') return
    e.chat.account = { id: account.id, label: account.label, configDir: account.home }
    this.save(e)
  }

  /** The first turn on a service that did not run the chat's latest turns reads what was said since it last ran. */
  private leadFor(e: Entry, service: Service, sentId: string): string | null {
    const left = e.chat.serviceLeftAt?.[service]
    const since = left ?? (this.boundThread(e, service) ? undefined : 0)
    if (since === undefined) return null
    if (left !== undefined) {
      const rest = { ...e.chat.serviceLeftAt }
      delete rest[service]
      e.chat.serviceLeftAt = rest
    }
    const from = LABEL[e.chat.serviceRanOn ?? 'claude']
    const text = this.handoff(e, since, sentId, {
      why: PINNED,
      services: { from, to: LABEL[service] },
    })
    if (text) this.line(e, 'info', `Caught up on what was said on ${from}.`)
    return text
  }

  /** The condensed record of what was said since `since`, or null when there is no assistant reply in it. */
  private handoff(
    e: Entry,
    since: number,
    sentId: string,
    how: { why: string; services?: { from: string; to: string } },
  ): string | null {
    const items = this.d.store
      .items(e.chat.id)
      .filter((i) => i.ts >= since && i.id !== sentId && !(i.kind === 'user' && i.queued))
    if (!items.some((i) => i.kind === 'assistant_text')) return null
    return buildHandoff({
      chatId: e.chat.id,
      title: e.chat.title,
      cwd: e.chat.cwd,
      items,
      sessions: e.chat.sessionId ? [e.chat.sessionId] : [],
      tokens: null,
      deskUrl: SELF,
      ...how,
    })
  }
}

/** A new chat's summary: Desk's defaults (desk2/server/src/settings.ts), the account picked when its first turn runs. */
function fresh(p: Pick<ChatSummary, 'title' | 'cwd'>): ChatSummary {
  const now = Date.now()
  return {
    id: randomUUID(),
    sessionId: null,
    account: { id: 'auto', label: 'Auto', configDir: null },
    accountAuto: true,
    model: null,
    effort: null,
    permissionMode: 'bypassPermissions',
    delegateToCliMayte: true,
    status: 'idle',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    costUsd: 0,
    contextPct: null,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0,
    ...p,
  }
}

/** An absolute path to an existing folder (Desk's checkCwd, chat-manager.ts). */
function checkCwd(cwd: unknown): string {
  if (typeof cwd !== 'string' || !isAbsolute(cwd))
    throw new ChatError(400, 'cwd must be an absolute path')
  const full = resolve(cwd)
  if (!statSync(full, { throwIfNoEntry: false })?.isDirectory())
    throw new ChatError(400, `the folder ${full} does not exist`)
  return full
}

function images(v: unknown): Image[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new ChatError(400, 'images must be a list')
  return v.map((raw) => {
    const i = obj(raw)
    if (typeof i.mediaType !== 'string' || typeof i.dataBase64 !== 'string')
      throw new ChatError(400, 'an image needs mediaType and dataBase64')
    return {
      mediaType: i.mediaType,
      dataBase64: i.dataBase64,
      ...(typeof i.name === 'string' ? { name: i.name } : {}),
    }
  })
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
