// The orchestrator's waiting case (plugins/70-orchestrator.ts, orchestrator/plan.ts): an idle chat whose last reply says it
// waits on an HSwarm job gets one nudge once the job is done and the chat has sat WAIT_MS. Stand-in engine routes, a stand-in
// judge and a job folder in a temp dir; nothing outside it is read or written.

import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import type { OrchestratorPlan } from '@shared/orchestrator'
import type { ServerContext } from '../../src/context'
import plugin from '../../src/plugins/70-orchestrator'
import { WAIT_MS } from '../../src/orchestrator/plan'

const NOW = Date.now()
const MIN = 60_000
const temps: string[] = []
const stops: (() => void)[] = []
afterEach(() => {
  setSystemTime()
  for (const s of stops.splice(0)) s()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const DONE = '20261012-205500-a1b2'
const RUNNING = '20261012-205600-c3d4'
const FINISHED = '2026-10-12T21:00:00+00:00'

/** An HSwarm job folder: finished with counts, or still running. */
function jobs(): string {
  const home = mkdtempSync(join(tmpdir(), 'orch-waiting-'))
  temps.push(home)
  const write = (id: string, job: object): void => {
    mkdirSync(join(home, 'jobs', id), { recursive: true })
    writeFileSync(join(home, 'jobs', id, 'job.json'), JSON.stringify(job))
  }
  write(DONE, { state: 'done', finished: FINISHED, summary: { created: '2026-10-12T20:55:00+00:00', finished: FINISHED, counts: { ok: 14, error: 2 } } })
  write(RUNNING, { state: 'running', finished: '', summary: { created: new Date(NOW - 30 * MIN).toISOString(), finished: '', counts: { running: 3 } } })
  return home
}

function chat(id: string, ago: number): ChatSummary {
  return {
    id, sessionId: null, title: id, cwd: '/work/repo', account: { id: 'default', label: '#1', configDir: null }, accountAuto: false,
    model: null, effort: null, permissionMode: 'default', delegateToCliMayte: false, status: 'idle', activity: null, turnStartedAt: null,
    lastError: null, limitResetsAt: null, unread: false, pinned: false, archived: false, group: null, forkedFrom: null, createdAt: NOW - 3_600_000,
    updatedAt: NOW - ago, costUsd: 0, contextPct: null, pendingCount: 0, queuedCount: 0, climayteActive: 0
  }
}
const said = (job: string, ago: number): TranscriptItem => ({ id: `a-${job}`, ts: NOW - ago, kind: 'assistant_text', text: `Started the sweep as HSwarm job ${job}. I'll pick the results up when it finishes.` })
const wrote = (ago: number): TranscriptItem => ({ id: `u${ago}`, ts: NOW - ago, kind: 'user', text: 'go ahead' })

function desk(chats: [ChatSummary, TranscriptItem[]][]) {
  const app = new Hono()
  const queued: { chatId: string; text: string }[] = []
  const asked: string[] = []
  app.post('/api/queue', async (c) => {
    queued.push((await c.req.json()) as { chatId: string; text: string })
    return c.json({ id: 'q' })
  })
  app.get('/api/queue', (c) => c.json({ items: [], paused: false, sendMode: 'immediate', maxNewChats: 1, held: {}, rev: 0 }))
  app.get('/api/chats', (c) => c.json(chats.map(([ch]) => ch)))
  app.get('/api/chats/:id/items', (c) => c.json(chats.find(([ch]) => ch.id === c.req.param('id'))?.[1] ?? []))
  app.get('/api/external/sessions', (c) => c.json([]))
  const settings = { orchestrator: false, orchestratorModel: 'opus' }
  const ask = async (req: { brief: { id: string; signals: string[] } }): Promise<{ text: string; resolved: string | null }> => {
    asked.push(req.brief.id)
    const job = req.brief.signals.join(' ').match(/job (\d{8}-\d{6}-[0-9a-f]{4}) finished/)?.[1]
    const message = job ? `The HSwarm job ${job} you were waiting on finished at 21:00Z (14 ok, 2 error). Pick it up: hswarm_results('${job}').` : ''
    return { text: JSON.stringify(job ? { verdict: 'nudge', message, why: 'its job finished' } : { verdict: 'leave', message: '', why: 'nothing to say' }), resolved: 'claude-opus-5-5' }
  }
  plugin(app, {
    onStop: (fn: () => void) => stops.push(fn),
    settings: () => settings,
    updateSettings: (p: object) => Object.assign(settings, p),
    deps: { orchestratorAsk: ask, hswarmHome: jobs() }
  } as unknown as ServerContext)
  const arm = async (): Promise<OrchestratorPlan> =>
    (await (await app.request('/api/diagnostics/orchestrator', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ armed: true }) })).json()) as OrchestratorPlan
  return { arm, queued, asked }
}

test('an idle chat waiting on a finished HSwarm job gets one nudge naming it, and a second look sends nothing more', async () => {
  const { arm, queued, asked } = desk([[chat('sweeper', 30 * MIN), [wrote(40 * MIN), said(DONE, 30 * MIN)]]])
  const first = await arm()
  expect(first.rows.find((r) => r.id === 'sweeper')).toMatchObject({ move: 'waiting', waitingOn: [DONE] })
  expect(queued).toHaveLength(1)
  expect(queued[0]!.chatId).toBe('sweeper')
  expect(queued[0]!.text).toContain(`The HSwarm job ${DONE} you were waiting on finished at 21:00Z (14 ok, 2 error)`)
  expect(first.acts.map((a) => [a.id, a.move, a.did])).toEqual([['sweeper', 'waiting', 'nudged']])
  // Eleven minutes later the judge would be due again: the one nudge for this job is spent.
  setSystemTime(new Date(NOW + 11 * MIN))
  expect((await arm()).acts).toHaveLength(1)
  expect([queued.length, asked.length]).toEqual([1, 1])
})

test('nothing is sent before WAIT_MS, after a person wrote since its last turn, or while the job still runs', async () => {
  expect(WAIT_MS).toBe(20 * MIN)
  const { arm, queued, asked } = desk([
    [chat('early', 5 * MIN), [wrote(40 * MIN), said(DONE, 5 * MIN)]],
    [chat('answered', 30 * MIN), [said(DONE, 40 * MIN), wrote(30 * MIN)]],
    [chat('running', 30 * MIN), [wrote(40 * MIN), said(RUNNING, 30 * MIN)]]
  ])
  const plan = await arm()
  expect([queued, asked, plan.acts]).toEqual([[], [], []])
  expect(Object.fromEntries(plan.rows.map((r) => [r.id, r.move]))).toMatchObject({ early: 'done', answered: 'done', running: 'waiting' })
})
