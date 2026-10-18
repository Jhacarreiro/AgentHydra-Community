// A Desk chat pinned to Codex (Pin service): each of its turns is a turn of a Codex thread on one of the owner's
// Codex accounts, run through that account's app-server (app-server.ts). The chat keeps its own record as a Claude
// chat does (service-runtime.ts), so the window draws it the same way.
// The thread is the chat's `serviceThreads.codex`: a later turn, a restart of Desk or a pin back here goes on in
// it. A new thread (the chat's first Codex turn, or its account gone or at its limit) starts from a condensed
// handoff of the chat so far (the manager's `handoff`), so Codex knows what was said on Claude.

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ImageRef, PermissionDecision, PermissionMode, QuestionAnswer, ServiceThread, TranscriptItem } from '@shared/protocol'
import { mediaCache } from '../../media/cache'
import { ANSWER_NOW } from '../handoff'
import { type Sent, ServiceRuntime, type ServiceRuntimeDeps } from '../service-runtime'
import type { CodexAccount, CodexPick } from './accounts'
import { type AppServer, type OpenAppServer, openAppServer, type ThreadListener } from './app-server'
import { activityOf, type CodexItem, codexItems, planTodos, shownCommand } from './items'

export interface CodexRuntimeDeps extends ServiceRuntimeDeps {
  /** Default: the shared app-server per Codex home; tests give a fake one. */
  open?: OpenAppServer
  /** The account a new thread starts on; `avoid`: accounts this message already hit a limit on. */
  pickAccount(avoid: ReadonlySet<string>): Promise<CodexPick>
  /** The account the chat's thread is on, as AgentHydra lists it now; null when it is gone or signed out. */
  findAccount(id: string): Promise<CodexAccount | null>
  /**
   * What the message `sentId` starts with: a condensed handoff of what was said since the chat was last on Codex
   * (`fresh`: a new thread, the whole chat before it) and what ran it meanwhile ("Claude", or `movedFrom` after a
   * usage limit moved it off another Codex account); null for nothing.
   */
  handoff(fresh: boolean, sentId: string, movedFrom?: string): { text: string; from: string } | null
  /** The handoff went out with a turn: the thread has caught up. */
  caughtUp(): void
  /** The account hit its usage limit: kept out of picks until `until` (epoch ms). */
  hold(accountId: string, until: number): void
}

type PermissionItem = Extract<TranscriptItem, { kind: 'permission' }>
type QuestionItem = Extract<TranscriptItem, { kind: 'question' }>
type Streamed = { kind: 'assistant_text' | 'thinking'; text: string; ts: number }
type Ask =
  | { item: PermissionItem; resolve(result: unknown): void }
  | { item: QuestionItem; ids: string[]; resolve(result: unknown): void }
type CodexTurn = { id: string; status: string; error?: { message?: string; codexErrorInfo?: unknown } | null; durationMs?: number | null }

/** How long a Stop waits for Codex's own end of the turn before the chat ends it. */
const STOP_GRACE_MS = 5_000
/** How often a running command's output line is sent to the window. */
const PROGRESS_EVERY_MS = 400
/** How long an account that hit its usage limit is left out of picks when Codex does not say. */
const LIMIT_HOLD_MS = 60 * 60_000

/** Codex's approval and sandbox for Desk's permission mode. */
export function policy(mode: PermissionMode): { approvalPolicy: string; sandbox: string; sandboxPolicy: Record<string, unknown> } {
  if (mode === 'bypassPermissions') return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
  if (mode === 'plan') return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: true } }
  return {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  }
}

/** A chat model only Codex knows (a Claude id stays with Claude). */
export const codexModel = (model: string | null): string | null => (model && /^(?:gpt-|o\d|codex)/i.test(model) ? model : null)

export const isLimit = (info: unknown): boolean => info === 'usageLimitExceeded' || info === 'sessionBudgetExceeded'

