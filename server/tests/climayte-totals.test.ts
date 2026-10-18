// CliMayte's totals: tasks that ran vs tasks filed, runs that never launched a CLI, the first task's time.
import { afterEach, describe, expect, test } from 'bun:test'
import { climayteTotals } from '../src/climayte'
import { workers } from '../src/climayte-core'

const ids: string[] = []
afterEach(() => {
  for (const id of ids.splice(0)) workers.delete(id)
})

// Stamped far ahead so `since` holds these tasks and none another test file left in the process.
const T = Date.now() + 40 * 86_400_000
const attempt = (over: Record<string, unknown>) => ({
  account: { id: 'acct-example', num: 1, name: 'Example' },
  pid: null,
  startedAt: T,
  endedAt: T + 1_000,
  outcome: 'done',
  started: false,
  ...over,
})
const put = (id: string, status: string, attempts: unknown[]) => {
  ids.push(id)
  workers.set(id, { id, title: id, status, createdAt: T, attempts } as any)
}

describe('climayteTotals honesty fields', () => {
  test('counts tasks that ran apart from tasks filed, and never-launched attempts apart from runs', () => {
    put('t-ran-done', 'done', [attempt({ pid: 4242, started: true })])
    put('t-ran-failed', 'failed', [
      attempt({ outcome: 'interrupted' }), // never launched
      attempt({ started: true, startedAt: T + 2_000, endedAt: T + 3_000, outcome: 'error' }),
    ])
    put('t-cancelled-before-run', 'cancelled', [attempt({ outcome: 'cancelled' })])
    put('t-queued-never', 'done', [])
    put('t-runner-claimed', 'done', [attempt({ runner: { pid: 77 }, outcome: 'interrupted' })])

    const t = climayteTotals(T - 1)
    expect(t.tasks).toBe(5)
    expect(t.tasksRan).toBeGreaterThanOrEqual(3)
    expect(t.tasksByStatus).toEqual({ done: 2, failed: 1, cancelled: 0, neverRan: 2 })
    // 4 launched attempts + 0; the two never-launched ones are counted apart, outside both sums.
    expect(t.sessions).toBe(3)
    expect(t.neverLaunched).toBe(2)
    expect(t.runsByOutcome.interrupted).toBe(1)
    expect(Object.values(t.runsByOutcome).reduce((a, b) => a + (b ?? 0), 0)).toBe(t.sessions)
  })

  test('firstAt is the first task on record, whatever `since` is', () => {
    put('t-first', 'done', [])
    const t = climayteTotals(T - 1)
    expect(t.firstAt).not.toBeNull()
    expect(t.firstAt!).toBeLessThanOrEqual(T)
  })
})
