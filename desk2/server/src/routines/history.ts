// A routine's full run history (the owner, 2026-10-15: "I can't really see all its runs. All I can see is the recent
// couple"). routines.json keeps only the last RUNS_KEPT runs for the judge; this file keeps every one, append-only, at
// <home>/routines/history/<id>.jsonl. A line is a run (keyed by startedAt) or a later `{ startedAt, description }` row for
// the same run; the reader folds the last row of a key over the first. Pure helpers here; the plugin does the calls.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RoutineDetailsStats, RoutineRun, RunDescription } from '@shared/routines'

export interface HistoryRow extends Partial<RoutineRun> {
  startedAt: number
}

/** The rows of a history file's text, in file order; a damaged line is skipped. */
export function parseHistory(text: string): HistoryRow[] {
  const rows: HistoryRow[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as HistoryRow
      if (r && typeof r.startedAt === 'number') rows.push(r)
    } catch {
      /* a half-written last line */
    }
  }
  return rows
}

/** Rows folded into runs, newest start first: a later row's keys replace the earlier ones for the same startedAt. */
export function foldHistory(rows: HistoryRow[]): RoutineRun[] {
  const by = new Map<number, HistoryRow>()
  for (const r of rows) by.set(r.startedAt, { ...by.get(r.startedAt), ...r })
  return [...by.values()]
    .filter((r) => typeof r.endedAt === 'number' && typeof r.outcome === 'string')
    .map((r) => ({ exitCode: null, lastLine: '', workerId: null, sessionId: null, ...r }) as RoutineRun)
    .sort((a, b) => b.startedAt - a.startedAt)
}

export function readHistory(file: string): RoutineRun[] {
  try {
    return foldHistory(parseHistory(readFileSync(file, 'utf8')))
  } catch {
    return []
  }
}

export function appendRows(file: string, rows: HistoryRow[]): void {
  if (rows.length === 0) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

/** The rows `kept` adds to `have`: a run the history lacks (oldest first), or a finished description it lacks. */
export function missingRows(have: RoutineRun[], kept: RoutineRun[]): HistoryRow[] {
  const known = new Map(have.map((r) => [r.startedAt, r]))
  const rows: HistoryRow[] = []
  for (const r of [...kept].reverse()) {
    const h = known.get(r.startedAt)
    if (!h) rows.push(r)
    else if (r.description && r.description.state !== 'pending' && h.description?.state !== r.description.state) rows.push({ startedAt: r.startedAt, description: r.description })
  }
  return rows
}

/** Backfills (and syncs descriptions of) a routine's history file from its memory's runs. Returns whether it wrote. */
export function syncHistory(file: string, kept: RoutineRun[]): boolean {
  const rows = missingRows(existsSync(file) ? readHistory(file) : [], kept)
  appendRows(file, rows)
  return rows.length > 0
}

export function descriptionRow(startedAt: number, description: RunDescription): HistoryRow {
  return { startedAt, description }
}

const DAY = 86_400_000

/** Run counts, rates and durations over the whole history. Busy runs count apart from failures and from the average. */
export function statsOf(runs: RoutineRun[], now: number): RoutineDetailsStats {
  const ok = runs.filter((r) => r.outcome === 'ok').length
  const busy = runs.filter((r) => r.outcome === 'busy').length
  const failed = runs.length - ok - busy
  const durs = runs.filter((r) => r.outcome !== 'busy').map((r) => Math.max(0, r.endedAt - r.startedAt))
  return {
    total: runs.length,
    ok,
    failed,
    busy,
    successRate: ok + failed > 0 ? ok / (ok + failed) : null,
    avgMs: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null,
    longestMs: durs.length ? Math.max(...durs) : null,
    firstRunAt: runs.length ? Math.min(...runs.map((r) => r.startedAt)) : null,
    last24h: runs.filter((r) => r.startedAt >= now - DAY).length,
    last7d: runs.filter((r) => r.startedAt >= now - 7 * DAY).length,
  }
}

/** `word N` pairs in a run's last line ("found 1, queued 1, landed 1"): each word's number. */
export function countersOf(line: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of line.matchAll(/(?:^|[\s,:;(])([A-Za-z][A-Za-z_-]{1,29})[ =]+(\d+)(?![\w.:-])/g)) {
    const w = m[1].toLowerCase()
    out[w] = (out[w] ?? 0) + Number(m[2])
  }
  return out
}

/** The counters summed over every run. A word seen in only one of several runs is noise (a date, an id), so it is left out. */
export function sumCounters(runs: RoutineRun[]): Record<string, number> {
  const sum: Record<string, number> = {}
  const seenIn: Record<string, number> = {}
  for (const r of runs) {
    for (const [w, n] of Object.entries(countersOf(r.lastLine))) {
      sum[w] = (sum[w] ?? 0) + n
      seenIn[w] = (seenIn[w] ?? 0) + 1
    }
  }
  const need = Math.min(2, runs.length)
  return Object.fromEntries(Object.entries(sum).filter(([w]) => seenIn[w] >= need))
}

/** A page of the runs started before `before` (ms, exclusive), newest first, and where the next page starts. */
export function pageOf(runs: RoutineRun[], before: number | null, limit: number): { runs: RoutineRun[]; nextBefore: number | null } {
  const older = before === null ? runs : runs.filter((r) => r.startedAt < before)
  const page = older.slice(0, limit)
  return { runs: page, nextBefore: older.length > limit ? page[page.length - 1].startedAt : null }
}
