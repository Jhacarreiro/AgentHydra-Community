// A Desk chat pinned to ChatGPT (Pin service): each message is a message of a ChatGPT chat on one of the owner's Free
// ChatGPT accounts, sent through Desk's Free instances (free-instances/service.ts), which run it as a job: started,
// then read until it is done. The ChatGPT chat is the chat's `serviceThreads.chatgpt`; a new one (the chat's first
// ChatGPT message, or its account signed out, gone or at its limit) starts from a condensed handoff of the chat so
// far (the manager's `handoff`), so ChatGPT knows what was said before. ChatGPT here runs no tools: it answers in words.

import { randomUUID } from 'node:crypto'
import type { ServiceThread } from '@shared/protocol'
import { type FreeInstance, type FreeJob, type FreeResult, isFreeChatgptModel } from '@shared/free-instances'
import { ANSWER_NOW } from '../handoff'
import { type Sent, ServiceRuntime, type ServiceRuntimeDeps } from '../service-runtime'

/** What the runtime uses of Free instances (FreeInstances has these). */
export interface FreeChats {
  allInstances(): readonly FreeInstance[]
  start(request: unknown): FreeJob
  get(id: string): FreeJob
  cancel(id: string): void
  /** An account runs one message at a time: true while another one runs there. */
  occupied(instanceId: string): boolean
}

export interface ChatgptRuntimeDeps extends ServiceRuntimeDeps {
  free: FreeChats
  /** As CodexRuntimeDeps.handoff: what the message `sentId` starts with, null for nothing. */
  handoff(fresh: boolean, sentId: string, movedFrom?: string): { text: string; from: string } | null
  caughtUp(): void
  /** Accounts that hit their limit, kept out of picks until when (epoch ms); the manager's, shared by its chats. */
  held: Map<string, number>
}

/** A Free ChatGPT account as the window names it. */
export const chatgptLabel = (i: Pick<FreeInstance, 'num' | 'name'>): string => `#${i.num}${i.name ? ` ${i.name}` : ''}`

/**
 * The account a new ChatGPT chat starts on: a signed-in Free ChatGPT account this message has not hit a limit on and
 * not held after one; of those, one running no other message first, then one with unlimited text, then the one used
 * longest ago.
 */
export function pickChatgptAccount(
  all: readonly FreeInstance[],
  avoid: ReadonlySet<string>,
  held: ReadonlyMap<string, number>,
  now: number,
  occupied: (id: string) => boolean,
): FreeInstance | { why: string; limited: boolean } {
  const signedIn = all.filter((i) => i.provider === 'chatgpt' && i.loggedIn)
  if (!signedIn.length) return { why: 'No ChatGPT account is signed in. Sign one in on the Free page.', limited: false }
  const open = signedIn.filter((i) => !avoid.has(i.id) && (held.get(i.id) ?? 0) <= now)
  if (!open.length) return { why: 'Every ChatGPT account is at its limit. Wait for one to reset, then send again.', limited: true }
  open.sort((a, b) => Number(occupied(a.id)) - Number(occupied(b.id)) || Number(b.usage?.unlimited_text === true) - Number(a.usage?.unlimited_text === true) || (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0))
  return open[0]!
}

/** How often a running message is read: a look in Free instances' own list, in this process. */
const POLL_MS = 250
/** How long an account that hit its limit is left out of picks. */
const LIMIT_HOLD_MS = 60 * 60_000
/** The longest message Free instances take. */
const PROMPT_MAX = 100_000
/** A ChatGPT chat's name: 1 to 100 printable characters, and unique on its account, since the Free runtime refuses a
 *  name one of its chats already has (name_conflict; 2026-10-14, two chats with one title on one account): the title,
 *  then the start of the Desk chat's id. */
const chatName = (title: string, id: string): string => `${title.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 91) || 'Desk chat'} ${id.slice(0, 8)}`
/** The answers that say the ChatGPT chat is not there any more. */
const GONE = new Set(['unknown_chat', 'not_found', 'invalid_chat_id'])

export class ChatgptRuntime extends ServiceRuntime {
  readonly kind = 'chatgpt' as const
  private readonly deps: ChatgptRuntimeDeps
  /** The job the running message is. */
  private job: string | null = null
  /** Accounts the message in flight hit a limit on; cleared when a turn ends. */
  private readonly avoid = new Set<string>()
  /** The bound chat answered that it is gone: the message goes on in a new one. */
  private gone = false
  private movedFrom: string | null = null

  constructor(deps: ChatgptRuntimeDeps) {
    super(deps)
    this.deps = deps
  }

