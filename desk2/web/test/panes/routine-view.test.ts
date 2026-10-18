import { describe, expect, it } from 'bun:test'
import type { RoutineRun } from '@shared/routines'
import { lastRunText, nextRunText, plainReason, relativeTime, routineStatus, scheduleSentence, spanOf } from '../../src/components/panes/routine-view'

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0)
const run = (outcome: RoutineRun['outcome']): RoutineRun => ({ startedAt: NOW - 1, endedAt: NOW - 2 * 3_600_000, outcome, exitCode: 0, lastLine: '', workerId: null, sessionId: null })

describe('routineStatus', () => {
  it('reads the chip from the state, then from the last run', () => {
    expect(routineStatus({ state: 'running', runs: [run('failed')] })).toBe('running')
    expect(routineStatus({ state: 'paused', runs: [run('ok')] })).toBe('paused')
    expect(routineStatus({ state: 'broken', runs: [] })).toBe('failed')
    expect(routineStatus({ state: 'idle', runs: [run('timed-out')] })).toBe('failed')
    expect(routineStatus({ state: 'idle', runs: [run('ok')] })).toBe('ok')
    expect(routineStatus({ state: 'idle', runs: [] })).toBe('new')
  })
})

describe('times', () => {
  it('says past and future relative to now', () => {
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2 h ago')
    expect(relativeTime(NOW + 3 * 86_400_000, NOW)).toBe('in 3 d')
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now')
  })
  it('never rounds a span up into the next unit', () => {
    expect(spanOf(59.6 * 60_000)).toBe('1 h')
    expect(spanOf(59 * 60_000)).toBe('59 min')
    expect(spanOf(23.4 * 3_600_000)).toBe('23 h')
    expect(spanOf(1410 * 60_000)).toBe('1 d')
    expect(spanOf(30 * 3_600_000)).toBe('1 d')
  })
  it('names paused and unscheduled routines instead of a time', () => {
    expect(nextRunText({ state: 'paused', paused: true, nextRunAt: NOW + 1 }, NOW)).toBe('paused')
    expect(nextRunText({ state: 'idle', paused: false, nextRunAt: null }, NOW)).toBe('not scheduled')
    expect(nextRunText({ state: 'idle', paused: false, nextRunAt: NOW + 12 * 60_000 }, NOW)).toBe('in 12 min')
    expect(lastRunText({ runs: [], lastRunAt: null }, NOW)).toBeNull()
    expect(lastRunText({ runs: [run('ok')], lastRunAt: null }, NOW)).toBe('2 h ago')
  })
})

describe('scheduleSentence', () => {
  it('writes weekday schedules in words with the zone', () => {
    expect(scheduleSentence('57 8,12 * * 1-5', 'America/Chicago')).toBe('Weekdays at 8:57 and 12:57, Chicago time')
    expect(scheduleSentence('0 9 * * 1,3', 'UTC')).toBe('Monday and Wednesday at 9:00, UTC time')
  })
  it('hands back the cron for a form it cannot read plainly', () => {
    expect(scheduleSentence('*/5 * * * *', 'America/Chicago')).toBe('Cron */5 * * * *, Chicago time')
  })
})

describe('plainReason', () => {
  it("writes the manager's ISO stamps as local time in words and leaves other reasons as they are", () => {
    expect(plainReason('next due 2026-10-13T13:57:00.000Z', 'America/Chicago')).toBe('next due Tuesday, October 13 at 8:57, Chicago time')
    expect(plainReason('slot 2026-10-12T01:00:00.000Z was missed by more than 12 hours: skipped', 'UTC')).toBe(
      'slot Monday, October 12 at 1:00, UTC time was missed by more than 12 hours: skipped'
    )
    expect(plainReason('paused by the owner', 'America/Chicago')).toBe('paused by the owner')
    expect(plainReason('next due 2026-13-45T25:99Z', 'America/Chicago')).toBe('next due 2026-13-45T25:99Z')
  })
})
