// A routine's full run history (routines/history.ts): backfill without duplicates, descriptions folded onto their run,
// paging, whole-history stats, and the `word N` counters of the runs' last lines.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RoutineRun } from '@shared/routines'
import { appendRows, countersOf, foldHistory, pageOf, parseHistory, readHistory, statsOf, sumCounters, syncHistory } from '../../src/routines/history'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 15, 12)
const run = (startedAt: number, over: Partial<RoutineRun> = {}): RoutineRun => ({ startedAt, endedAt: startedAt + 60_000, outcome: 'ok', exitCode: 0, lastLine: '', workerId: null, sessionId: null, ...over })

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'routine-history-'))
  dirs.push(d)
  return join(d, 'history', 'example.jsonl')
}

describe('history file', () => {
  test('the first sync backfills the kept runs once, later syncs add only new runs, and a finished description joins its run', () => {
    const file = tmp()
    const kept = [run(3000), run(2000), run(1000)]
    expect(syncHistory(file, kept)).toBe(true)
    expect(syncHistory(file, kept)).toBe(false)
    expect(readHistory(file).map((r) => r.startedAt)).toEqual([3000, 2000, 1000])

    const next = [run(4000, { description: { state: 'pending', text: '' } }), ...kept]
    expect(syncHistory(file, next)).toBe(true)
    next[0].description = { state: 'done', text: 'Fixed one thing.' }
    expect(syncHistory(file, next)).toBe(true)
    const all = readHistory(file)
    expect(all).toHaveLength(4)
    expect(all[0].description).toEqual({ state: 'done', text: 'Fixed one thing.' })
    // Runs the memory has dropped stay.
    expect(syncHistory(file, [run(5000)])).toBe(true)
    expect(readHistory(file)).toHaveLength(5)
  })

  test('a half-written last line is skipped', () => {
    const file = tmp()
    appendRows(file, [run(1000)])
    writeFileSync(file, readFileSync(file, 'utf8') + '{"startedAt": 2000, "endedA')
    expect(parseHistory(readFileSync(file, 'utf8'))).toHaveLength(1)
    expect(foldHistory(parseHistory(readFileSync(file, 'utf8')))).toHaveLength(1)
  })
})

describe('paging', () => {
  test('pages come newest first, each starts before the last one ended, and the last page has no next', () => {
    const runs = [5, 4, 3, 2, 1].map((n) => run(n * 1000))
    const a = pageOf(runs, null, 2)
    expect(a.runs.map((r) => r.startedAt)).toEqual([5000, 4000])
    const b = pageOf(runs, a.nextBefore, 2)
    expect(b.runs.map((r) => r.startedAt)).toEqual([3000, 2000])
    const c = pageOf(runs, b.nextBefore, 2)
    expect(c.runs.map((r) => r.startedAt)).toEqual([1000])
    expect(c.nextBefore).toBeNull()
  })
})

describe('stats', () => {
  test('counts, rate, durations and windows come from every run; busy runs are not failures or timings', () => {
    const runs = [
      run(NOW - 1 * 3600_000, { endedAt: NOW - 1 * 3600_000 + 120_000 }),
      run(NOW - 3 * DAY, { outcome: 'failed', exitCode: 1, endedAt: NOW - 3 * DAY + 60_000 }),
      run(NOW - 10 * DAY, { outcome: 'busy', exitCode: 75, endedAt: NOW - 10 * DAY + 1000 }),
      run(NOW - 11 * DAY, { endedAt: NOW - 11 * DAY + 180_000 }),
    ]
    expect(statsOf(runs, NOW)).toEqual({ total: 4, ok: 2, failed: 1, busy: 1, successRate: 2 / 3, avgMs: 120_000, longestMs: 180_000, firstRunAt: NOW - 11 * DAY, last24h: 1, last7d: 2 })
  })
  test('no runs gives nulls, not NaN', () => {
    expect(statsOf([], NOW)).toMatchObject({ total: 0, successRate: null, avgMs: null, firstRunAt: null })
  })
})

describe('counters', () => {
  const line = 'tick 20261015T082828Z-fc444f: found 1, queued 1, dispatched 1, collected 1, landed 1, refused 0'
  test('reads word-number pairs and leaves ids and times alone', () => {
    expect(countersOf(line)).toEqual({ found: 1, queued: 1, dispatched: 1, collected: 1, landed: 1, refused: 0 })
  })
  test('sums over runs and drops a word that only one run has', () => {
    const runs = [run(1, { lastLine: line }), run(2, { lastLine: 'tick x: found 2, landed 0, refused 1' }), run(3, { lastLine: 'exit 3' })]
    expect(sumCounters(runs)).toEqual({ found: 3, landed: 1, refused: 1 })
  })
})