  override get alive(): boolean {
    return this.current !== null
  }

  override interrupt(): void {
    const sent = this.current
    if (!sent) return
    this.cancelJob()
    this.endTurn(sent, { ok: false, interrupted: true, durationMs: this.now() - this.turnStarted })
  }

  /** Ends the runtime: the message under way stops, and nothing queued starts after it (as interrupt's turn end would). */
  override async close(): Promise<void> {
    this.clearIdle()
    this.cancelJob()
    this.current = null
    this.job = null
    this.avoid.clear()
    this.unqueueAll()
    this.dispatch({ type: 'closed' })
    this.publish()
    this.base.onClosed?.()
  }

  override async shutdown(): Promise<void> {
    if (this.current) this.line('warn', 'AgentHydra restarted while ChatGPT was answering, so the message stopped. Send it again to go on.')
    await this.close()
  }

  protected override async run(sent: Sent): Promise<void> {
    this.current = sent
    this.turnStarted = this.now()
    this.dispatch({ type: 'activity', activity: 'Asking ChatGPT' })
    this.publish()
    try {
      const all = this.deps.free.allInstances()
      const bound = this.gone ? undefined : this.chat.serviceThreads?.chatgpt
      const holder = bound && !this.avoid.has(bound.accountId) ? all.find((i) => i.id === bound.accountId && i.provider === 'chatgpt' && i.loggedIn) : undefined
      const picked = holder ?? pickChatgptAccount(all, this.avoid, this.deps.held, this.now(), this.occupied)
      if ('why' in picked) {
        if (picked.limited) return this.allLimited(picked.why)
        throw new Error(picked.why)
      }
      const account = await this.whenFree(picked, !!holder, sent)
      if (!account) return
      const fresh = !holder
      const lead = this.deps.handoff(fresh, sent.id, fresh ? (this.movedFrom ?? undefined) : undefined)
      const prompt = lead ? fit(lead.text, sent.text) : sent.text
      if (prompt.length > PROMPT_MAX) throw new Error(`ChatGPT takes messages of up to ${PROMPT_MAX.toLocaleString()} characters.`)
      if (sent.images?.length) this.line('info', 'ChatGPT here reads text only, so the pictures were not sent.')
      const model = this.chat.model && isFreeChatgptModel(this.chat.model) ? this.chat.model : null
      const job = this.deps.free.start({
        requestId: randomUUID(),
        instanceId: account.id,
        provider: 'chatgpt',
        prompt,
        ...(fresh ? { command: 'chat', name: chatName(this.chat.title, this.chat.id) } : { command: 'resume', chatId: bound!.threadId }),
        ...(model ? { model } : {}),
      })
      this.job = job.id
      this.dispatch({ type: 'stateChanged', state: 'running', now: this.now() })
      this.dispatch({ type: 'activity', activity: 'Waiting for ChatGPT' })
      this.publish()
      const result = await this.wait(job.id, sent)
      if (this.current !== sent || !result) return
      if (result.ok && result.chat_id) {
        this.bind({ accountId: account.id, label: chatgptLabel(account), threadId: result.chat_id })
        this.movedFrom = null
        this.gone = false
        if (lead) {
          this.deps.caughtUp()
          this.line('info', `Caught up on what was said on ${lead.from}.`)
        }
        return this.answered(sent, job.id, result)
      }
      const code = result.error?.code ?? ''
      if (code === 'rate_limited') return this.limited(sent, account)
      if (!fresh && GONE.has(code)) {
        // Gone from that account: the chat goes on in a new ChatGPT chat, which first reads what was said.
        this.gone = true
        this.movedFrom = `an earlier ChatGPT chat (${chatgptLabel(account)})`
        return void this.run(sent)
      }
      const why = code === 'login_required' ? `${chatgptLabel(account)} is signed out of ChatGPT. Sign it in again on the Free page, then send again.` : result.error?.message || 'ChatGPT could not answer.'
      this.endTurn(sent, { ok: false, error: why, durationMs: this.now() - this.turnStarted })
    } catch (err) {
      if (this.current !== sent) return
      this.endTurn(sent, { ok: false, error: err instanceof Error ? err.message : String(err), durationMs: this.now() - this.turnStarted })
    }
  }

  private readonly occupied = (id: string): boolean => this.deps.free.occupied(id)

