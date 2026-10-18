// What every chat pinned to another service shares (Pin service): it keeps its record as a Claude chat does (the
// store, the same transcript items, the same status machine), so the window draws it the same way; a message sent
// while a turn runs waits as the next turn; an idle chat closes after the idle minutes. Each service's runtime
// (codex/runtime.ts, chatgpt/runtime.ts) runs the turns.

import { randomUUID } from 'node:crypto'
import type { ChatSummary, DeskSettings, ImageRef, PermissionDecision, PinnedService, QuestionAnswer, ServerEvent, TranscriptItem } from '@shared/protocol'
import { mediaCache, toStoredImage } from '../media/cache'
import { nextStatus, type StatusEvent } from './status'
import type { ChatStore } from './store'
import { userTurns } from './system-text'

export interface ServiceRuntimeDeps {
  chat: ChatSummary
  store: ChatStore
  emit(event: ServerEvent): void
  settings: () => DeskSettings
  now?: () => number
  onClosed?(): void
  onFailure?(f: { message: string; durationMs: number | null }): void
  /** A turn ended answered: what ran it and what it ended with, for the pushback count. */
  onTurnClassified?(t: { model: string; effort: string; stopReason: string | null; text: string }): void
}

type UserItem = Extract<TranscriptItem, { kind: 'user' }>
/** A message the chat sends: its id is its user item's. */
export type Sent = { id: string; text: string; images?: ImageRef[] }

export abstract class ServiceRuntime {
  abstract readonly kind: PinnedService
  readonly chat: ChatSummary
  protected readonly now: () => number
  /** The send the running turn answers; null when no turn runs. */
  protected current: Sent | null = null
  protected turnStarted = 0
  /** Sends that came while a turn ran, oldest first: each is the next turn. */
  protected queue: Sent[] = []
  private readonly queued = new Map<string, UserItem>()
  private readonly storedRunning = new Set<string>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(protected readonly base: ServiceRuntimeDeps) {
    this.chat = base.chat
    this.now = base.now ?? Date.now
  }

  /** The chat has run here since it last closed. */
  abstract get alive(): boolean
  /** Runs `sent` as the chat's turn. */
  protected abstract run(sent: Sent): Promise<void>
  /** Stops the running turn; the chat reads stopped at once. Queued sends go on after it. */
  abstract interrupt(): void
  /** Ends the runtime: a turn under way stops, the chat reads closed. The service's thread stays the chat's. */
  abstract close(): Promise<void>
  /** Desk is stopping: a turn under way stops with it, and the chat says so. */
  abstract shutdown(): Promise<void>

  /** A turn runs. */
  get busy(): boolean {
    return this.current !== null
  }

  isPending(_requestId: string): boolean {
    return false
  }

  respondPermission(requestId: string, _d: PermissionDecision): void {
    throw new Error(`no pending permission request ${requestId}`)
  }

  answerQuestion(requestId: string, _a: QuestionAnswer): void {
    throw new Error(`no pending question request ${requestId}`)
  }

  /** No service makes plan or MCP form requests of a Desk chat, so none can be open. */
  respondPlan(requestId: string): void {
    throw new Error(`no pending plan request ${requestId}`)
  }

  answerElicitation(requestId: string): void {
    throw new Error(`no pending elicitation request ${requestId}`)
  }

  /** Sends a message: the next turn now, or queued behind the running one. */
  send(text: string, images?: ImageRef[], messageId?: string, shown?: string): { queued: boolean } {
    this.clearIdle()
    const sent: Sent = { id: messageId ?? randomUUID(), text, ...(images?.length ? { images } : {}) }
    const busy = this.current !== null
    this.dispatch({ type: 'userSent', now: this.now() })
    const item: UserItem = { kind: 'user', id: sent.id, ts: this.now(), text: shown ?? text }
    if (images?.length) item.images = images.map((i) => toStoredImage(i))
    if (busy) {
      item.queued = true
      this.queued.set(item.id, item)
      this.queue.push(sent)
      this.chat.queuedCount = this.queue.length
    }
    this.upsert(item)
    this.publish()
    if (!busy) void this.run(sent)
    return { queued: busy }
  }

  async cancelQueued(itemId: string): Promise<boolean> {
    if (!this.queued.has(itemId)) return false
    this.queued.delete(itemId)
    this.queue = this.queue.filter((s) => s.id !== itemId)
    this.chat.queuedCount = this.queue.length
    return true
  }

  markViewed(): void {
    this.dispatch({ type: 'viewed' })
    this.publish()
  }

  /** After a turn: the next queued send starts as the next turn; false when none waits. */
  protected startNext(): boolean {
    const next = this.queue.shift()
    if (!next) return false
    this.unqueue(next.id)
    this.dispatch({ type: 'userSent', now: this.now() })
    this.chat.queuedCount = this.queue.length
    this.publish()
    void this.run(next)
    return true
  }

  protected upsert(item: TranscriptItem): void {
    for (const shown of item.kind === 'user' ? userTurns(item, mediaCache(this.base.store.home)) : [item]) this.base.emit({ type: 'item.upsert', chatId: this.chat.id, item: shown })
    if ((item.kind === 'assistant_text' || item.kind === 'thinking') && item.streaming) return
    if (item.kind === 'tool_use' && item.status === 'running') {
      if (this.storedRunning.has(item.id)) return
      this.storedRunning.add(item.id)
    }
    this.base.store.appendItem(this.chat.id, item)
  }

  protected line(level: 'info' | 'warn', text: string): void {
    const ts = this.now()
    this.upsert({ kind: 'system', id: `${this.kind}:${ts}:${randomUUID().slice(0, 8)}`, ts, level, text })
  }

  protected unqueue(id: string): void {
    const item = this.queued.get(id)
    if (!item) return
    this.queued.delete(id)
    const { queued: _q, ...rest } = item
    this.upsert(rest)
  }

  protected unqueueAll(): void {
    for (const id of [...this.queued.keys()]) this.unqueue(id)
    this.queue = []
    this.chat.queuedCount = 0
  }

  protected dispatch(e: StatusEvent): void {
    Object.assign(this.chat, nextStatus(this.chat, e))
    this.chat.updatedAt = this.now()
  }

  protected publish(): void {
    this.base.emit({ type: 'chat.upsert', chat: { ...this.chat } })
  }

  protected notify(reason: Extract<ServerEvent, { type: 'notify' }>['reason'], body: string): void {
    this.base.emit({ type: 'notify', chatId: this.chat.id, reason, title: this.chat.title, body })
  }

  protected armIdle(): void {
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.current) void this.close()
    }, this.base.settings().idleCloseMinutes * 60_000)
    ;(this.idleTimer as { unref?: () => void }).unref?.()
  }

  protected clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
