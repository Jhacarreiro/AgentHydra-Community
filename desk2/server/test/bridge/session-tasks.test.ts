// One session's own CliMayte workers and HSwarm jobs (sessionTasks, GET /api/session-tasks/:id): the ones the window's
// lists dropped (they keep the 20 newest finished of the whole PC) stay listed for it, and another session's never
// join them, even from an AgentHydra or HSwarm too old to filter by caller.

import { expect, test } from 'bun:test'
import { createBridge } from '../../src/bridge'
import { startFakeHydra } from './fake-hydra'

const SESSION = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-0000-4000-8000-000000000000'
const CHAT = 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

// HSwarm's jobs list as AgentHydra proxies it (hswarm/console.py _jobs), made up; `n` orders them, newest highest.
const job = (n: number, ids: { session_id?: string; chat_id?: string }) => ({
  job_id: `20261010-0000${String(n).padStart(2, '0')}-ab${n}`,
  label: `Job ${n}`,
  state: 'done',
  tasks: 2,
  counts: { ok: 2 },
  caller: 'default / - / project',
  caller_ids: { session_id: '', chat_id: '', instance: 'default', ...ids },
  created: new Date(Date.UTC(2026, 9, 10, 10, n)).toISOString(),
  finished: new Date(Date.UTC(2026, 9, 10, 10, n, 30)).toISOString(),
})

test("a session's own finished workers and jobs past the window's 20, and nobody else's from an unfiltered answer", async () => {
  const f = await startFakeHydra()
  try {
    const done = f.state.workers.find((w) => w.status === 'done')
    const at = (n: number) => 1_000_000 + n
    const theirs = Array.from({ length: 25 }, (_, i) => ({ ...done, id: `w-theirs-${i}`, group: 'g-theirs', sessionId: null, origin: { kind: 'chat', sessionId: OTHER }, updatedAt: at(100 - i) }))
    const mine = { ...done, id: 'w-mine', group: 'g-mine', sessionId: 'w-mine-session', origin: { kind: 'chat', sessionId: SESSION }, updatedAt: at(1) }
    const child = { ...done, id: 'w-child', group: 'g-mine', sessionId: null, origin: { kind: 'worker', workerId: 'w-mine' }, updatedAt: at(0) }
    // The fake answers every worker, `origin` or not, as an AgentHydra from before it.
    f.state.workers = [...theirs, mine, child]
    f.state.chats = { rows: [{ instance: 'default', chatId: CHAT, sessionId: SESSION, title: 'Example chat', archived: false, lastActivityAt: null, cwd: null, live: false }] }
    // As does this HSwarm: its newest jobs, whatever `session` says. The session's own are its oldest.
    const jobs = [job(1, { chat_id: CHAT }), job(2, { session_id: SESSION }), ...Array.from({ length: 25 }, (_, i) => job(10 + i, { session_id: OTHER }))]
    const asked: URL[] = []
    const origFetch = globalThis.fetch
    const fetchStub = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === '/api/hswarm/api/jobs') {
        asked.push(url)
        return Response.json({ jobs })
      }
      return origFetch(input, init)
    }) as typeof fetch
    const b = createBridge({ url: f.url, now: () => 1_000_000, fetch: fetchStub })

    expect((await b.workers()).map((w) => w.id)).not.toContain('w-mine')
    expect((await b.swarmJobs()).map((j) => j.id)).not.toContain(jobs[0]!.job_id)

    const own = await b.sessionTasks(SESSION)
    expect(own.sessionId).toBe(SESSION)
    expect(own.workers.map((w) => w.id).sort()).toEqual(['w-child', 'w-mine'])
    expect(own.jobs.map((j) => j.id).sort()).toEqual([jobs[0]!.job_id, jobs[1]!.job_id].sort())
    // What a filtering AgentHydra and HSwarm are asked: this session, and the Desktop chat that is it.
    const workersAsk = f.gets.map((g) => new URL(g, f.url)).find((u) => u.pathname === '/api/corch/workers' && u.searchParams.has('origin'))
    expect(workersAsk?.searchParams.get('origin')).toBe(SESSION)
    expect(asked.at(-1)?.searchParams.get('session')?.split(',')).toEqual([SESSION, CHAT])
  } finally {
    await f.stop()
  }
})
