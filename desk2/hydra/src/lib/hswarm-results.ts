// The arithmetic behind HSwarm's "Model results" cards: thumbs up and down per model (HSwarm's own tasks and
// CliMayte's scorecard, side by side), tokens per successful task, and the ranking that keeps a model with two
// lucky successes from topping the list. Kept apart from the card so the numbers can be read on their own.
import type { CliMayteScorecard } from '@/lib/api'
import { countsPct, formatScorePct, modelName } from '@/lib/climayte-status'

/** Fewer successes (or tasks) than this and one task moves the number too far to rank the model. */
export const SMALL_SAMPLE = 5

export type ResultsSource = 'both' | 'hswarm' | 'climayte'

export interface ThumbRow {
  key: string
  source: 'hswarm' | 'climayte'
  model: string
  /** HSwarm: answered. CliMayte: passed. */
  up: number
  /** CliMayte only: slip + rework (passed after a fix). */
  fixed: number
  /** HSwarm: error or timeout. CliMayte: failed (severity 3). */
  down: number
  /** The percentage beside the thumbs: HSwarm's answer rate, CliMayte's score (pass 1, slip 2/3, rework 1/3). */
  pct: string
  /** CliMayte rows off the routing ladder: history only. */
  dim: boolean
  /** CliMayte: slip and rework counts, for the tooltip. */
  slip: number
  rework: number
}

/** Input and output tokens of a model's tasks per successful one. Cache reads and cache writes are left out:
 *  a cache read is the same prompt sent again on every turn, so counting it would bill one task many times over.
 *  Null with no success, and null when the route recorded no tokens at all (a subscription route reports none),
 *  so the card shows a dash rather than a 0 that reads as "free". */
export function tokensPerOk(input: number, output: number, ok: number): number | null {
  const tokens = input + output
  if (ok <= 0 || tokens <= 0) return null
  return Math.round(tokens / ok)
}

/** Models with fewer than SMALL_SAMPLE of the counted thing go after every other model, fewest-first within each group. */
export function rankBySample<T extends { small: boolean; value: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => Number(a.small) - Number(b.small) || a.value - b.value)
}

/** HSwarm's own thumbs (ok and failed) and CliMayte's (pass and fail), one row per model per source, busiest first.
 *  CliMayte's scorecard splits a model by kind and thinking level; its thumbs are summed per model here. */
export function thumbRows(
  hswarm: Array<{ model: string; ok: number; failed: number }>,
  climayte: CliMayteScorecard['rows'] | null,
  source: ResultsSource,
): ThumbRow[] {
  const rows: ThumbRow[] = []
  if (source !== 'climayte') {
    for (const m of hswarm) {
      const n = m.ok + m.failed
      rows.push({
        key: `hswarm:${m.model}`,
        source: 'hswarm',
        model: m.model,
        up: m.ok,
        fixed: 0,
        down: m.failed,
        pct: formatScorePct(n ? m.ok / n : null, m.failed > 0, m.ok > 0),
        dim: false,
        slip: 0,
        rework: 0,
      })
    }
  }
  if (source !== 'hswarm' && climayte) {
    const byModel = new Map<string, { pass: number; slip: number; rework: number; failed: number; onLadder: boolean }>()
    for (const r of climayte) {
      const model = r.model ?? ''
      const sum = byModel.get(model) ?? { pass: 0, slip: 0, rework: 0, failed: 0, onLadder: r.onLadder !== false }
      sum.pass += r.pass
      sum.slip += r.slip ?? 0
      sum.rework += r.rework ?? 0
      sum.failed += r.failed ?? r.fail
      byModel.set(model, sum)
    }
    for (const [model, sum] of byModel) {
      rows.push({
        key: `climayte:${model}`,
        source: 'climayte',
        model: model ? modelName(model) : '',
        up: sum.pass,
        fixed: sum.slip + sum.rework,
        down: sum.failed,
        pct: countsPct(sum),
        dim: !sum.onLadder,
        slip: sum.slip,
        rework: sum.rework,
      })
    }
  }
  return rows.sort((a, b) => b.up + b.fixed + b.down - (a.up + a.fixed + a.down) || a.model.localeCompare(b.model))
}