export class CodexRuntime extends ServiceRuntime {
  readonly kind = 'codex' as const
  private readonly deps: CodexRuntimeDeps
  private readonly open: OpenAppServer
  private server: AppServer | null = null
  private home: string | null = null
  private unlisten: (() => void) | null = null
  /** The thread loaded on `server`. */
  private thread: ServiceThread | null = null
  private turnId: string | null = null
  /** The turn's thread still loading (its app-server opening, its resume or start in flight), which a close waits for. */
  private starting: Promise<boolean> | null = null
  /** Accounts the message in flight hit a limit on; cleared when a turn ends. */
  private readonly avoid = new Set<string>()
  private readonly streams = new Map<string, Streamed>()
  /** Items under way: their start time, and the item (a file change's approval names its files). */
  private readonly running = new Map<string, { item: CodexItem; startedAt: number; output: string; sentAt: number }>()
  private readonly asks = new Map<string, Ask>()
  private lastText = ''
  /** The account a usage limit just moved the chat off: the new thread's handoff names it. */
  private movedFrom: string | null = null

  constructor(deps: CodexRuntimeDeps) {
    super(deps)
    this.deps = deps
    this.open = deps.open ?? openAppServer
  }

  /** An app-server is held: the chat has run here since it last closed. */
  override get alive(): boolean {
    return this.server !== null || this.current !== null
  }

  override isPending(requestId: string): boolean {
    return this.asks.has(requestId)
  }

  override interrupt(): void {
    const sent = this.current
    if (!sent) return
    if (this.server && this.thread && this.turnId) void this.server.call('turn/interrupt', { threadId: this.thread.threadId, turnId: this.turnId }).catch(() => {})
    this.expireAsks()
    this.dispatch({ type: 'interrupted' })
    this.publish()
    // Codex ends the turn as interrupted; one that never says so is ended here.
    const timer = setTimeout(() => {
      if (this.current === sent) this.endTurn(sent, { id: this.turnId ?? `stop-${this.now()}`, status: 'interrupted' })
    }, STOP_GRACE_MS)
    ;(timer as { unref?: () => void }).unref?.()
    if (!this.turnId) this.endTurn(sent, { id: `stop-${this.now()}`, status: 'interrupted' })
  }

  override respondPermission(requestId: string, d: PermissionDecision): void {
    const ask = this.asks.get(requestId)
    if (!ask || ask.item.kind !== 'permission') throw new Error(`no pending permission request ${requestId}`)
    this.asks.delete(requestId)
    const state = d.decision === 'allow' ? 'allowed' : d.decision === 'deny' ? 'denied' : d.decision
    this.upsert({ ...ask.item, state })
    this.dispatch({ type: 'requestClosed' })
    this.publish()
    ask.resolve({ decision: d.decision === 'allow' ? 'accept' : d.decision === 'deny' ? 'decline' : 'acceptForSession' })
  }

  override answerQuestion(requestId: string, a: QuestionAnswer): void {
    const ask = this.asks.get(requestId)
    if (!ask || ask.item.kind !== 'question' || !('ids' in ask)) throw new Error(`no pending question request ${requestId}`)
    this.asks.delete(requestId)
    const answers: Record<string, { answers: string[] }> = {}
    if (!a.skip)
      ask.item.questions.forEach((q, i) => {
        const said = a.answers?.[q.question]
        if (said) answers[ask.ids[i]!] = { answers: q.multiSelect ? said.split(',').map((s) => s.trim()).filter(Boolean) : [said] }
      })
    this.upsert({ ...ask.item, state: a.skip ? 'skipped' : 'answered', ...(a.answers ? { answers: a.answers } : {}) })
    this.dispatch({ type: 'requestClosed' })
    this.publish()
    ask.resolve({ answers })
  }

  /** Ends the runtime: the turn stops, the app-server is let go, the chat reads closed. The thread stays the chat's. */
  override async close(): Promise<void> {
    this.clearIdle()
    if (this.current && this.server && this.thread && this.turnId) void this.server.call('turn/interrupt', { threadId: this.thread.threadId, turnId: this.turnId }).catch(() => {})
    this.current = null
    this.turnId = null
    this.expireAsks()
    this.unqueueAll()
    // Closed while the thread still loads, the app-server and thread it lands on would be held by no one (2026-10-14:
    // a chat deleted as its app-server started kept that thread's writer for good), so they are let go once it lands.
    // Only then is there a wait: a close with nothing loading says closed at once, before what the chat runs next.
    if (this.starting) await this.starting.catch(() => {})
    this.detach()
    this.dispatch({ type: 'closed' })
    this.publish()
    this.deps.onClosed?.()
  }