  /**
   * An account runs one message at a time, and Free instances refuse a second (live, 2026-10-14: two chats picked the
   * same account and the second failed, "This account already has an operation running."). A message for a busy
   * account waits for it: a new ChatGPT chat takes whichever account frees first, a chat's own waits for that one.
   * Null when the message stopped meanwhile.
   */
  private async whenFree(account: FreeInstance, bound: boolean, sent: Sent): Promise<FreeInstance | null> {
    if (!this.occupied(account.id)) return account
    this.dispatch({ type: 'activity', activity: `Waiting for ${chatgptLabel(account)} to finish another message` })
    this.publish()
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      if (this.current !== sent) return null
      if (!bound) {
        const next = pickChatgptAccount(this.deps.free.allInstances(), this.avoid, this.deps.held, this.now(), this.occupied)
        if (!('why' in next)) account = next
      }
      if (!this.occupied(account.id)) return account
    }
  }

  /** Stops the running message's job; the turn's end (or close) lets go of its id. */
  private cancelJob(): void {
    if (!this.job) return
    try {
      this.deps.free.cancel(this.job)
    } catch {
      // Already over.
    }
  }

  /** The job's result once it is done; null when the message stopped first. */
  private async wait(id: string, sent: Sent): Promise<FreeResult | null> {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      if (this.current !== sent) return null
      const job = this.deps.free.get(id)
      if (job.state === 'done') return job.result ?? { ok: false, error: { code: 'no_result', message: 'ChatGPT gave no answer.' } }
    }
  }

  private bind(thread: ServiceThread): void {
    this.chat.serviceThreads = { ...this.chat.serviceThreads, chatgpt: thread }
    this.publish()
  }

  private answered(sent: Sent, jobId: string, result: FreeResult): void {
    const text = (result.response ?? result.messages?.filter((m) => m.role === 'assistant').at(-1)?.text ?? '').trim()
    if (text) this.upsert({ kind: 'assistant_text', id: `chatgpt:${jobId}`, ts: this.now(), text })
    if (result.incomplete) this.line('warn', 'ChatGPT stopped before the end of its answer.')
    this.endTurn(sent, { ok: true, durationMs: this.now() - this.turnStarted, text })
  }

  /** The account hit its limit: it is held out, and the same message goes on in a new chat on another account. */
  private limited(sent: Sent, account: FreeInstance): void {
    this.deps.held.set(account.id, this.now() + LIMIT_HOLD_MS)
    this.avoid.add(account.id)
    this.gone = true
    this.movedFrom = `another ChatGPT account (${chatgptLabel(account)})`
    this.line('warn', `${chatgptLabel(account)} hit its ChatGPT limit, so this chat goes on on another ChatGPT account.`)
    void this.run(sent)
  }

  /** No ChatGPT account can take the message: the chat waits, limited; the message is in its record to send again. */
  private allLimited(why: string): void {
    this.line('warn', why)
    this.current = null
    this.job = null
    this.avoid.clear()
    this.unqueueAll()
    this.dispatch({ type: 'usageLimit', resetsAt: null })
    this.notify('limited', why)
    this.publish()
  }

  private endTurn(sent: Sent, end: { ok: boolean; durationMs: number; error?: string; interrupted?: boolean; text?: string }): void {
    if (this.current !== sent) return
    const now = this.now()
    const error = end.ok ? undefined : end.interrupted ? 'Interrupted' : end.error || 'ChatGPT could not answer.'
    this.upsert({ kind: 'result', id: `result:${this.job ?? `chatgpt-${now}`}`, ts: now, ok: end.ok, durationMs: end.durationMs, costUsd: 0, turns: 1, ...(error ? { error } : {}) })
    this.current = null
    this.job = null
    this.avoid.clear()
    if (end.interrupted) this.dispatch({ type: 'interrupted' })
    else if (!end.ok) {
      this.dispatch({ type: 'turnError', message: error! })
      this.base.onFailure?.({ message: error!, durationMs: end.durationMs })
      this.notify('error', error!)
    } else this.dispatch({ type: 'stateChanged', state: 'idle', now })
    if (end.ok) this.deps.onTurnClassified?.({ model: this.chat.model || 'default', effort: 'default', stopReason: null, text: end.text ?? '' })
    if (this.startNext()) return
    if (end.ok) this.notify('finished', end.text?.slice(0, 200) || 'ChatGPT answered.')
    this.publish()
    this.armIdle()
  }
}

/** The handoff and the message as one, the handoff cut from its start when the two are longer than ChatGPT takes. */
function fit(lead: string, text: string): string {
  const tail = `${ANSWER_NOW}${text}`
  const room = PROMPT_MAX - tail.length
  return `${room < lead.length ? lead.slice(lead.length - Math.max(0, room)) : lead}${tail}`
}
