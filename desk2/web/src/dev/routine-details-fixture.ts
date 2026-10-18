// GET /api/routines/:id/details for the gallery and the parity scenes: about 40 invented runs of an invented routine
// (example-status, "Example paced check"), with totals, a trend group and counters. Pages like the server's.
import type { RoutineDetails, RoutineRun } from '@shared/routines'

const NOW = Date.UTC(2026, 9, 15, 12)
const MIN = 60_000

const RUNS: RoutineRun[] = Array.from({ length: 40 }, (_, i) => {
  const startedAt = NOW - (i + 1) * 37 * MIN
  const failed = i === 6 || i === 21
  const busy = i === 13
  const found = (i * 7) % 3
  return {
    startedAt,
    endedAt: startedAt + (3 + (i % 9)) * MIN,
    outcome: failed ? 'failed' : busy ? 'busy' : 'ok',
    exitCode: failed ? 1 : busy ? 75 : 0,
    lastLine: failed ? 'check failed: example queue unreachable' : `tick ${i}: found ${found}, queued ${found}, landed ${found > 0 ? 1 : 0}, refused ${i % 4 === 0 ? 1 : 0}`,
    workerId: null,
    sessionId: null,
    description: i % 3 === 0 && !failed && !busy ? { state: 'done', text: 'Moved two stale example items to the done list and fixed one wrong label.' } : undefined
  }
})

export function routineDetailsFixture(before: number | null = null, limit = 50): RoutineDetails {
  const older = before === null ? RUNS : RUNS.filter((r) => r.startedAt < before)
  const runs = older.slice(0, limit)
  return {
    id: 'example-status',
    name: 'Example paced check',
    runs,
    nextBefore: older.length > limit ? runs[runs.length - 1]!.startedAt : null,
    stats: { total: 40, ok: 37, failed: 2, busy: 1, successRate: 37 / 39, avgMs: 372_000, longestMs: 3_700_000, firstRunAt: NOW - 3 * 86_400_000, last24h: 38, last7d: 40 },
    counters: { found: 92, queued: 88, landed: 71, refused: 24 },
    totals: { found: 0, landed: 71, dropped: 60, refused: 24, skipped: 5, handed_off: 0, open: 2 },
    headline: 'steady, budget 1: landed 71, open 2',
    numbers: { ticks: 156, budget: 1, every_minutes: 15 },
    trends: {
      rsi: {
        keep_rate: { latest: 0.4431, previous: 0.4398, best: 0.4431, trend: 'flat' },
        refusal_rate: { latest: 0.2885, previous: 0.2913, best: 0.2885, trend: 'down' },
        minutes_per_kept: { latest: 6.243, previous: 6.179, best: 6.0139, trend: 'up' },
        found_per_tick: { latest: 0.68, previous: 0.68, best: 0.68, trend: 'flat' }
      }
    }
  }
}