  /** Desk is stopping: a turn under way stops with it, and the chat says so. */
  override async shutdown(): Promise<void> {
    if (this.current) this.line('warn', 'AgentHydra restarted while Codex was working, so the turn stopped. Send a message to go on.')
    await this.close()
  }

  // The turn

  protected override async run(sent: Sent): Promise<void> {
    this.current = sent
    this.turnId = null
    this.turnStarted = this.now()
    this.lastText = ''
    this.dispatch({ type: 'activity', activity: 'Starting Codex' })
    this.publish()
    try {
      const starting = this.ensureThread()
      this.starting = starting
      const fresh = await starting.finally(() => {
        if (this.starting === starting) this.starting = null
      })
      if (this.current !== sent) return
      const lead = this.deps.handoff(fresh, sent.id, fresh ? (this.movedFrom ?? undefined) : undefined)
      this.movedFrom = null
      const text = lead ? `${lead.text}${ANSWER_NOW}${sent.text}` : sent.text
      const input: Record<string, unknown>[] = [{ type: 'text', text, text_elements: [] }, ...this.pictures(sent.images)]
      const { approvalPolicy, sandboxPolicy } = policy(this.chat.permissionMode)
      const effort = this.chat.effort === 'max' ? 'xhigh' : this.chat.effort
      const model = codexModel(this.chat.model)
      const started = await this.server!.call<{ turn: { id: string } }>('turn/start', {
        threadId: this.thread!.threadId,
        input,
        approvalPolicy,
        sandboxPolicy,
        ...(effort ? { effort } : {}),
        ...(model ? { model } : {}),
      })
      if (lead) {
        this.deps.caughtUp()
        this.line('info', `Caught up on what was said on ${lead.from}.`)
      }
      if (this.current !== sent) {
        // Stopped while Codex took the turn: it stops there too.
        void this.server?.call('turn/interrupt', { threadId: this.thread?.threadId, turnId: started.turn.id }).catch(() => {})
        return
      }
      this.turnId ??= started.turn.id
      this.dispatch({ type: 'stateChanged', state: 'running', now: this.now() })
      this.dispatch({ type: 'activity', activity: 'Thinking' })
      this.publish()
    } catch (err) {
      if (this.current !== sent) return
      const message = err instanceof Error ? err.message : String(err)
      if (this.avoid.size && /usage limit/.test(message)) return this.allLimited(message)
      this.endTurn(sent, { id: `failed-${this.now()}`, status: 'failed', error: { message } })
    }
  }

  /** The chat's thread loaded on its account's app-server; true when it is a new thread. */
  private async ensureThread(): Promise<boolean> {
    if (this.server && this.thread && !this.avoid.has(this.thread.accountId)) return false
    const { approvalPolicy, sandbox } = policy(this.chat.permissionMode)
    const model = codexModel(this.chat.model)
    const settings = { cwd: this.chat.cwd, approvalPolicy, sandbox, ...(model ? { model } : {}) }
    const bound = this.chat.serviceThreads?.codex
    if (bound && !this.avoid.has(bound.accountId)) {
      const account = await this.deps.findAccount(bound.accountId)
      if (account) {
        await this.attach(account)
        try {
          await this.server!.call('thread/resume', { threadId: bound.threadId, ...settings, excludeTurns: true })
          this.bind({ ...bound, label: account.label })
          return false
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // Open in that account's Codex app, which alone may write it while it holds it: the chat waits for it.
          if (/active writer/i.test(message)) throw new Error(`The Codex app on ${account.label} has this chat open, so only it can write to it now. Close the chat there, then send again.`)
          // Gone from that account (archived there, deleted): the chat goes on in a new thread. Anything else is said.
          if (!/not found|no rollout|unknown thread|does not exist/i.test(message)) throw err
        }
      }
    }
    const pick = await this.deps.pickAccount(this.avoid)
    if ('why' in pick) throw new Error(pick.why)
    await this.attach(pick.account)
    const r = await this.server!.call<{ thread: { id: string } }>('thread/start', settings)
    this.bind({ accountId: pick.account.id, label: pick.account.label, threadId: r.thread.id })
    void this.server!.call('thread/name/set', { threadId: r.thread.id, name: this.chat.title }).catch(() => {})
    return true
  }

