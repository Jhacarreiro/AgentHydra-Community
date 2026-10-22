// Waiting on you's one state (logic.ts says what waits and in which order): on or off, the conversation on screen,
// Later, what the owner last looked at, and the Undo window on what was just sent (hold.ts). Answering the conversation
// on screen moves to the next one at once (auto-advance, on unless turned off); the answer itself goes when its Undo
// window ends. createInbox takes its inputs so a test can drive it; store.ts binds it to the desk store, once.
import { computed, ref, shallowRef, watch, type Ref } from 'vue'
import type { ChatSummary, ExternalSession } from '@shared/protocol'
import type { View } from '@/components/shell/logic'
import type { HeldKind } from './hold'
import { after, firstOther, inboxEntries, keyOfChatId, keyOfView, stillHeld, type InboxEntry } from './logic'

/** How long a send to the conversation on screen waits for Undo. */
export const HOLD_MS = 5000
/** How long an answered conversation stays out of the queue while its answer lands and its status catches up. */
export const ANSWERED_MS = 15_000
/** How many outside sessions' last look are remembered. */
export const SEEN_MAX = 500

const ON_KEY = 'hydra-desk.inbox.on'
const AUTO_KEY = 'hydra-desk.inbox.auto'
const SEEN_KEY = 'hydra-desk.inbox.seen'
const DONE_KEY = 'hydra-desk.inbox.done'

export interface InboxDeps {
  chats: () => readonly ChatSummary[]
  external: () => readonly ExternalSession[]
  selected: () => View
  select: (view: View) => void
  markRead: (chatId: string) => void
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  /** Outside conversations quiet for longer than this, ms, leave the queue (Settings → Forget old waits). */
  forgetAfterMs?: () => number | null
  now?: () => number
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void }
}

/** A send waiting for its Undo window to end. */
export interface PendingSend {
  key: string
  title: string
  kind: HeldKind
  /** Its place in the queue, for Undo. */
  place: number | undefined
}

function readSeen(storage: InboxDeps['storage'], key = SEEN_KEY): Map<string, number> {
  try {
    const raw = JSON.parse(storage?.getItem(key) ?? '[]')
    if (Array.isArray(raw)) return new Map(raw.filter((p): p is [string, number] => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'number'))
  } catch {
    // a broken value is nothing seen
  }
  return new Map()
}

