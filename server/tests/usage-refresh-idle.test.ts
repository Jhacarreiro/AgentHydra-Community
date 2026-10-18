// server/tests/usage-refresh-idle.test.ts - how often the background sweep reads an account
// (usage-refresh.ts). Owner, 2026-10-14: nobody looking at AgentHydra for a while should "significantly
// lower the rate of polling". At most every 30 minutes while someone looks (owner, 2026-09-07), every
// four hours an hour after the last look, and a reading another reader just took is not read again.
import { describe, expect, test } from 'bun:test'
import { IDLE_AFTER_MS, IDLE_INTERVAL_MIN, readingDue, sweepIntervalMs } from '../src/usage-refresh'

const now = Date.parse('2026-10-14T12:00:00Z')
const min = (m: number) => m * 60_000

describe('sweepIntervalMs', () => {
  test.each([
    ['looked a minute ago', 30, now - min(1), min(30)],
    ['looked 59 minutes ago', 30, now - min(59), min(30)],
    ['looked an hour ago', 30, now - IDLE_AFTER_MS, min(IDLE_INTERVAL_MIN)],
    ['never looked since the daemon started', 30, 0, min(IDLE_INTERVAL_MIN)],
    ['idle, with a setting longer than the idle interval', 6 * 60, 0, min(6 * 60)],
  ] as const)('%s', (_, setting, seen, want) => {
    expect(sweepIntervalMs(setting, seen, now)).toBe(want)
  })
})

describe('readingDue', () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  test.each([
    ['a reading 31 minutes old', iso(now - min(31)), undefined, true],
    ['a reading 5 minutes old (CliMayte or a click read it)', iso(now - min(5)), undefined, false],
    ['no reading, never tried', null, undefined, true],
    ['no reading, tried 10 minutes ago', null, now - min(10), false],
    ['an old reading, tried 31 minutes ago', iso(now - min(90)), now - min(31), true],
    ['a reading with no time', 'not a time', undefined, true],
  ] as const)('%s', (_, captured, tried, due) => {
    expect(readingDue(captured, tried, min(30), now)).toBe(due)
  })
})
