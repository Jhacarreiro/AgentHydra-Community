import { describe, expect, test } from 'bun:test'
import { counterLabel, durationText, mergeRuns, runCounterText, statTiles, trendRows, trendWord } from '../../src/components/panes/routine-details'

describe('routine details formatting', () => {
  test('the stat tiles read the whole-history numbers, with the success rate as a percent and the average as a duration', () => {
    const tiles = statTiles({ stats: { total: 156, ok: 150, failed: 4, busy: 2, successRate: 150 / 154, avgMs: 372_000, longestMs: 3_600_000, firstRunAt: Date.UTC(2026, 9, 12, 12), last24h: 96, last7d: 156 } })
    expect(Object.fromEntries(tiles.map((t) => [t.label, t.value]))).toMatchObject({ Runs: '156', Succeeded: '150', Failed: '4', 'Success rate': '97%', 'Avg time': '6 min' })
    expect(tiles.find((t) => t.key === 'failed')?.title).toBe('2 more were busy or skipped')
    expect(tiles.find((t) => t.key === 'avg')?.title).toBe('Longest 1 h')
  })

  test('durations and labels', () => {
    expect([durationText(null), durationText(45_000), durationText(7_500_000)]).toEqual(['-', '45 s', '2 h 5 min'])
    expect([counterLabel('landed'), counterLabel('handed_off')]).toEqual(['Fixes landed', 'Handed off'])
  })

  test('a trend reads its own word, else latest against previous, and rates show as percents', () => {
    expect(trendWord({ latest: 1, previous: 2, trend: 'flat' })).toBe('flat')
    expect(trendWord({ latest: 3, previous: 2 })).toBe('up')
    expect(trendRows({ keep_rate: { latest: 0.4431, best: 0.45, trend: 'down' }, minutes_per_kept: { latest: 6.243 } })).toMatchObject([
      { label: 'Keep rate', latest: '44.3%', best: '45%', word: 'down' },
      { label: 'Minutes per kept', latest: '6.24', best: '-', word: 'flat' }
    ])
  })

  test('pages merge without doubling a run, and a run line with counters shows them', () => {
    expect(mergeRuns([{ startedAt: 3 }, { startedAt: 2 }], [{ startedAt: 2 }, { startedAt: 1 }]).map((r) => r.startedAt)).toEqual([3, 2, 1])
    expect(runCounterText('tick 20261015T082828Z-fc444f: found 1, queued 1, landed 1, refused 0')).toBe('found 1 · queued 1 · landed 1 · refused 0')
    expect(runCounterText('exit 3')).toBe('')
  })
})
