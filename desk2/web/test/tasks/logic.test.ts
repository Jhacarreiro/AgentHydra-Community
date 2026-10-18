import { describe, expect, test } from 'bun:test'
import type { CliMayteWorker, SwarmJob, TranscriptItem } from '@shared/protocol'
import {
  agentState,
  canStop,
  etaLeft,
  etaShort,
  formatElapsed,
  formatTokens,
  forText,
  doingsOf,
  doingTitle,
  latestEtaEnd,
  openPhase,
  panelLists,
  phaseSquares,
  QUIET_MS,
  runningLabel,
  type DoingOf,
  workerUnits
} from '../../src/components/tasks/logic'

function w(id: string, over: Partial<CliMayteWorker> = {}): CliMayteWorker {
  return {
    id,
    title: id,
    description: null,
    group: null,
    status: 'running',
    active: true,
    account: '#68',
    model: 'claude-opus-5-5',
    effort: null,
    kind: 'code',
    cwd: null,
    sessionId: `s-${id}`,
    originSessionId: 'chat-1',
    startedAt: 1_000,
    endedAt: null,
    lastActivityAt: null,
    lastActivity: null,
    usedPct: null,
    tokens: null,
    verdict: null,
    error: null,
    ...over
  }
}
const done = (id: string, over: Partial<CliMayteWorker> = {}) =>
  w(id, { status: 'done', active: false, verdict: 'ok', endedAt: 5_000, ...over })

const job = (id: string, over: Partial<SwarmJob> = {}): SwarmJob => ({
  id,
  title: `job ${id}`,
  status: 'running',
  active: true,
  startedAt: 1_000,
  endedAt: null,
  tasks: { total: 3, done: 1, failed: 0, cancelled: 0 },
  callerSessionId: 'chat-1',
  callerHostSessionId: null,
  callerTitle: null,
  pc: null,
  tokens: null,
  costUsd: null,
  models: null,
  ...over
})

const task =(id: string, status: 'running' | 'completed' | 'failed', over: Partial<Extract<TranscriptItem, { kind: 'task' }>> = {}): TranscriptItem => ({
  id,
  ts: 2_000,
  kind: 'task',
  taskId: id,
  description: 'bun test ./web/test\nsecond line',
  status,
  taskKind: 'bash',
  ...over
})

describe('units', () => {
  test('a group is one unit; a worker with no group is its own', () => {
    const units = workerUnits([w('a', { group: 'g' }), w('b', { group: 'g' }), w('c')])
    expect(units.map((u) => [u.id, u.name, u.agents])).toEqual([
      ['worker:c', 'c', 1],
      ['group:g', 'g', 2]
    ])
  })

  test('a group sums its tokens, takes the first line of its oldest task and lists its running workers for Stop', () => {
    const [u] = workerUnits([
      w('a', { group: 'g', tokens: 170_500, startedAt: 2_000, description: 'later' }),
      w('b', { group: 'g', tokens: 177_500, startedAt: 1_000, description: 'Round 2: fix' }),
      done('c', { group: 'g', tokens: 191_600, startedAt: 1_500 })
    ])
    expect(u!.tokens).toBe(539_600)
    expect(u!.description).toBe('Round 2: fix')
    expect(u!.startedAt).toBe(1_000)
    expect(u!.running).toBe(true)
    expect(u!.endedAt).toBeNull()
    expect(u!.stoppable.sort()).toEqual(['a', 'b'])
    expect(u!.label).toBe('CliMayte')
  })

  test('tokens stay unknown when no worker knows them', () => {
    expect(workerUnits([w('a')])[0]!.tokens).toBeNull()
  })

  test('phases by stage: done/total, running agents first, friendly model names', () => {
    const [u] = workerUnits([
      done('shell', { group: 'g', kind: 'fix', startedAt: 1 }),
      w('news', { group: 'g', kind: 'fix', startedAt: 2 }),
      w('audit', { group: 'g', kind: 'reaudit', status: 'queued', startedAt: 3 })
    ])
    expect(u!.phases.map((p) => [p.name, p.done, p.total])).toEqual([
      ['Fix', 1, 2],
      ['Reaudit', 0, 1]
    ])
    expect(u!.phases[0]!.agents.map((a) => [a.name, a.model, a.state])).toEqual([
      ['news', 'Opus 5.5', 'running'],
      ['shell', 'Opus 5.5', 'done']
    ])
    expect(phaseSquares(u!.phases[0]!)).toEqual(['done', 'running'])
    expect(openPhase(u!)).toBe('Fix')
  })

  test('agent states', () => {
    expect(agentState(w('a', { status: 'checking' }))).toBe('running')
    expect(agentState(w('a', { status: 'waiting' }))).toBe('waiting')
    expect(agentState(done('a'))).toBe('done')
    expect(agentState(done('a', { status: 'failed' }))).toBe('failed')
    expect(agentState(done('a', { status: 'cancelled' }))).toBe('failed')
  })
})