  private async attach(account: CodexAccount): Promise<void> {
    if (this.server && this.home === account.home) return
    this.detach()
    this.server = await this.open(account.home)
    this.home = account.home
  }

  private bind(thread: ServiceThread): void {
    this.unlisten?.()
    this.unlisten = this.server!.listen(thread.threadId, this.listener)
    this.thread = thread
    this.chat.serviceThreads = { ...this.chat.serviceThreads, codex: thread }
    this.publish()
  }

  private detach(): void {
    // Unsubscribed, the thread is unloaded about a minute later even while other chats keep this app-server up
    // (measured 2026-10-14: still loaded 55 s after thread/unsubscribe, gone at 60 s, and another program's archive
    // went through); with no other chat on it, the release below ends the app-server, which frees it at once.
    const threadId = this.thread?.threadId
    if (threadId) void this.server?.call('thread/unsubscribe', { threadId }).catch(() => {})
    this.unlisten?.()
    this.unlisten = null
    this.server?.release()
    this.server = null
    this.home = null
    this.thread = null
  }

  private readonly listener: ThreadListener = {
    notify: (method, params) => this.onNotify(method, params),
    request: (method, params) => this.onRequest(method, params),
    exited: (why) => {
      this.unlisten = null
      this.server = null
      this.home = null
      this.thread = null
      if (this.current) this.endTurn(this.current, { id: `exit-${this.now()}`, status: 'failed', error: { message: `Codex stopped while it was working (${why})` } })
    },
  }

