// CliMayte workers that sit stuck: nothing else is going to move them, so the orchestrator flags them (plugins/70-orchestrator.ts).
// Pure: the daemon's workers in, the stuck ones out. A queued, running or checking worker is never stuck.

import type { CliMayteWorker } from '@shared/protocol'

/** A held or unanswered worker is stuck once it has sat this long. */
export const STUCK_MS = 2 * 3_600_000
/** A usage wall whose end passed this long ago and still holds the worker is stuck. */
export const WALL_OVERDUE_MS = 30 * 60_000

export type StuckReason = 'question' | 'wave' | 'held' | 'wall'

export interface Stuck {
  worker: CliMayteWorker
  reason: StuckReason
  /** Epoch ms it has been stuck since. */
  since: number
  /** The reason in plain words: the question, the hold or error line, or what a manager waits on. */
  why: string
}

const cut = (s: string, n = 300): string => (s.replace(/\s+/g, ' ').trim().length > n ? `${s.replace(/\s+/g, ' ').trim().slice(0, n)}...` : s.replace(/\s+/g, ' ').trim())

export function stuckWorkers(workers: readonly CliMayteWorker[], now: number): Stuck[] {
  const out: Stuck[] = []
  for (const w of workers) {
    if (w.pc || (w.active && w.status !== 'waiting')) continue
    const changed = w.lastActivityAt ?? w.startedAt ?? now
    if (w.status === 'done' && w.question) {
      if (now - w.question.at > STUCK_MS) out.push({ worker: w, reason: 'question', since: w.question.at, why: `it asked: ${cut(w.question.text)}` })
      continue
    }
    if (w.status !== 'waiting') continue
    const wall = w.waitUntil ? Date.parse(w.waitUntil) : NaN
    if (Number.isFinite(wall)) {
      if (now - wall > WALL_OVERDUE_MS) out.push({ worker: w, reason: 'wall', since: wall, why: `it waits on a usage wall that ended ${new Date(wall).toISOString().replace(/\.\d+Z$/, 'Z')} and still holds it` })
      continue
    }
    if (now - changed <= STUCK_MS) continue
    if (w.kind === 'manage' && w.hold === 'wave') {
      const live = workers.some((t) => t.id !== w.id && t.wave === w.wave && t.kind !== 'manage' && t.active)
      if (!live) out.push({ worker: w, reason: 'wave', since: changed, why: `wave ${w.wave ?? '?'}: this manager waits on it, but none of its tasks is live` })
      continue
    }
    out.push({ worker: w, reason: 'held', since: changed, why: `it is held: ${cut(w.lastActivity ?? w.error ?? 'no reason given')}` })
  }
  return out
}