describe('panelLists', () => {
  test("scoped to this chat's workers unless All, plus its running tasks", () => {
    const workers = [w('mine'), w('theirs', { originSessionId: 'chat-2' })]
    const items = [task('t1', 'running'), task('t2', 'completed')]
    const mine = panelLists({ workers, items, sessionId: 'chat-1' })
    expect(mine.running.map((u) => u.id)).toEqual(['task:t1', 'worker:mine'])
    expect(mine.running[0]!.name).toBe('bun test ./web/test')
    expect(mine.running[0]!.label).toBe('Background command')
    expect(mine.finished.map((u) => u.id)).toEqual(['task:t2'])
    expect(panelLists({ workers, sessionId: 'chat-1', all: true }).running).toHaveLength(2)
    expect(panelLists({ workers, sessionId: null }).running).toHaveLength(0)
  })

  test('the matched workerIds list its workers, finished ones too, whatever their origin session', () => {
    const workers = [w('moved', { originSessionId: 'old-session' }), done('gone', { originSessionId: 'old-session' }), w('theirs', { originSessionId: 'chat-2' })]
    const lists = panelLists({ workers, sessionId: 'new-session', workerIds: ['moved', 'gone'] })
    expect(lists.running.map((u) => u.id)).toEqual(['worker:moved'])
    expect(lists.finished.map((u) => u.id)).toEqual(['worker:gone'])
  })

  test("finished: most recent first, minus the cleared, capped at the real app's 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => done(`d${i}`, { endedAt: 10_000 + i }))
    const { finished } = panelLists({ workers: many, sessionId: 'chat-1', cleared: new Set(['d59']) })
    expect(finished).toHaveLength(50)
    expect(finished[0]!.id).toBe('worker:d58')
  })

  test("a Desk chat's running task can be stopped by its task id; a settled one, or one of a session outside Hydra Desk, cannot", () => {
    const items = [task('run', 'running', { taskId: 'b1' }), task('ok', 'completed', { durationMs: 1_000 })]
    const desk = panelLists({ workers: [w('mine')], items, sessionId: 'chat-1', chatId: 'desk-chat-1' })
    const run = desk.running.find((u) => u.id === 'task:run')!
    expect(run.stopTask).toBe('b1')
    expect(canStop(run)).toBe(true)
    expect(desk.finished[0]!.stopTask).toBeNull()
    const worker = desk.running.find((u) => u.id === 'worker:mine')!
    expect([worker.stopTask, canStop(worker)]).toEqual([null, true])
    const outside = panelLists({ workers: [], items, sessionId: 'chat-1', chatId: null })
    expect(outside.running.map((u) => [u.stopTask, canStop(u)])).toEqual([[null, false]])
  })

  test("an HSwarm job this session called lists running while active, finished once settled; another session's is left out", () => {
    const jobs = [
      job('live'),
      job('done', { active: false, status: 'done', startedAt: 2_000, endedAt: 5_000, tasks: { total: 2, done: 2, failed: 0, cancelled: 0 } }),
      job('stopped', { active: false, status: 'cancelled', endedAt: null }),
      job('theirs', { callerSessionId: 'chat-2' })
    ]
    const lists = panelLists({ workers: [], sessionId: 'chat-1', jobs })
    expect(lists.running.map((u) => [u.id, u.label, u.name, u.description])).toEqual([['job:live', 'HSwarm', 'job live', '1 of 3 done']])
    // A cancelled job has no finished time: its end stays null, never NaN, and it reads as failed.
    expect(lists.finished.map((u) => [u.id, u.endedAt, !!u.failed, u.stoppable])).toEqual([
      ['job:done', 5_000, false, []],
      ['job:stopped', null, true, []]
    ])
  })

  test("the session's own workers and jobs list beside the window's, which wins for one in both; an old read's running copy waits", () => {
    const own = {
      sessionId: 'chat-1',
      workers: [done('dropped', { endedAt: 3_000 }), done('listed', { endedAt: 3_000 }), w('stale'), done('deep', { originSessionId: 's-mid' })],
      jobs: [job('old', { active: false, status: 'done', endedAt: 2_000 }), job('ran', { active: false, status: 'done', endedAt: 2_000 })]
    }
    // The window still lists 'listed' (finished later than the read saw), the running 'deep' that no origin ties to the
    // chat, and the job 'ran' still running; it dropped 'dropped', 'stale' (finished since) and the job 'old'.
    const workers = [done('listed', { endedAt: 9_000 }), w('deep', { originSessionId: 's-mid' })]
    const jobs = [job('ran')]
    const lists = panelLists({ workers, jobs, own, sessionId: 'chat-1' })
    expect(lists.running.map((u) => u.id).sort()).toEqual(['job:ran', 'worker:deep'])
    expect(lists.finished.map((u) => [u.id, u.endedAt])).toEqual([
      ['worker:listed', 9_000],
      ['worker:dropped', 3_000],
      ['job:old', 2_000]
    ])
    // A read for another session is never this one's.
    expect(panelLists({ workers: [], own, sessionId: 'chat-2' }).finished).toEqual([])
  })

  test("a job's 8-character caller id, the prefix it stamps, matches the session that begins with it", () => {
    const sid = 'a1b2c3d4-0000-4000-8000-000000000000'
    const lists = panelLists({ workers: [], sessionId: sid, jobs: [job('short', { callerSessionId: 'a1b2c3d4' }), job('other', { callerSessionId: 'ffffffff' })] })
    expect(lists.running.map((u) => u.id)).toEqual(['job:short'])
  })

  test("a chat's finished background tasks list and count under finished, a failed one marked", () => {
    const items = [task('run', 'running'), task('ok', 'completed', { durationMs: 1_000 }), task('bad', 'failed', { durationMs: 500 })]
    const lists = panelLists({ workers: [], items, sessionId: 'chat-1' })
    expect(lists.running.map((u) => u.id)).toEqual(['task:run'])
    expect(lists.finished.map((u) => [u.id, !!u.failed])).toEqual([
      ['task:ok', false],
      ['task:bad', true]
    ])
  })
})

