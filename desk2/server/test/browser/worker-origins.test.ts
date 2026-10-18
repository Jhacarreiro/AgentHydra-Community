// The worker-origins map behind a chat's tab scope and its sound. Every worker AgentHydra ever ran is read once (27 MB
// on a busy PC, and building it held AgentHydra's thread); after that only the recent list, so a worker that has left
// the recent list must stay mapped, or its pages drop out of its chat's scope.
import { afterEach, expect, setSystemTime, test } from 'bun:test'
import type { Bridge } from '../../src/bridge'
import { withWorkerSessions, workerOrigins } from '../../src/browser/worker-origins'

type Row = { originSessionId: string | null; sessions: string[] }

function fakeBridge(lists: { all: () => Row[]; recent: () => Row[] }): { b: Bridge; asked: string[] } {
  const asked: string[] = []
  const b = {
    workers: async (o: { all?: boolean } = {}) => {
      asked.push(o.all ? 'all' : 'recent')
      return o.all ? lists.all() : lists.recent()
    },
  } as unknown as Bridge
  return { b, asked }
}

const later = () => setSystemTime(new Date(Date.now() + 6_000))
afterEach(() => setSystemTime())

test('the full list is read once; what the recent list brings later joins, and what left it stays', async () => {
  let recent: Row[] = []
  const { b, asked } = fakeBridge({
    all: () => [{ originSessionId: 'chat', sessions: ['old-worker'] }],
    recent: () => recent,
  })
  const origins = workerOrigins(b)
  expect(withWorkerSessions(['chat'], await origins())).toEqual(['chat', 'old-worker'])

  recent = [{ originSessionId: 'old-worker', sessions: ['new-worker'] }]
  later()
  expect(withWorkerSessions(['chat'], await origins()).sort()).toEqual(['chat', 'new-worker', 'old-worker'])
  expect(asked).toEqual(['all', 'recent'])
})

test('a first read AgentHydra did not answer reads the full list again next time', async () => {
  let up = false
  const { b, asked } = fakeBridge({
    all: () => {
      if (!up) throw new Error('AgentHydra is not running')
      return [{ originSessionId: 'chat', sessions: ['old-worker'] }]
    },
    recent: () => [],
  })
  const origins = workerOrigins(b)
  expect(withWorkerSessions(['chat'], await origins())).toEqual(['chat'])

  up = true
  later()
  expect(withWorkerSessions(['chat'], await origins())).toEqual(['chat', 'old-worker'])
  expect(asked).toEqual(['all', 'all'])
})
