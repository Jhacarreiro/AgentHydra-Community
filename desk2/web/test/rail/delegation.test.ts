import { describe, expect, test } from 'bun:test'
import type { CliMayteWorker, SwarmJob } from '@shared/protocol'
import { NO_MODEL, delegationStats } from '../../src/components/rail/delegation'

const worker = (id: string, status: string, model: string | null, tokens: number | null): CliMayteWorker =>
  ({ id, title: `task ${id}`, group: null, status, active: status === 'running', account: '#1', model, effort: null, kind: 'code', cwd: null, sessionId: null, originSessionId: 'sess-a', startedAt: 1, endedAt: null, lastActivityAt: null, lastActivity: null, usedPct: null, tokens, verdict: null, error: null }) as CliMayteWorker

const job = (id: string, tasks: { total: number; done: number; failed: number }, active: boolean, status: string, extra: Partial<SwarmJob> = {}): SwarmJob =>
  ({ id, title: `job ${id}`, status, active, startedAt: 1, endedAt: active ? null : 2, tasks: { ...tasks, cancelled: 0 }, callerSessionId: 'sess-a', callerHostSessionId: null, callerTitle: null, pc: null, tokens: null, costUsd: null, models: null, ...extra }) as SwarmJob

describe('delegation stats for one chat', () => {
  test('counts each service by run, model and outcome, sums HSwarm measured tokens and cost, and hides a service with no runs', () => {
    const workers = [
      worker('w1', 'done', 'claude-sonnet-5-5', 120_000),
      worker('w2', 'done', 'claude-sonnet-5-5', 80_000),
      worker('w3', 'failed', 'claude-sonnet-5-5', null),
      worker('w4', 'cancelled', 'claude-haiku-5-5', 5_000),
      worker('w5', 'running', 'claude-haiku-5-5', null),
      worker('w5', 'running', 'claude-haiku-5-5', null) // listed twice by the two reads: counted once
    ]
    const jobs = [
      // the one whose results.jsonl was read: its own model rows, tokens and cost
      job('j1', { total: 10, done: 10, failed: 0 }, false, 'done', {
        tokens: 40_000,
        costUsd: 0.12,
        models: [{ model: 'deepseek-v4-flash', tasks: 10, ok: 9, failed: 1, tokens: 40_000 }]
      }),
      job('j2', { total: 4, done: 3, failed: 1 }, false, 'done'),
      job('j3', { total: 2, done: 0, failed: 0 }, true, 'running')
    ]

    const [hswarm, climayte] = delegationStats(workers, jobs)

    expect(hswarm).toEqual({
      service: 'hswarm',
      label: 'HSwarm',
      runs: 3,
      tasks: 16,
      succeeded: 1,
      failed: 1,
      running: 1,
      models: [
        { model: 'deepseek-v4-flash', tasks: 10, succeeded: 9, failed: 1 },
        { model: NO_MODEL, tasks: 6, succeeded: 3, failed: 1 }
      ],
      tokens: 40_000,
      tokensEst: false,
      costUsd: 0.12
    })
    expect(climayte).toEqual({
      service: 'climayte',
      label: 'CliMayte',
      runs: 5,
      tasks: 5,
      succeeded: 2,
      failed: 2,
      running: 1,
      models: [
        { model: 'claude-sonnet-5-5', tasks: 3, succeeded: 2, failed: 1 },
        { model: 'claude-haiku-5-5', tasks: 2, succeeded: 0, failed: 1 }
      ],
      tokens: 205_000,
      tokensEst: true,
      costUsd: null
    })
    expect(delegationStats([], [])).toEqual([])
    expect(delegationStats([worker('w9', 'done', null, null)], []).map((s) => s.service)).toEqual(['climayte'])
  })
})