const doing = (over: Partial<DoingOf>): DoingOf => ({
  name: 'Fix',
  doing: 'Waiting for CPU: 99% busy',
  kind: 'hold',
  state: 'waiting',
  since: 0,
  lastStepAt: null,
  ...over,
})

test('labels and formats', () => {
  expect(runningLabel(0, 0, 0, null, [])).toBe('')
  expect(runningLabel(1, 0, 0, null, [])).toBe('1 running task')
  expect(runningLabel(3, 0, 0, null, [])).toBe('3 running tasks')
  expect(runningLabel(1, 2, 0, null, [])).toBe('1 running task · 2 finished')
  expect(runningLabel(0, 1, 0, null, [])).toBe('1 finished task')
  expect(runningLabel(0, 50, 0, null, [])).toBe('50+ finished tasks')
  expect(runningLabel(0, 2, 0, 300_000, [])).toBe('2 finished tasks')
  expect(runningLabel(3, 50, 0, 300_000, [])).toBe('3 running tasks · about 5 min left · 50+ finished')
  expect(runningLabel(1, 5, 360_000, 1_020_000, [doing({ since: 0 })])).toBe(
    '1 running task · Waiting for CPU: 99% busy · for 6 min · about 11 min left · 5 finished',
  )
  expect(
    runningLabel(3, 5, 360_000, 1_020_000, [
      doing({ name: 'Fix', since: 0 }),
      doing({ name: 'A', state: 'running', kind: 'step', doing: 'Bash bun test ./server/tests', since: 300_000, lastStepAt: 300_000 }),
      doing({ name: 'B', state: 'running', kind: 'said', doing: 'Reading the diff', since: 300_000, lastStepAt: 300_000 }),
    ]),
  ).toBe('3 running tasks · 1 waiting for CPU for 6 min · 2 working · about 11 min left · 5 finished')
  expect(runningLabel(2, 0, 1_200_000, null, [doing({ since: 840_000 }), doing({ name: 'B', since: 900_000 })])).toBe(
    '2 running tasks · 2 waiting for CPU for 6 min',
  )
  expect(
    runningLabel(7, 5, 1_200_000, 1_440_000, [
      doing({ name: 'R', doing: 'Waiting for room: this task is expected to use about 20%', since: 0 }),
      doing({ name: 'M', doing: 'Waiting for memory: 2 GB free', since: 300_000 }),
      doing({ name: 'S', doing: 'Waiting for a reset: acct has used 80%', since: 600_000 }),
      doing({ name: 'C1', since: 840_000 }),
      doing({ name: 'C2', since: 900_000 }),
      doing({ name: 'W', state: 'running', kind: 'step', doing: 'Bash bun test', since: 1_100_000, lastStepAt: 1_140_000 }),
      doing({ name: 'Q', state: 'running', kind: 'step', doing: 'Bash ls', since: 120_000, lastStepAt: 120_000 }),
    ]),
  ).toBe(
    '7 running tasks · 1 waiting for room for 20 min · 1 waiting for memory for 15 min · +3 more waiting · 1 working · 1 quiet for 18 min · about 4 min left · 5 finished',
  )
  expect(runningLabel(1, 0, QUIET_MS - 1_000, null, [doing({ state: 'running', kind: 'step', doing: 'Bash ls', since: 0, lastStepAt: 0 })])).toBe(
    '1 running task · Bash ls · for 14 min',
  )
  expect(runningLabel(1, 0, QUIET_MS, null, [doing({ state: 'running', kind: 'step', doing: 'Bash ls', since: 0, lastStepAt: 0 })])).toBe(
    '1 running task · Bash ls · no update for 15 min',
  )
  expect(runningLabel(1, 0, 1_200_000, null, [doing({ state: 'running', kind: 'said', doing: 'Reading the diff', since: 900_000, lastStepAt: 900_000 })])).toBe(
    '1 running task · Reading the diff · 5 min ago',
  )
  expect(runningLabel(1, 0, 1_200_000, null, [doing({ state: 'running', kind: 'said', doing: 'Reading the diff', since: 1_150_000, lastStepAt: 1_150_000 })])).toBe(
    '1 running task · Reading the diff',
  )
  expect(runningLabel(1, 0, 1_200_000, null, [doing({ state: 'running', kind: 'wait', doing: 'Waiting: Monitor build-job', since: 720_000, lastStepAt: 720_000 })])).toBe(
    '1 running task · Waiting: Monitor build-job · for 8 min',
  )
  expect(forText(null, 1_000)).toBe('')
  expect(doingTitle([doing({ since: 0 })], 120_000)).toBe('Fix: Waiting for CPU: 99% busy (for 2 min)')
  expect(doingTitle([doing({ state: 'running', kind: 'step', doing: 'Bash ls', since: 0, lastStepAt: 0 })], QUIET_MS)).toBe(
    'Fix: Bash ls (no update for 15 min)',
  )
  const agent = (name: string, state: 'running' | 'waiting' | 'done', doingSince: number | null) => ({
    id: name, name, model: '', tokens: null, startedAt: null, endedAt: null, state, sessionId: null, etaMin: null,
    doing: state === 'done' ? null : `${name} doing`, doingSince,
  })
  const units = [{ phases: [{ agents: [agent('late', 'running', 900), agent('early', 'waiting', 100), agent('gone', 'done', 50)] }] }]
  expect(doingsOf(units as unknown as Parameters<typeof doingsOf>[0]).map((d) => d.name)).toEqual(['early', 'late'])
  expect(formatElapsed(666_000)).toBe('11m 06s')
  expect(formatElapsed(45_000)).toBe('45s')
  expect(formatElapsed(3_720_000)).toBe('1h 02m')
  expect(formatTokens(539_600)).toBe('539.6k')
  expect(formatTokens(812)).toBe('812')
  expect(formatTokens(4_106_540)).toBe('4.1M')
  expect(formatTokens(null)).toBe('–')
})

