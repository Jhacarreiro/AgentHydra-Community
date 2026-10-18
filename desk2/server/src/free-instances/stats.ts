// The Free tab's numbers (owner, 2026-10-08: "total tokens for ... Claude and ChatGPT ... and also per each ... also
// the success rate across which models ... were used on each"). Each day keeps, for each account and model, how many
// messages (new chats and continuations) were sent, how many failed, and their token estimate (tokens.ts). Counts
// only, never text; the last STATS_DAYS days are kept.
import type { FreeStatRow } from '@shared/free-instances'
import type { TokenLedger } from './tokens'

export const STATS_DAYS = 30
/** No model: tokens counted before Desk recorded models, and a send that failed before ChatGPT or Claude picked one
 *  ("ChatGPT rejected the HTTP request"). Its tokens show by day and its sends and failures in the totals, never as a
 *  model of its own (owner, 2026-10-10, of the 'unknown' model those failures used to be listed as: "figure out what
 *  the unknown model is ... and remove it"). */
export const UNRECORDED_MODEL = ''

/** `why` counts the failures by their error code (`not_found`, `rate_limited` ...), so a day's failures can be explained
 *  after the account's one-hour health (health.ts) has moved on (2026-10-14: 205 ChatGPT sends failed in a day with
 *  nothing left to say why). Absent on a cell with no failure. */
export interface StatCell { sent: number; failed: number; input: number; output: number; why?: Record<string, number> }
/** By day (YYYY-MM-DD, this PC's time), then account id, then model. */
export type StatsData = Record<string, Record<string, Record<string, StatCell>>>

const pad = (n: number) => String(n).padStart(2, '0')
export const dayOf = (at: number): string => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const oldestKept = (now: number): string => dayOf(now - (STATS_DAYS - 1) * 86_400_000)

function add(stats: StatsData, at: number, instanceId: string, model: string, cell: StatCell): void {
  const byModel = ((stats[dayOf(at)] ??= {})[instanceId] ??= {})
  const c = (byModel[model] ??= { sent: 0, failed: 0, input: 0, output: 0 })
  c.sent += cell.sent; c.failed += cell.failed; c.input += cell.input; c.output += cell.output
  for (const [code, n] of Object.entries(cell.why ?? {})) (c.why ??= {})[code] = (c.why[code] ?? 0) + n
}

/** One message counted: sent, failed or not, with its tokens (none for a failure); days past the kept span dropped. */
export function addStat(stats: StatsData, message: { at: number; instanceId: string; model: string | undefined; ok: boolean; code?: string; input: number; output: number }): StatsData {
  const why = message.ok ? undefined : { [(message.code || 'unknown').slice(0, 60)]: 1 }
  add(stats, message.at, message.instanceId, message.model || UNRECORDED_MODEL, { sent: 1, failed: message.ok ? 0 : 1, input: message.input, output: message.output, ...(why ? { why } : {}) })
  const oldest = oldestKept(message.at)
  for (const day of Object.keys(stats)) if (day < oldest) delete stats[day]
  return stats
}

/** The first record of a store that had none: the week of token estimates the accounts already hold, by day, as
 *  tokens alone, so the chart has a history from its first day. */
export function seedStats(tokens: Record<string, TokenLedger>): StatsData {
  const stats: StatsData = {}
  for (const [id, ledger] of Object.entries(tokens))
    for (const e of ledger.entries) add(stats, e.at, id, UNRECORDED_MODEL, { sent: 0, failed: 0, input: e.input, output: e.output })
  return stats
}

/** The rows of the last `days` days, oldest first. */
export function statRows(stats: StatsData, days: number, now: number): FreeStatRow[] {
  const oldest = dayOf(now - (Math.min(Math.max(1, days), STATS_DAYS) - 1) * 86_400_000)
  return Object.keys(stats).filter(d => d >= oldest).sort().flatMap(day =>
    Object.entries(stats[day]!).flatMap(([instanceId, byModel]) => Object.entries(byModel).map(([model, c]) => ({ day, instanceId, model, ...c }))))
}

/** A stored record as it must be: damaged cells are dropped, never trusted. */
export function validStats(value: unknown): StatsData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0
  const stats: StatsData = {}
  for (const [day, byId] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !byId || typeof byId !== 'object') continue
    for (const [id, byModel] of Object.entries(byId as Record<string, unknown>)) {
      if (!byModel || typeof byModel !== 'object') continue
      for (const [model, cell] of Object.entries(byModel as Record<string, StatCell>))
        if (cell && n(cell.sent) && n(cell.failed) && n(cell.input) && n(cell.output) && model.length <= 100) {
          const why = cell.why && typeof cell.why === 'object' && !Array.isArray(cell.why)
            ? Object.fromEntries(Object.entries(cell.why).filter(([code, k]) => code.length <= 60 && n(k)))
            : {}
          add(stats, Date.parse(`${day}T12:00:00`), id, model, { sent: cell.sent, failed: cell.failed, input: cell.input, output: cell.output, ...(Object.keys(why).length ? { why } : {}) })
        }
    }
  }
  return stats
}
