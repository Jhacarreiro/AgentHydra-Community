import { describe, expect, test } from 'bun:test'
import { doingOf, newestSaid, stateKey } from '../src/climayte-doing'
import type { CliMayteWorker } from '../src/climayte-lib'

const worker = (over: Partial<CliMayteWorker>): CliMayteWorker =>
  ({
    status: 'queued',
    error: null,
    lastActivity: null,
    createdAt: 1_000,
    ...over,
  }) as CliMayteWorker

describe('doingOf', () => {
  test('a worker held for CPU says the reason, since the hold began', () => {
    const w = worker({
      status: 'queued',
      error: 'Waiting for CPU: 99% busy over the last 30 s. Nothing running is stopped.',
      stateAt: { key: 'queued|Waiting for CPU', at: 5_000 },
    })
    expect(doingOf(w)).toEqual({
      doing: 'Waiting for CPU: 99% busy over the last 30 s',
      doingSince: 5_000,
      doingKind: 'hold',
    })
  })

  test('a held reason is cut at its first clause and at 70 characters', () => {
    const split = worker({
      status: 'queued',
      error: 'Waiting for memory: needs 4 GB; 2 GB free. It starts when memory frees.',
    })
    expect(doingOf(split).doing).toBe('Waiting for memory: needs 4 GB')
    const long =
      'Waiting for an account nobody else is using right now while the others are all at their limit'
    const cut = doingOf(worker({ status: 'waiting', error: long })).doing!
    expect(cut.length).toBeLessThanOrEqual(70)
    expect(cut.endsWith('...')).toBe(true)
    expect(long.startsWith(cut.slice(0, -3))).toBe(true)
  })

  test('a running worker says its newest line, since that line last changed', () => {
    const w = worker({
      status: 'running',
      lastActivity: 'Bash bun test ./server/tests',
      stepAt: 9_000,
      stateAt: { key: 'running', at: 4_000 },
    })
    expect(doingOf(w)).toEqual({
      doing: 'Bash bun test ./server/tests',
      doingSince: 9_000,
      doingKind: 'step',
    })
  })

  test('a running worker says its newest narration over the raw tool event', () => {
    const w = worker({
      status: 'running',
      lastActivity: 'Bash bun test ./server/tests',
      saidLine: 'running the suite now',
      saidAt: 9_500,
      stepAt: 9_000,
      stateAt: { key: 'running', at: 4_000 },
    })
    expect(doingOf(w)).toEqual({
      doing: 'running the suite now',
      doingSince: 9_500,
      doingKind: 'said',
    })
  })

  test('the ETA prefix of a narration line is not shown', () => {
    const w = worker({ status: 'running', saidLine: 'ETA: 3 min. Reading the diff', saidAt: 8_000 })
    expect(doingOf(w).doing).toBe('Reading the diff')
  })

  test('a Monitor or climayte_wait.py step reads as waiting, since the step began', () => {
    const monitor = worker({ status: 'running', lastActivity: 'Monitor build-job', stepAt: 7_000 })
    expect(doingOf(monitor)).toEqual({
      doing: 'Waiting: Monitor build-job',
      doingSince: 7_000,
      doingKind: 'wait',
    })
    const script = worker({
      status: 'running',
      lastActivity: 'Bash python3 climayte_wait.py build',
      stepAt: 7_000,
    })
    expect(doingOf(script).doing).toBe('Waiting: Bash python3 climayte_wait.py build')
  })

  test('a waiting step names the narration that goes with it', () => {
    const w = worker({
      status: 'running',
      lastActivity: 'Monitor build-job',
      saidLine: 'Waiting for the build to finish',
      stepAt: 7_000,
    })
    expect(doingOf(w).doing).toBe('Waiting: Waiting for the build to finish')
  })

  test('a running worker that has not moved since it started counts from the start', () => {
    const w = worker({
      status: 'running',
      saidLine: 'said: reading the diff',
      stepAt: 2_000,
      stateAt: { key: 'running', at: 4_000 },
    })
    expect(doingOf(w).doingSince).toBe(4_000)
  })

  test('a narration line said before this run began is not shown', () => {
    const w = worker({
      status: 'running',
      lastActivity: 'Bash bun test ./server/tests',
      saidLine: 'Committed the change; the report follows',
      saidAt: 3_000,
      stepAt: 9_000,
      stateAt: { key: 'running', at: 4_000 },
    })
    expect(doingOf(w)).toEqual({
      doing: 'Bash bun test ./server/tests',
      doingSince: 9_000,
      doingKind: 'step',
    })
  })

  test('a worker with an open question says so, since the question was asked', () => {
    const w = worker({
      status: 'running',
      lastActivity: 'Bash ls',
      question: { text: 'Which database should I use?\nThe staging one is not set up.', at: 6_000 },
    })
    expect(doingOf(w)).toEqual({
      doing: 'Waiting for your answer: Which database should I use?',
      doingSince: 6_000,
      doingKind: 'hold',
    })
  })

  test('a finished worker has nothing to say', () => {
    expect(doingOf(worker({ status: 'done' }))).toEqual({
      doing: null,
      doingSince: null,
      doingKind: null,
    })
  })

  test('a long line is cut to 120 characters', () => {
    const w = worker({ status: 'running', saidLine: 'x'.repeat(300) })
    expect(doingOf(w).doing!.length).toBe(120)
    expect(doingOf(w).doing!.endsWith('...')).toBe(true)
  })
})

describe('newestSaid', () => {
  test('the newest said line wins, without its prefix', () => {
    expect(newestSaid(['Bash ls', 'said: first', 'Read x', 'said: second', 'finished (ok)'])).toBe(
      'second',
    )
  })

  test('no said line gives null', () => {
    expect(newestSaid(['Bash ls', 'finished (ok)'])).toBeNull()
  })
})

describe('stateKey', () => {
  test('a held worker keeps its key while the figures in its reason change', () => {
    const a = worker({
      status: 'queued',
      error: 'Waiting for CPU: 99% busy over the last 30 s. Nothing running is stopped.',
    })
    const b = worker({
      status: 'queued',
      error: 'Waiting for CPU: 40% busy over the last 30 s. Nothing running is stopped.',
    })
    expect(stateKey(a)).toBe(stateKey(b))
    expect(stateKey(a)).not.toBe(
      stateKey(worker({ status: 'queued', error: 'Waiting for memory: 2 GB free. It starts.' })),
    )
  })

  test('a running worker is keyed by its status alone', () => {
    expect(stateKey(worker({ status: 'running', lastActivity: 'Bash ls' }))).toBe('running')
  })
})
