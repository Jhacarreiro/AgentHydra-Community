import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../src/config'
import {
  checkShortfall,
  MIN_TURNED,
  type ShortfallReport,
  shortfallMessage,
} from '../src/hswarm-shortfall'

const report = (turned: number, more: number | null): ShortfallReport => ({
  days: 1,
  since: '2026-10-12T09:00:00+00:00',
  pools: [
    {
      pool: 'free',
      turned_away: turned,
      not_counted: { signed_out: 4 },
      kinds: [
        {
          kind: 'chatgpt',
          accounts: 4,
          served: 900,
          per_hour: 120,
          more,
          would_take: more ? 290 : null,
        },
        {
          kind: 'claude',
          accounts: 2,
          served: 30,
          per_hour: 40,
          more: more ? more + 3 : null,
          would_take: more ? 280 : null,
        },
      ],
    },
    {
      pool: 'climayte',
      turned_away: 0,
      not_counted: { machine: 12 },
      kinds: [
        { kind: 'climayte', accounts: null, served: 40, per_hour: 6, more: 0, would_take: 0 },
      ],
    },
  ],
})

afterEach(() => rmSync(join(DATA_DIR, 'hswarm-shortfall.json'), { force: true }))

// Contract: the owner is told how many more accounts would have helped, the title naming the fewest that would, and
// only when a day's turn-aways reach MIN_TURNED and more accounts would have taken some of them.
test('the message names the fewest accounts that would have taken the turned-away work', () => {
  expect(shortfallMessage(report(312, 6))).toEqual({
    title: 'We would love 6 more Free ChatGPT accounts',
    body:
      'In the last 24 hours: 312 tasks could have run on a Free account but found none free and went to a paid key; ' +
      '6 more Free ChatGPT accounts would have taken 290, or 9 more Free Claude accounts would have taken 280.',
  })
  expect(shortfallMessage(report(MIN_TURNED - 1, 6))).toBeNull()
  expect(shortfallMessage(report(312, null))).toBeNull()
})

// Contract: one notification a day at most, kept on disk so a restart does not repeat it, and a message no channel
// took is tried again at the next check. Regression: a daemon restarted to update every hour would say it each time.
test('a notification goes out at most once a day, and one no channel took is tried again', async () => {
  const sent: string[] = []
  let delivered = false
  const deps = {
    read: async () => report(312, 6),
    send: async (m: { title: string }) => {
      sent.push(m.title)
      return delivered
    },
  }
  const t0 = Date.parse('2026-10-13T09:00:00Z')
  const hour = 3_600_000
  expect(await checkShortfall(deps, t0)).toBe(false)
  delivered = true
  expect(await checkShortfall(deps, t0 + hour)).toBe(true)
  expect(await checkShortfall(deps, t0 + 2 * hour)).toBe(false)
  expect(sent).toHaveLength(2)
  expect(await checkShortfall(deps, t0 + 26 * hour)).toBe(true)
  expect(sent).toHaveLength(3)
})
