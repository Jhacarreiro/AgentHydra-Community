// What the routine details view says, as pure functions: the stat tiles, the status totals and counters as labelled
// numbers, a trend as a row, a duration, and the run pages merged. The numbers come from GET /api/routines/:id/details.
import type { RoutineDetails, RoutineTrend } from '@shared/routines'

export interface Tile {
  key: string
  label: string
  value: string
  /** A fuller reading for the tile's tooltip. */
  title?: string
}

/** A duration: '45 s', '6 min', '2 h 5 min'; '-' when unknown. */
export function durationText(ms: number | null): string {
  if (ms === null) return '-'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

export const percentText = (rate: number | null): string => (rate === null ? '-' : `${Math.round(rate * 100)}%`)

/** A date for 'Since': 'Oct 12', with the year when it is not this one. */
export function sinceText(ms: number | null, now = Date.now()): string {
  if (ms === null) return '-'
  const d = new Date(ms)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }) })
}

/** The tiles every routine gets, from its whole history. Failed and busy runs are counted apart. */
export function statTiles(d: Pick<RoutineDetails, 'stats'>): Tile[] {
  const s = d.stats
  return [
    { key: 'runs', label: 'Runs', value: String(s.total), title: `${s.last24h} in the last 24 hours, ${s.last7d} in the last 7 days` },
    { key: 'ok', label: 'Succeeded', value: String(s.ok) },
    { key: 'failed', label: 'Failed', value: String(s.failed), title: s.busy ? `${s.busy} more were busy or skipped` : undefined },
    { key: 'rate', label: 'Success rate', value: percentText(s.successRate) },
    { key: 'avg', label: 'Avg time', value: durationText(s.avgMs), title: s.longestMs === null ? undefined : `Longest ${durationText(s.longestMs)}` },
    { key: 'since', label: 'Since', value: sinceText(s.firstRunAt) },
  ]
}

/** A counter or total word as a label: landed reads 'Fixes landed'; others are capitalised with spaces for underscores. */
export function counterLabel(word: string): string {
  if (word === 'landed') return 'Fixes landed'
  const w = word.replace(/[_-]+/g, ' ')
  return w.charAt(0).toUpperCase() + w.slice(1)
}

const labelled = (prefix: string, rec: Record<string, number> | null): Tile[] =>
  Object.entries(rec ?? {}).map(([k, n]) => ({ key: `${prefix}:${k}`, label: counterLabel(k), value: n.toLocaleString('en-US') }))

/** The status totals as tiles (what the routine says it has done now), and the counters summed from the runs' last lines. */
export const totalTiles = (d: Pick<RoutineDetails, 'totals'>): Tile[] => labelled('total', d.totals)
export const counterTiles = (d: Pick<RoutineDetails, 'counters'>): Tile[] => labelled('counter', d.counters)

export type TrendWord = 'up' | 'down' | 'flat'

/** Which way a trend object points, by its own `trend` word, else by latest against previous. */
export function trendWord(t: RoutineTrend): TrendWord {
  if (t.trend === 'up' || t.trend === 'down' || t.trend === 'flat') return t.trend
  if (t.previous === undefined || t.previous === t.latest) return 'flat'
  return t.latest > t.previous ? 'up' : 'down'
}

/** A trend's number: rates under 1 read as a percent when the name says rate, else up to 2 decimals. */
export function trendValue(name: string, n: number | undefined): string {
  if (n === undefined) return '-'
  if (/rate$/.test(name)) return `${Math.round(n * 1000) / 10}%`
  return String(Math.round(n * 100) / 100)
}

export interface TrendRow {
  name: string
  label: string
  latest: string
  best: string
  word: TrendWord
}

export function trendRows(group: Record<string, RoutineTrend>): TrendRow[] {
  return Object.entries(group).map(([name, t]) => ({
    name,
    label: counterLabel(name),
    latest: trendValue(name, t.latest),
    best: trendValue(name, t.best),
    word: trendWord(t)
  }))
}

/** Pages appended to the list already shown, by start time, so a reload of a page never doubles a run. */
export function mergeRuns<T extends { startedAt: number }>(shown: T[], page: T[]): T[] {
  const seen = new Set(shown.map((r) => r.startedAt))
  return [...shown, ...page.filter((r) => !seen.has(r.startedAt))]
}

/** A short line for a run's counters, 'found 1 · landed 1', from its last line; empty when it has none. */
export function runCounterText(line: string): string {
  const out: string[] = []
  for (const m of line.matchAll(/(?:^|[\s,:;(])([A-Za-z][A-Za-z_-]{1,29})[ =]+(\d+)(?![\w.:-])/g)) out.push(`${m[1]!.toLowerCase()} ${m[2]}`)
  return out.length >= 2 ? out.join(' · ') : ''
}

/** A run's start for the list: 'Oct 15, 6:23 AM' (its tooltip has the full stamp). */
export const runStamp = (ms: number): string => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
