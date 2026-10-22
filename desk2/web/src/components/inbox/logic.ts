// Waiting on you: every conversation that waits for the owner, from every source the window lists (Desk's own chats,
// Claude Desktop and CLI sessions, Codex, ChatGPT), walked one after another. Pure: no Vue, no store.
//
// WHAT WAITS. A conversation stopped on a permission, a question or a plan (status needs_you) blocks an agent, so those
// come first. Then every conversation whose turn ended with something the owner has not looked at: a Desk chat marked
// unread, or an outside session that wrote after the owner last looked at it here (`seen`). An outside session the owner
// never opened here counts only when it wrote in the last day, so turning the queue on does not bring back every old
// session. No filtering by what the messages say.
//
// HELD. Once the queue has a conversation it keeps it until it is answered, marked Done or runs again, though opening it
// marked it read and Later or Next moved past it (`held`, kept by state.ts).
//
// ORDER. Stopped agents first, then the others; within each, in the order the queue took them (`held`: what waited when
// it was turned on, oldest first, then each new one at the end, as it starts waiting), and never moving the one on
// screen. Later puts one at the very end, behind everything that waits, in the order Later was pressed.
import type { ChatStatus, ChatSummary, ExternalSession } from '@shared/protocol'
import type { View } from '@/components/shell/logic'
import { sourceLabel } from '@/components/sidebar/logic'
import { isExternalChatId, NEW_CHATGPT, sessionOfChatId } from '@/components/external/logic'

/** An outside session never opened here counts as waiting only when it wrote this recently. */
export const UNSEEN_WINDOW_MS = 24 * 60 * 60 * 1000

export interface InboxEntry {
  /** A Desk chat's id, or an outside session's id. */
  key: string
  view: View
  title: string
  /** Where it comes from, as the sidebar names it: Desk, Claude Desktop, Codex, ChatGPT, ... */
  source: string
  /** A permission, a question or a plan waits: an agent is stopped until the owner answers. */
  blocking: boolean
  /** Since when it waits (its last activity), ms. */
  since: number
  /** Running again: the owner (or someone elsewhere) answered it. Only the conversation on screen is kept while busy. */
  busy: boolean
}

const BUSY: readonly ChatStatus[] = ['starting', 'working']
/** A Desk chat whose turn ended: an unread one waits for the owner. */
const ENDED: readonly ChatStatus[] = ['idle', 'stopped', 'error', 'closed', 'limited']

/** The entry key a composer's or a card's chat id stands for: an outside session's stand-in chat is that session. */
export const keyOfChatId = (chatId: string): string => (isExternalChatId(chatId) ? sessionOfChatId(chatId) : chatId)

function chatEntry(c: ChatSummary): InboxEntry {
  return {
    key: c.id,
    view: { kind: 'chat', id: c.id },
    title: c.title,
    source: 'Desk',
    blocking: c.status === 'needs_you',
    since: c.lastActionAt ?? c.updatedAt,
    busy: BUSY.includes(c.status)
  }
}

function externalEntry(s: ExternalSession): InboxEntry {
  return {
    key: s.id,
    view: { kind: 'external', id: s.id },
    title: s.title,
    source: sourceLabel(s.source),
    blocking: s.status === 'needs_you',
    since: s.lastActivityAt ?? 0,
    busy: s.status === 'working'
  }
}

function chatWaits(c: ChatSummary): boolean {
  if (c.archived) return false
  return c.status === 'needs_you' || (c.unread && ENDED.includes(c.status))
}

function externalWaits(s: ExternalSession, seen: ReadonlyMap<string, number>, now: number): boolean {
  if (s.archived || s.id === NEW_CHATGPT) return false
  if (s.status === 'needs_you') return true
  if (s.status === 'working' || s.lastActivityAt === null) return false
  if (s.unread) return true
  const looked = seen.get(s.id)
  return looked === undefined ? now - s.lastActivityAt <= UNSEEN_WINDOW_MS : s.lastActivityAt > looked
}

export interface InboxInputs {
  chats: readonly ChatSummary[]
  external: readonly ExternalSession[]
  /** When the owner last looked at each outside session here, ms. */
  seen: ReadonlyMap<string, number>
  /** When Later was pressed on each conversation, ms. */
  later: ReadonlyMap<string, number>
  /** Conversations just answered whose answer is still on its way (or just went): left out until it lands. */
  answered: ReadonlySet<string>
  /** Conversations the queue already holds, each with when it took it (a running number): kept while they are not
   *  running again, though opening one marked it read and Later or Next moved past it. */
  held: ReadonlyMap<string, number>
  now: number
}

/** Everything waiting on the owner, in the order the queue walks it. */
export function inboxEntries(i: InboxInputs): InboxEntry[] {
  const out: InboxEntry[] = []
  const desk = new Set<string>()
  for (const c of i.chats) {
    if (c.sessionId) desk.add(c.sessionId)
    if (i.answered.has(c.id)) continue
    if (chatWaits(c) || (i.held.has(c.id) && !BUSY.includes(c.status) && !c.archived)) out.push(chatEntry(c))
  }
  for (const s of i.external) {
    // A session Desk runs as one of its own chats is that chat.
    if (desk.has(s.id) || i.answered.has(s.id)) continue
    if (externalWaits(s, i.seen, i.now) || (i.held.has(s.id) && s.status !== 'working' && !s.archived)) out.push(externalEntry(s))
  }
  return out.sort((a, b) => {
    const la = i.later.get(a.key)
    const lb = i.later.get(b.key)
    if (la !== undefined || lb !== undefined) return la === undefined ? -1 : lb === undefined ? 1 : la - lb
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1
    const ha = i.held.get(a.key)
    const hb = i.held.get(b.key)
    if (ha !== undefined || hb !== undefined) return ha === undefined ? 1 : hb === undefined ? -1 : ha - hb
    return a.since - b.since
  })
}

/** Where the queue goes once the conversation on screen is answered: the first that waits, never that one again. */
export function firstOther(entries: readonly InboxEntry[], current: string | null): InboxEntry | null {
  return entries.find((e) => e.key !== current) ?? null
}

/** Next without answering: the one after the conversation on screen, from the top again after the last. */
export function after(entries: readonly InboxEntry[], current: string | null): InboxEntry | null {
  const at = entries.findIndex((e) => e.key === current)
  if (at < 0) return entries[0] ?? null
  return entries.length > 1 ? entries[(at + 1) % entries.length]! : null
}

/** The held conversations still worth holding: listed, not archived and not running again (answered from anywhere). */
export function stillHeld<T>(held: ReadonlyMap<string, T>, chats: readonly ChatSummary[], external: readonly ExternalSession[]): Map<string, T> {
  const out = new Map<string, T>()
  for (const c of chats) if (held.has(c.id) && !c.archived && !BUSY.includes(c.status)) out.set(c.id, held.get(c.id)!)
  for (const s of external) if (held.has(s.id) && !s.archived && s.status !== 'working') out.set(s.id, held.get(s.id)!)
  return out
}

/** The entry key a view shows, when it shows a conversation. */
export function keyOfView(view: View): string | null {
  return view.kind === 'chat' || view.kind === 'external' ? view.id : null
}
