// The orchestrator's stuck-worker net (plugins/70-orchestrator.ts, orchestrator/stuck.ts): a CliMayte worker that sat 'done'
// with an unanswered question past 2 h is nudged to its origin chat once, or cancelled when no such chat is left.
// Stand-in engine routes; nothing outside the temp home is read or written.

import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { ChatSummary, CliMayteWorker } from '@shared/protocol'
import type { OrchestratorPlan } from '@shared/orchestrator'
import type { ServerContext } from '../../src/context'
import plugin from '../../src/plugins/70-orchestrator'

const NOW = Date.now()
const MIN = 60_000
const temps: string[] = []
const stops: (() => void)[] = []
afterEach(() => {
  setSystemTime()
  for (const s of stops.splice(0)) s()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const worker = (over: Partial<CliMayteWorker>): CliMayteWorker => ({
  id: 'w-0000abcd', title: 'Example wave task', description: null, group: 'g-1', status: 'done', active: false, account: null, model: null, effort: null,
  kind: null, cwd: null, sessionId: null, originSessionId: 'sess-origin', startedAt: NOW - 5 * 3_600_000, endedAt: NOW - 3 * 3_600_000,
  lastActivityAt: NOW - 3 * 3_600_000, lastActivity: null, usedPct: null, tokens: null, verdict: null, error: null, ...over
})
const asked = (ago: number): Partial<CliMayteWorker> => ({ question: { text: 'Which branch should I use?', at: NOW - ago } })

function chat(): ChatSummary {
  return {
    id: 'origin-chat', sessionId: 'sess-origin', title: 'Example chat', cwd: '/work/repo', account: { id: 'default', label: '#1', configDir: null }, accountAuto: false,
    model: null, effort: null, permissionMode: 'default', delegateToCliMayte: false, status: 'idle', activity: null, turnStartedAt: null,
    lastError: null, limitResetsAt: null, unread: false, pinned: false, archived: false, group: null, forkedFrom: null, createdAt: NOW - 9 * 3_600_000,
    updatedAt: NOW - 4 * 3_600_000, costUsd: 0, contextPct: null, pendingCount: 0, queuedCount: 0, climayteActive: 0
  }
}

function desk(workers: CliMayteWorker[], chats: ChatSummary[], failQueue = false) {
  const app = new Hono()
  const queued: { chatId: string; text: string }[] = []
  const cancelled: string[] = []
  app.post('/api/queue', async (c) => {
    queued.push((await c.req.json()) as { chatId: string; text: string })
    return failQueue ? c.json({ error: 'queue is down' }, 500) : c.json({ id: 'q' })
  })
  app.get('/api/queue', (c) => c.json({ items: [], paused: false, sendMode: 'immediate', maxNewChats: 1, held: {}, rev: 0 }))
  app.get('/api/chats', (c) => c.json(chats))
  app.get('/api/chats/:id/items', (c) => c.json([]))
  app.get('/api/external/sessions', (c) => c.json([]))
  app.get('/api/climayte/workers', (c) => c.json(workers))
  app.post('/api/climayte/workers/:id/cancel', (c) => {
    cancelled.push(c.req.param('id'))
    return c.json({ ok: true })
  })
  const home = mkdtempSync(join(tmpdir(), 'orch-stuck-'))
  temps.push(home)
  const settings = { orchestrator: false, orchestratorModel: 'opus' }
  plugin(app, {
    home,
    onStop: (fn: () => void) => stops.push(fn),
    settings: () => settings,
    updateSettings: (p: object) => Object.assign(settings, p),
    deps: { orchestratorAsk: async () => ({ text: JSON.stringify({ verdict: 'leave', message: '', why: 'x' }), resolved: null }) }
  } as unknown as ServerContext)
  const arm = async (): Promise<OrchestratorPlan> =>
    (await (await app.request('/api/diagnostics/orchestrator', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ armed: true }) })).json()) as OrchestratorPlan
  return { arm, queued, cancelled }
}

test('a done worker with a 3 h old question is nudged to its origin chat once, naming its id and question', async () => {
  const { arm, queued, cancelled } = desk([worker(asked(3 * 3_600_000))], [chat()])
  await arm()
  expect(queued).toHaveLength(1)
  expect(queued[0]!.chatId).toBe('origin-chat')
  expect(queued[0]!.text).toContain('w-0000abcd')
  expect(queued[0]!.text).toContain('Which branch should I use?')
  expect(queued[0]!.text).toContain('climayte_send w-0000abcd')
  setSystemTime(new Date(NOW + 11 * MIN))
  await arm()
  expect([queued.length, cancelled]).toEqual([1, []])
})

test('the same stuck worker with no origin chat is cancelled once instead', async () => {
  const { arm, queued, cancelled } = desk([worker({ ...asked(3 * 3_600_000), originSessionId: null })], [chat()])
  await arm()
  setSystemTime(new Date(NOW + 11 * MIN))
  await arm()
  expect([queued, cancelled]).toEqual([[], ['w-0000abcd']])
})

test('a worker waiting on a usage wall that is still ahead, or stuck only 1 h, is left alone', async () => {
  const ahead = worker({ id: 'w-0000aaaa', status: 'waiting', active: true, waitUntil: new Date(NOW + 20 * MIN).toISOString(), lastActivityAt: NOW - 5 * 3_600_000 })
  const recent = worker({ id: 'w-0000bbbb', ...asked(60 * MIN) })
  const { arm, queued, cancelled } = desk([ahead, recent], [chat()])
  await arm()
  expect([queued, cancelled]).toEqual([[], []])
})

test('a nudge that fails is retried only after its backoff and logs one error row per attempt, not one per tick', async () => {
  const { arm, queued } = desk([worker(asked(3 * 3_600_000))], [chat()], true)
  const rows = async (): Promise<number> => (await arm()).acts.filter((a) => a.error).length
  expect(await rows()).toBe(1)
  setSystemTime(new Date(NOW + 5 * MIN))
  expect([await rows(), queued.length]).toEqual([1, 1])
  setSystemTime(new Date(NOW + 11 * MIN))
  expect([await rows(), queued.length]).toEqual([2, 2])
  setSystemTime(new Date(NOW + 30 * MIN))
  expect([await rows(), queued.length]).toEqual([2, 2])
  setSystemTime(new Date(NOW + 42 * MIN))
  expect([await rows(), queued.length]).toEqual([3, 3])
})