export function createInbox(deps: InboxDeps) {
  const now = deps.now ?? Date.now
  const timers = deps.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>) }
  const store = (key: string, value: string) => {
    try {
      deps.storage?.setItem(key, value)
    } catch {
      // storage full or blocked: remembered for this window only
    }
  }

  const on = ref(deps.storage?.getItem(ON_KEY) === '1')
  const auto = ref(deps.storage?.getItem(AUTO_KEY) !== '0')
  const seen = shallowRef(readSeen(deps.storage))
  const doneAt = shallowRef(readSeen(deps.storage, DONE_KEY))
  const later = shallowRef(new Map<string, number>())
  const answered = shallowRef(new Set<string>())
  /** What the queue holds, each with its place (when the queue took it): everything that waited while it was on, until
   *  it is answered, Done, or runs again. */
  const held = shallowRef(new Map<string, number>())
  let places = 0
  /** The conversation on screen; it is the queue's current one only while the queue holds it. */
  const keep = ref<string | null>(keyOfView(deps.selected()))
  const pending = shallowRef<PendingSend | null>(null)
  let pendingDone: ((send: boolean) => void) | null = null
  let pendingTimer: unknown = null
  /** The conversation the queue itself just moved away from: Later and Next are no look at it. */
  let quiet: string | null = null

  const entriesFor = (hold: ReadonlyMap<string, number>): InboxEntry[] =>
    inboxEntries({ chats: deps.chats(), external: deps.external(), seen: seen.value, done: doneAt.value, later: later.value, answered: answered.value, held: hold, forgetAfterMs: deps.forgetAfterMs?.() ?? null, now: now() })
  /** Everything the queue holds and everything that waits; a conversation that is only on screen is not in it. */
  const entries = computed(() => entriesFor(held.value))
  /** What waits now, before the queue holds it. */
  const fresh = computed(() => entriesFor(new Map()))
  const waiting = entries
  const current = computed(() => entries.value.find((e) => e.key === keep.value) ?? null)

  const drop = (key: string) => {
    if (!held.value.has(key)) return
    const next = new Map(held.value)
    next.delete(key)
    held.value = next
  }
  /** Takes what waits now into the queue, behind what it holds, in the order it waits (stopped agents first, oldest). */
  const take = () => {
    const add = fresh.value.filter((e) => !held.value.has(e.key))
    if (!add.length) return
    const next = new Map(held.value)
    for (const e of add) next.set(e.key, ++places)
    held.value = next
  }

  function markSeen(key: string) {
    if (!deps.external().some((s) => s.id === key)) return
    const next = new Map(seen.value)
    next.delete(key)
    next.set(key, now())
    while (next.size > SEEN_MAX) next.delete(next.keys().next().value!)
    seen.value = next
    store(SEEN_KEY, JSON.stringify([...next]))
  }

  /** Done on an outside session: out of what waits until it writes again, whatever its status says. */
  function markDone(key: string) {
    if (!deps.external().some((s) => s.id === key)) return
    const next = new Map(doneAt.value)
    next.delete(key)
    next.set(key, now())
    while (next.size > SEEN_MAX) next.delete(next.keys().next().value!)
    doneAt.value = next
    store(DONE_KEY, JSON.stringify([...next]))
  }

  function go(entry: InboxEntry | null) {
    if (!entry) return
    quiet = keep.value
    keep.value = entry.key
    deps.select(entry.view)
  }

  // While on, the queue holds whatever starts waiting, so opening it (which marks it read) or passing it by keeps it.
  watch(
    [on, fresh],
    () => {
      if (on.value) take()
    },
    { immediate: true }
  )
  // A held conversation that runs again, is archived or is gone was answered from somewhere: it leaves the queue.
  watch(
    () => stillHeld(held.value, deps.chats(), deps.external()),
    (kept) => {
      if (kept.size !== held.value.size) held.value = kept
    }
  )

  // Leaving an outside session by hand is having looked at it; the conversation opened is the one on screen.
  watch(
    () => keyOfView(deps.selected()),
    (key, was) => {
      if (was && was !== key && was !== quiet) markSeen(was)
      quiet = null
      if (key) keep.value = key
    }
  )

  // Answered from anywhere (a send that did not wait here, another window, the app itself): on to the next.
  watch(
    () => [keep.value, !!current.value] as const,
    ([key, present], [wasKey, wasPresent]) => {
      if (on.value && auto.value && key === wasKey && wasPresent && !present && !pending.value) go(firstOther(entries.value, key))
    }
  )

  function settle(send: boolean) {
    const done = pendingDone
    const p = pending.value
    if (pendingTimer !== null) timers.clear(pendingTimer)
    pendingTimer = null
    pendingDone = null
    pending.value = null
    if (!p) return
    if (send) timers.set(() => forget(p.key), ANSWERED_MS)
    else forget(p.key)
    done?.(send)
  }

  function forget(key: string) {
    if (!answered.value.has(key)) return
    const next = new Set(answered.value)
    next.delete(key)
    answered.value = next
  }

  /** A send waits for Undo only to the queue's own conversation on screen (or the one whose answer still waits, with
   *  Auto-advance off): never to a chat opened by hand that does not wait. */
  const holds = (chatId: string): boolean => {
    const key = keyOfChatId(chatId)
    return on.value && key === keep.value && (!!current.value || pending.value?.key === key)
  }

  function hold(chatId: string, kind: HeldKind): Promise<boolean> {
    const key = keyOfChatId(chatId)
    if (!holds(chatId)) return Promise.resolve(true)
    const title = current.value?.title ?? pending.value?.title ?? ''
    const place = held.value.get(key) ?? (pending.value?.key === key ? pending.value.place : undefined)
    settle(true)
    answered.value = new Set(answered.value).add(key)
    drop(key)
    if (later.value.has(key)) {
      const next = new Map(later.value)
      next.delete(key)
      later.value = next
    }
    pending.value = { key, title, kind, place }
    if (auto.value) go(firstOther(entries.value, key))
    return new Promise<boolean>((resolve) => {
      pendingDone = resolve
      pendingTimer = timers.set(() => settle(true), HOLD_MS)
    })
  }

  /** Undo: the send never goes, and the queue goes back to that conversation. */
  function undo() {
    const p = pending.value
    if (!p) return
    settle(false)
    held.value = new Map(held.value).set(p.key, p.place ?? ++places)
    // Back to it only once the undone send put its text back in the chat's saved draft, so the box shown there reads it.
    timers.set(() => go(entries.value.find((e) => e.key === p.key) ?? null), 0)
  }

  function start() {
    on.value = true
    store(ON_KEY, '1')
    take()
    if (!current.value) go(entries.value[0] ?? null)
  }

  function stop() {
    settle(true)
    on.value = false
    store(ON_KEY, '0')
  }

  function setAuto(v: boolean) {
    auto.value = v
    store(AUTO_KEY, v ? '1' : '0')
  }

  /** Done: nothing to answer here; it leaves the queue until it writes again. */
  function done() {
    const key = keep.value
    if (!key) return
    if (deps.chats().some((c) => c.id === key)) deps.markRead(key)
    else {
      markSeen(key)
      markDone(key)
    }
    drop(key)
    go(firstOther(entries.value, key))
  }

  /** Later: to the end of the queue, behind everything that waits. */
  function later_() {
    const key = keep.value
    if (!key) return
    const next = new Map(later.value)
    next.delete(key)
    next.set(key, now())
    later.value = next
    go(firstOther(entries.value, key))
  }

  return {
    on: on as Readonly<Ref<boolean>>,
    auto: auto as Readonly<Ref<boolean>>,
    entries,
    waiting,
    current,
    pending,
    holds,
    hold,
    undo,
    start,
    stop,
    setAuto,
    done,
    later: later_,
    next: () => go(after(entries.value, keep.value)),
    open: (entry: InboxEntry) => go(entry),
    /** Sends what waits for Undo now (the window is closing). */
    flush: () => settle(true)
  }
}

export type Inbox = ReturnType<typeof createInbox>
