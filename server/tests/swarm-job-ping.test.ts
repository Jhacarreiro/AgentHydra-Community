// An HSwarm job that outlived the call that started it pings that chat once when it finishes
// (swarm-job-ping.ts, through the CliMayte outbox). Owner, 2026-10-12: "Why are you waiting on a 42m
// running task.." after a wait:false job finished and its chat sat idle.
//
// The outbox is the real one with its transports injected; the jobs folder is a scratch folder.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PING_HEADER, startCliMaytePing } from '../src/climayte-ping'
import { startSwarmJobPing } from '../src/swarm-job-ping'

const dirs: string[] = []
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'swarm-job-ping-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const SID = '4138a08f-1111-2222-3333-444455556666'
const NOW = Date.UTC(2026, 9, 12, 21, 0, 0)

function job(
  jobs: string,
  id: string,
  o: { returnedAt?: number; state?: string; climayteWorker?: boolean; seenBy?: string[] } = {},
) {
  mkdirSync(join(jobs, id), { recursive: true })
  // hswarm's stamp for each chat that read the job once it ended, or cancelled it (hswarm/job.py mark_seen).
  if (o.seenBy) mkdirSync(join(jobs, id, 'seen'), { recursive: true })
  for (const s of o.seenBy ?? []) writeFileSync(join(jobs, id, 'seen', s), String(NOW - 60_000))
  const doc = {
    state: o.state ?? 'done',
    finished: '2026-10-12T21:00:00+00:00',
    returned_at: o.returnedAt ?? 0,
    summary: {
      label: 'example research',
      counts: { ok: 3, error: 1 },
      cost_usd: 0.1234,
      results_text: 'SECRET ANSWER',
    },
    caller: {
      instance: 'acct',
      session_id: SID,
      chat_id: `local_${SID}`,
      entrypoint: 'mcp-http',
      climayte_worker: o.climayteWorker ?? false,
    },
    results: { t1: { answer: 'SECRET ANSWER' } },
  }
  writeFileSync(join(jobs, id, 'job.json'), JSON.stringify(doc))
}

/** One daemon life: the real outbox over `dir`, a swarm watcher over `jobs`. */
function daemon(dir: string, jobs: string, peerOk = true) {
  const sent: string[] = []
  const ping = startCliMaytePing({
    dir,
    workers: () => [],
    subscribe: () => () => {},
    climayteSend: () => ({ ok: false, message: 'unused' }),
    deliverPeer: async (_sid, _tr, text) => {
      if (peerOk) sent.push(text)
      return peerOk ? { ok: true, reason: 'enqueued' } : { ok: false, reason: 'no pipe' }
    },
    toast: async () => {},
    journal: () => {},
  })
  const watcher = startSwarmJobPing({
    jobsDir: jobs,
    emit: (o, e) => ping.emit(o, e),
    now: () => NOW,
    setInterval: () => 0,
    clearInterval: () => {},
    homeOf: () => 'C:/fake/.claude',
  })
  return {
    sent,
    scan: async () => {
      watcher.scan()
      await ping.flushNow()
    },
    stop: () => {
      watcher.stop()
      ping.stop()
    },
  }
}

describe('HSwarm job pings', () => {
  test('a job that outlived its call pings its caller once, with facts only', async () => {
    const dir = scratch()
    const jobs = scratch()
    job(jobs, '20261012-203000-abcd', { returnedAt: NOW - 3_000_000 })
    const d = daemon(dir, jobs)
    await d.scan()
    await d.scan()
    d.stop()
    expect(d.sent).toHaveLength(1)
    const text = d.sent[0]
    expect(text).toContain(PING_HEADER)
    expect(text).toContain(
      'HSwarm job 20261012-203000-abcd "example research" done: 3 ok, 1 error, 0 cancelled, $0.12.',
    )
    expect(text).toContain("hswarm_results('20261012-203000-abcd')")
    expect(text).not.toContain('SECRET ANSWER')
  })

  test('a job whose result came back inside the call never pings', async () => {
    const dir = scratch()
    const jobs = scratch()
    job(jobs, '20261012-203000-abcd', { returnedAt: 0 })
    job(jobs, '20261012-203100-abce', { returnedAt: NOW - 1, state: 'running' })
    const d = daemon(dir, jobs)
    await d.scan()
    d.stop()
    expect(d.sent).toEqual([])
  })

  test('an undelivered ping is replayed after a restart, a delivered one is not', async () => {
    const dir = scratch()
    const jobs = scratch()
    job(jobs, '20261012-203000-abcd', { returnedAt: NOW - 3_000_000 })
    const down = daemon(dir, jobs, false)
    await down.scan()
    down.stop()
    expect(down.sent).toEqual([])

    const up = daemon(dir, jobs)
    await up.scan()
    up.stop()
    expect(up.sent).toHaveLength(1)

    const later = daemon(dir, jobs)
    await later.scan()
    later.stop()
    expect(later.sent).toEqual([])
  })

  test('a job its chat already read once it ended, or cancelled, never pings; a read by another chat does not count', async () => {
    // 2026-10-13: a chat that had read one job's results and cancelled another was pinged about both an hour later.
    const dir = scratch()
    const jobs = scratch()
    job(jobs, '20261012-203000-abcd', { returnedAt: NOW - 3_000_000, seenBy: [SID] })
    job(jobs, '20261012-203100-abce', {
      returnedAt: NOW - 3_000_000,
      seenBy: ['0b6f2b0e-2222-4c4c-9a9a-123456789abc'],
    })
    const d = daemon(dir, jobs)
    await d.scan()
    d.stop()
    expect(d.sent).toHaveLength(1)
    expect(d.sent[0]).toContain('20261012-203100-abce')
    expect(d.sent[0]).not.toContain('20261012-203000-abcd')
  })

  test('a job created more than a day ago never pings', async () => {
    const dir = scratch()
    const jobs = scratch()
    job(jobs, '20261010-203000-abcd', { returnedAt: NOW - 90_000_000 })
    const d = daemon(dir, jobs)
    await d.scan()
    d.stop()
    expect(d.sent).toEqual([])
  })
})