describe('estimates', () => {
  const eta = (minutes: number, at: number, tookS: number | null = null) => ({ minutes, at, tookS })

  test("a unit's estimate runs out at its latest still-working worker's; a settled or finished one does not count", () => {
    const [unit] = workerUnits([
      w('a', { group: 'g', eta: eta(5, 0) }), // ends at 300 s
      w('b', { group: 'g', eta: eta(2, 120_000) }), // ends at 240 s
      w('c', { group: 'g', status: 'checking', eta: eta(30, 0, 200) }), // its message is done: being checked
      done('d', { group: 'g', eta: eta(60, 0, 900) }),
      w('e', { group: 'g' }) // gave none
    ])
    expect(unit!.etaEndsAt).toBe(300_000)
    expect(unit!.phases[0]!.agents.map((a) => [a.id, a.etaMin])).toEqual([
      ['a', 5],
      ['b', 2],
      ['c', 30],
      ['e', null],
      ['d', 60]
    ])
    expect(workerUnits([w('x')])[0]!.etaEndsAt).toBeNull()
  })

  test('the row takes the latest end among running units', () => {
    const units = workerUnits([w('a', { eta: eta(5, 0) }), w('b', { eta: eta(10, 0) }), done('c', { eta: eta(90, 0, 60) })])
    expect(latestEtaEnd(units)).toBe(600_000)
    expect(latestEtaEnd(workerUnits([w('x')]))).toBeNull()
  })

  test('left, due and over', () => {
    expect(etaLeft(300_000, 0)).toBe('about 5 min left')
    expect(etaLeft(300_000, 250_000)).toBe('about 1 min left')
    expect(etaLeft(4_800_000, 0)).toBe('about 1 h 20 min left')
    expect(etaLeft(3_600_000, 0)).toBe('about 1 h left')
    expect(etaLeft(300_000, 330_000)).toBe('due about now')
    expect(etaLeft(300_000, 480_000)).toBe('3 min over the estimate')
  })

  test("a worker's estimate in the Time cell", () => {
    expect(etaShort(5)).toBe('~5m')
    expect(etaShort(7.5)).toBe('~8m')
    expect(etaShort(80)).toBe('~1h 20m')
    expect(etaShort(0.5)).toBe('~30s')
  })
})
