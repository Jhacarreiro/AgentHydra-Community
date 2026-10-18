// The open session's own CliMayte workers and HSwarm jobs (SessionTasks, GET /api/session-tasks/:id), read while its
// Background tasks panel or its tasks line is on screen. The window's own lists keep the 20 newest finished of the whole
// PC, which a busy PC turns over in minutes; these keep the session's, so its panel goes on listing them (owner,
// 2026-10-10). One read loop per session however many views show it, and only while the window is in sight; the
// sidebar keeps the window's lists.
import { computed, shallowRef, watch, type ComputedRef, type Ref } from 'vue'
import type { SessionTasks } from '@shared/protocol'

/** How often a session's own lists are read while on screen: its finished items leave the window's lists minutes after
 *  they finish, and until then the window's copy is the one shown. */
const POLL_MS = 15_000
/** The sessions whose last answer is kept, so going back to one paints at once. */
const KEPT = 10

/** Each session's last answer, the newest KEPT. Read without `useSessionTasks` by a view that only counts with them. */
export const sessionTasks = shallowRef<ReadonlyMap<string, SessionTasks>>(new Map())

interface Reader {
  users: number
  timer: ReturnType<typeof setTimeout> | null
  busy: boolean
}
const readers = new Map<string, Reader>()
const hidden = () => typeof document !== 'undefined' && document.hidden

function keep(id: string, answer: SessionTasks): void {
  const next = new Map(sessionTasks.value)
  next.delete(id)
  next.set(id, answer)
  for (const k of next.keys()) {
    if (next.size <= KEPT) break
    if (!readers.has(k)) next.delete(k)
  }
  sessionTasks.value = next
}

function halt(r: Reader): void {
  if (r.timer) clearTimeout(r.timer)
  r.timer = null
}

/** Reads the session now (one read at a time), then again every POLL_MS while it is on screen and the window in sight. */
async function tick(id: string): Promise<void> {
  const r = readers.get(id)
  if (!r || r.busy || hidden()) return
  halt(r)
  r.busy = true
  try {
    const res = await fetch(`/api/session-tasks/${encodeURIComponent(id)}`)
    if (res.ok) keep(id, (await res.json()) as SessionTasks)
  } catch {
    // Desk out of reach: the last answer stands until the next read.
  } finally {
    r.busy = false
  }
  if (readers.get(id) === r && r.users > 0 && !hidden()) r.timer = setTimeout(() => void tick(id), POLL_MS)
}

// A hidden window reads nothing; showing it again reads every session on screen at once.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    for (const [id, r] of readers) {
      if (document.hidden) halt(r)
      else void tick(id)
    }
  })
}

function use(id: string): () => void {
  let r = readers.get(id)
  if (!r) readers.set(id, (r = { users: 0, timer: null, busy: false }))
  r.users++
  void tick(id)
  const reader = r
  return () => {
    reader.users--
    if (reader.users > 0) return
    halt(reader)
    readers.delete(id)
  }
}

/** The session's own lists while the calling component is mounted: null with no session, and until its first answer. */
export function useSessionTasks(sessionId: Readonly<Ref<string | null | undefined>>): ComputedRef<SessionTasks | null> {
  watch(
    sessionId,
    (id, _old, onCleanup) => {
      if (id) onCleanup(use(id))
    },
    { immediate: true }
  )
  return computed(() => (sessionId.value ? (sessionTasks.value.get(sessionId.value) ?? null) : null))
}
