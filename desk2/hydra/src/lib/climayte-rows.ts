// The one-line task row's text, shared by CliMayte's worker list and HSwarm's Jobs table (one row style
// everywhere, CliMayteRow.vue). These were CliMayteView's own; the rules are unchanged.
import type { CliMayteWorkerView } from '@/lib/api'
import { climayteRunLabel } from '@/lib/climayte-status'

/** How long the task has been active: its sessions' running time over every attempt, not the time
 *  since it was queued (owner, 2026-10-02: "if it sat for two hours, but it only worked for one,
 *  then it should show one hour, not three"). Waiting for an account or a reset does not count. */
export function activeSeconds(w: Pick<CliMayteWorkerView, 'ranS' | 'status'>, now: number, listedAt: number): number {
  return w.ranS + (w.status === 'running' ? Math.max(0, (now - listedAt) / 1000) : 0)
}

/** The i18n key and values that say a duration, e.g. "12 min"; the caller runs them through its t(). */
export function activeTime(totalS: number): { key: string; values: Record<string, number> } {
  const m = Math.floor(totalS / 60)
  if (m < 1) return { key: 'climayte.activeSeconds', values: { s: Math.floor(totalS) } }
  if (m < 60) return { key: 'climayte.activeMinutes', values: { m } }
  const h = Math.floor(m / 60)
  if (h < 24) return { key: 'climayte.activeHours', values: { h, m: m % 60 } }
  return { key: 'climayte.activeDays', values: { d: Math.floor(h / 24), h: h % 24 } }
}

/** The row's model: the one that ran (else the one asked for) and the effort, e.g. `Opus 5.5 · max`;
 *  amber when the CLI ran a different model than the one asked for. */
export function runTag(w: CliMayteWorkerView): { text: string; differs: boolean } | null {
  const run = climayteRunLabel(w)
  if (!run) return null
  const model = run.ran ?? run.model
  return {
    text: [model, run.effort].filter(Boolean).join(' · '),
    differs: run.differs,
  }
}

/** The waves the Waves page has open, by wave id (CliMayteWaves reads it when it mounts). */
export const WAVE_OPEN_KEY = 'agenthydra.climayte.waveOpen'

/** Opens one wave when the Waves page shows: a Jobs row for a wave asks for it this way. */
export function openWaveRow(id: string): void {
  let open: Record<string, boolean> = {}
  try {
    open = JSON.parse(localStorage.getItem(WAVE_OPEN_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    // A value this page cannot read is replaced rather than kept.
  }
  localStorage.setItem(WAVE_OPEN_KEY, JSON.stringify({ ...open, [id]: true }))
}
