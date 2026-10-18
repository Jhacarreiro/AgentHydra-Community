// The Desktop and CLI blocks of the Usage history card (owner, 2026-10-10: "CLI doesn't show model stats, neither does
// desktop, like free does ... I would like that added in"). A source's spend report (getSpend) becomes its totals and
// a list of models. CLI is two reports, cli and climayte (CliMayte's workers run on the CLI accounts), merged by model.
// Tokens are the weighted measure the card's tokens-per-day bars use.
import type { SpendReport } from '@agenthydra/server/types'

/** The windows the card's toggle offers (owner, 2026-10-10: "toggles for, like, seven days, 30 days, all time, et
 *  cetera"): the spend report's own periods. */
export const USAGE_PERIODS = ['24h', '7d', '30d', 'all'] as const
export type UsagePeriod = (typeof USAGE_PERIODS)[number]
/** The days of Desk's daily Free record a period reads: the record keeps 30 (server/src/free-instances/stats.ts), so
 *  All time is those 30, and 24 hours is today. */
export const FREE_KEPT_DAYS = 30
export const freeDaysFor = (p: UsagePeriod): number => ({ '24h': 1, '7d': 7, '30d': 30, all: FREE_KEPT_DAYS })[p]

export interface UsageTotals {
  tokens: number
  sessions: number
  turns: number
}
export interface UsageModel extends UsageTotals {
  model: string
}
export interface UsageSummary extends UsageTotals {
  models: UsageModel[]
}

const byTokens = (a: Pick<UsageModel, 'model' | 'tokens'>, b: Pick<UsageModel, 'model' | 'tokens'>) =>
  b.tokens - a.tokens || a.model.localeCompare(b.model)

/** The totals of the reports added up, and their models merged by id, the most tokens first. A missing report counts for nothing. */
export function summarizeUsage(reports: ReadonlyArray<SpendReport | null | undefined>): UsageSummary {
  const totals: UsageTotals = { tokens: 0, sessions: 0, turns: 0 }
  const models = new Map<string, UsageModel>()
  for (const r of reports) {
    if (!r) continue
    totals.tokens += r.totalWeighted
    totals.sessions += r.sessions
    for (const b of r.byModel) {
      const m = models.get(b.key) ?? { model: b.key, tokens: 0, sessions: 0, turns: 0 }
      m.tokens += b.weighted
      m.sessions += b.sessions
      m.turns += b.turns
      models.set(b.key, m)
      totals.turns += b.turns
    }
  }
  return { ...totals, models: [...models.values()].sort(byTokens) }
}

/** Where a model's tokens came from on the All tab: the table's own kinds. */
export const MODEL_SOURCES = ['desktop', 'cli', 'free'] as const
export type ModelSource = (typeof MODEL_SOURCES)[number]
export interface CombinedModel {
  model: string
  tokens: number
  /** Each source that used it, with its tokens, in MODEL_SOURCES order. */
  parts: Array<{ source: ModelSource; tokens: number }>
}

/** The All tab's one list of models (owner, 2026-10-10: All "still doesn't properly... show the combined list of
 *  models"): a model is one row whichever accounts ran it, its tokens added up, the most first. A model a source lists
 *  twice (Free lists one per provider) adds into that source's one part. */
export function combineModels(sources: Partial<Record<ModelSource, ReadonlyArray<{ model: string; tokens: number }>>>): CombinedModel[] {
  const rows = new Map<string, CombinedModel>()
  for (const source of MODEL_SOURCES) {
    for (const m of sources[source] ?? []) {
      const row = rows.get(m.model) ?? { model: m.model, tokens: 0, parts: [] }
      const part = row.parts.find((p) => p.source === source)
      if (part) part.tokens += m.tokens
      else row.parts.push({ source, tokens: m.tokens })
      row.tokens += m.tokens
      rows.set(m.model, row)
    }
  }
  return [...rows.values()].sort(byTokens)
}