  private onNotify(method: string, p: Record<string, unknown>): void {
    if (!this.current) return
    const now = this.now()
    switch (method) {
      case 'turn/started':
        this.turnId = (p.turn as { id: string }).id
        return
      case 'item/started': {
        const item = p.item as CodexItem
        const startedAt = typeof p.startedAtMs === 'number' ? p.startedAtMs : now
        this.running.set(item.id, { item, startedAt, output: '', sentAt: 0 })
        if (item.type !== 'agentMessage' && item.type !== 'reasoning') for (const i of codexItems(item, { now, startedAt })) this.upsert(i)
        const activity = activityOf(item)
        if (activity) this.dispatch({ type: 'activity', activity })
        this.publish()
        return
      }
      case 'item/agentMessage/delta':
        return this.stream(String(p.itemId), 'assistant_text', String(p.delta ?? ''))
      case 'item/reasoning/summaryTextDelta':
        return this.stream(String(p.itemId), 'thinking', String(p.delta ?? ''))
      case 'item/commandExecution/outputDelta':
        return this.progress(String(p.itemId), String(p.delta ?? ''))
      case 'item/completed': {
        const item = p.item as CodexItem
        const was = this.running.get(item.id)
        this.running.delete(item.id)
        const stream = this.streams.get(item.id)
        this.streams.delete(item.id)
        const startedAt = stream?.ts ?? was?.startedAt
        for (const i of codexItems(item, { now, startedAt, endedAt: typeof p.completedAtMs === 'number' ? p.completedAtMs : now })) this.upsert(i)
        // A message that ended with no text (only its deltas were seen) keeps what streamed.
        if (stream && !codexItems(item, { now }).length && stream.text.trim()) this.upsert({ kind: stream.kind, id: item.id, ts: stream.ts, text: stream.text })
        if (item.type === 'agentMessage' && item.text.trim()) this.lastText = item.text
        return
      }
      case 'turn/plan/updated':
        this.upsert({ kind: 'todos', id: 'todos', ts: now, todos: planTodos((p.plan as { step: string; status: string }[]) ?? []) })
        return
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage as { last?: { totalTokens?: number }; modelContextWindow?: number | null } | undefined
        const used = u?.last?.totalTokens
        if (typeof used === 'number' && u?.modelContextWindow) {
          this.chat.contextPct = Math.min(100, Math.round((used / u.modelContextWindow) * 100))
          this.publish()
        }
        return
      }
      case 'error': {
        const e = p.error as { message?: string } | undefined
        if (p.willRetry && e?.message) {
          this.dispatch({ type: 'activity', activity: `Codex is trying again: ${e.message.slice(0, 80)}` })
          this.publish()
        }
        return
      }
      case 'turn/completed':
        return this.endTurn(this.current, p.turn as CodexTurn)
    }
  }

  private stream(itemId: string, kind: Streamed['kind'], delta: string): void {
    if (!delta) return
    const s = this.streams.get(itemId)
    if (!s) {
      const ts = this.running.get(itemId)?.startedAt ?? this.now()
      this.streams.set(itemId, { kind, text: delta, ts })
      this.upsert({ kind, id: itemId, ts, text: delta, streaming: true })
      if (kind === 'assistant_text') this.dispatch({ type: 'activity', activity: 'Writing' })
      this.publish()
      return
    }
    s.text += delta
    this.deps.emit({ type: 'item.delta', chatId: this.chat.id, itemId, text: delta })
  }

  /** A running command's newest output line on its row, a few times a second at most. */
  private progress(itemId: string, delta: string): void {
    const r = this.running.get(itemId)
    if (!r) return
    r.output = (r.output + delta).slice(-4000)
    const now = this.now()
    if (now - r.sentAt < PROGRESS_EVERY_MS) return
    r.sentAt = now
    const line = r.output.trimEnd().split('\n').pop()?.slice(0, 200)
    for (const i of codexItems(r.item, { now, startedAt: r.startedAt })) if (i.kind === 'tool_use' && line) this.upsert({ ...i, progress: line })
  }

  /** A turn is over (done, stopped, failed): its result line, the chat's state, then the next queued send. */
  private endTurn(sent: Sent, turn: CodexTurn): void {
    if (this.current !== sent) return
    const now = this.now()
    for (const [id, s] of this.streams) this.upsert({ kind: s.kind, id, ts: s.ts, text: s.text })
    this.streams.clear()
    this.running.clear()
    this.expireAsks()
    const info = turn.error?.codexErrorInfo
    if (turn.status === 'failed' && isLimit(info)) return this.limited(sent)
    const ok = turn.status === 'completed'
    const durationMs = turn.durationMs ?? now - this.turnStarted
    const error = ok ? undefined : turn.status === 'interrupted' ? 'Interrupted' : turn.error?.message || 'Codex could not finish the turn.'
    this.upsert({ kind: 'result', id: `result:${turn.id}`, ts: now, ok, durationMs, costUsd: 0, turns: 1, ...(error ? { error } : {}) })
    this.current = null
    this.turnId = null
    this.avoid.clear()
    if (turn.status === 'interrupted') this.dispatch({ type: 'interrupted' })
    else if (!ok) {
      this.dispatch({ type: 'turnError', message: error! })
      this.deps.onFailure?.({ message: error!, durationMs })
      this.notify('error', error!)
    } else this.dispatch({ type: 'stateChanged', state: 'idle', now })
    if (ok) this.deps.onTurnClassified?.({ model: codexModel(this.chat.model) ?? 'default', effort: (this.chat.effort === 'max' ? 'xhigh' : this.chat.effort) ?? 'default', stopReason: null, text: this.lastText })
    if (this.startNext()) return
    if (ok) this.notify('finished', this.lastText.trim().slice(0, 200) || 'Codex finished.')
    this.letGo()
    this.publish()
    this.armIdle()
  }

  /**
   * Between turns the thread is let go: Codex lets one program write a thread at a time, so a thread Desk kept
   * loaded would lock its Codex app out of it (measured 2026-10-13: the app refused to archive a thread Desk held,
   * "already has an active writer"). The chat unsubscribes and releases its app-server (detach): the app-server ends
   * once no other chat holds it, freeing the thread at once; one other chats still use unloads it about a minute
   * after the unsubscribe. The next message resumes the thread.
   */
  private letGo(): void {
    this.detach()
  }

  /** The thread's account hit its usage limit: it is held out, and the same message goes on in a new thread on another account. */
  private limited(sent: Sent): void {
    const thread = this.thread
    if (thread) {
      this.deps.hold(thread.accountId, this.now() + LIMIT_HOLD_MS)
      this.avoid.add(thread.accountId)
      this.movedFrom = `another Codex account (${thread.label})`
      this.line('warn', `${thread.label} hit its Codex usage limit, so this chat goes on on another Codex account.`)
    }
    this.detach()
    void this.run(sent)
  }

  /** Every Codex account is at its limit: the chat waits, limited; the message is in its record to send again. */
  private allLimited(why: string): void {
    this.line('warn', why)
    this.current = null
    this.turnId = null
    this.avoid.clear()
    this.unqueueAll()
    this.queue = []
    this.dispatch({ type: 'usageLimit', resetsAt: null })
    this.notify('limited', why)
    this.publish()
  }

  // Requests Codex makes of the chat

  private async onRequest(method: string, p: Record<string, unknown>): Promise<unknown> {
    if (method === 'item/commandExecution/requestApproval') {
      const shown = shownCommand(typeof p.command === 'string' ? p.command : '')
      return this.ask(String(p.itemId ?? randomUUID()), shown.name, { command: shown.command }, typeof p.reason === 'string' ? p.reason : undefined)
    }
    if (method === 'item/fileChange/requestApproval') {
      const item = this.running.get(String(p.itemId))?.item
      const files = item?.type === 'fileChange' ? item.changes.map((c) => c.path) : []
      return this.ask(String(p.itemId ?? randomUUID()), 'Edit', { file_path: files.join(', ') }, typeof p.reason === 'string' ? p.reason : undefined)
    }
    if (method === 'item/tool/requestUserInput') {
      const qs = (p.questions as { id: string; header?: string; question: string; options?: { label: string; description?: string }[] | null }[]) ?? []
      const id = `codex-q:${String(p.itemId ?? randomUUID())}`
      const item: QuestionItem = {
        kind: 'question',
        id,
        ts: this.now(),
        questions: qs.map((q) => ({ question: q.question, header: q.header ?? '', multiSelect: false, options: q.options ?? [] })),
        state: 'pending',
      }
      return new Promise((resolve) => {
        this.asks.set(id, { item, ids: qs.map((q) => q.id), resolve })
        this.opened(item)
      })
    }
    // An MCP server's form: Desk shows none for Codex chats yet, so it is declined rather than left waiting.
    if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null }
    throw new Error('Desk does not answer this request.')
  }

  private ask(itemId: string, toolName: string, input: Record<string, unknown>, reason?: string): Promise<unknown> {
    const id = `codex-ask:${itemId}`
    const item: PermissionItem = {
      kind: 'permission',
      id,
      ts: this.now(),
      toolName,
      toolUseId: itemId,
      input,
      canAlwaysAllow: true,
      alwaysRules: ['This kind of request, for the rest of this Codex thread'],
      state: 'pending',
      ...(reason ? { reason } : {}),
    }
    return new Promise((resolve) => {
      this.asks.set(id, { item, resolve })
      this.opened(item)
    })
  }

  private opened(item: PermissionItem | QuestionItem): void {
    this.upsert(item)
    this.dispatch({ type: 'requestOpened' })
    this.publish()
    if (this.asks.size === 1) this.notify('needs_you', item.kind === 'question' ? 'Codex has a question.' : `Codex asks to use ${item.toolName}.`)
  }

  /** Every open request ends unanswered (the turn stopped or ended): Codex is told no. */
  private expireAsks(): void {
    for (const [id, ask] of this.asks) {
      this.asks.delete(id)
      this.upsert({ ...ask.item, state: 'expired' })
      this.dispatch({ type: 'requestClosed' })
      ask.resolve(ask.item.kind === 'question' ? { answers: {} } : { decision: 'decline' })
    }
  }

  // The chat's record

  /** Pictures go to Codex as files: the media cache holds each. */
  private pictures(images?: ImageRef[]): Record<string, unknown>[] {
    const cache = mediaCache(this.deps.store.home)
    if (!images?.length || !cache) return []
    return images.flatMap((img) => {
      const ref = img.dataBase64 ? cache.putBase64(img.dataBase64, img.name) : img
      const file = ref?.url?.split('/').pop()
      return file ? [{ type: 'localImage', path: join(cache.dir, file) }] : []
    })
  }
}
