// A CLIMAYTE WORKER LIST MAKES NO KIT QUERY PER ATTEMPT (2026-10-13).
//
// toView priced every attempt with its own analytics-kit query, about 19K synchronous queries for one
// GET /api/corch/workers, and the daemon's main thread stopped answering for 403 s (the tray's watchdog
// could not kill it, and no new daemon could take the port). An attempt's cost is its own stored spend.
// The kit query module is wrapped to count calls; every call still goes through.

import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'

const realKitQuery = { ...(await import('../src/kit/query')) }
let kitQueries = 0
mock.module('../src/kit/query', () => ({
  ...realKitQuery,
  usageQuery: (...args: Parameters<typeof realKitQuery.usageQuery>) => {
    kitQueries++
    return realKitQuery.usageQuery(...args)
  },
}))

const { climayteCancel, climayteRun, killsLanded, setCliMayteAccountsProvider } = await import(
  '../src/climayte'
)
const { workers } = await import('../src/climayte-core')
const { app } = await import('../src/http-app')
await import('../src/routes/climayte')
const http = new Hono().route('/', app)

const scratch = mkdtempSync(join(tmpdir(), 'climayte-nokit-'))
const CWD = join(scratch, 'repo')
mkdirSync(CWD, { recursive: true })
const GROUP = 'nokit-g'

beforeAll(() => setCliMayteAccountsProvider(() => []))
afterAll(async () => {
  climayteCancel({ group: GROUP })
  await killsLanded()
  setCliMayteAccountsProvider(null)
  mock.module('../src/kit/query', () => realKitQuery)
  rmSync(scratch, { recursive: true, force: true })
})

const list = async (qs: string) =>
  (await (
    await http.fetch(new Request(`http://127.0.0.1/api/corch/workers?group=${GROUP}${qs}`))
  ).json()) as Array<Record<string, any>>

test('a worker list prices each attempt from its own spend, with no kit query', async () => {
  const made = climayteRun({
    tasks: [{ prompt: 'do three', cwd: CWD, title: 'three', size: 'whole' }],
    group: GROUP,
  }).workers
  const w = workers.get(made[0]!.id)!
  w.attempts = [0, 1, 2].map((i) => ({
    account: { id: 'a', num: 1, name: 'a' },
    outcome: 'done',
    startedAt: i,
    endedAt: i + 1,
    sessionId: `s-${i}`,
    spend: { costUsd: 0.5, turns: 1, reread: null },
  })) as never
  kitQueries = 0

  const lean = await list('&lean=1')
  const full = await list('')

  expect(lean.some((r) => r.id === w.id)).toBe(true)
  expect(
    full.find((r) => r.id === w.id)!.attempts.map((a: { costUsd: number }) => a.costUsd),
  ).toEqual([0.5, 0.5, 0.5])
  expect(kitQueries).toBe(0)
})
