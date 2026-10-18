/**
 * An HSwarm job that outlived the call that started it pings that chat when it finishes (owner,
 * 2026-10-12: a `wait: false` job finished and its chat sat idle for 42 minutes).
 *
 * hswarm stamps `returned_at` (epoch ms) in `<jobs>/<id>/job.json` when `hswarm_run` hands back a job
 * that is still running (hswarm/mcp_server.py), so this reads a fact: a job with no stamp had its
 * result inside the call and never pings. The line goes through the CliMayte outbox (climayte-ping.ts
 * `emit`): Desk 2's ping route, the peer pipe, the retries, the composer and the toast, batched with
 * CliMayte lines to the same chat, and the kill switch `<dir>/ping-off` stops it.
 *
 * Once per job, ever: the event key `swarm:<id>` is recorded pending before the send and delivered
 * once by the outbox, which a daemon restart replays. Only jobs created in the last 24 h are looked
 * at, found by the date in the folder's name; a job.json is read in full only once it is final.
 * A caller that is itself a CliMayte worker is not pinged (its stamp holds no worker id).
 *
 * Nor is a chat that has seen how the job ended: hswarm writes `<jobs>/<id>/seen/<session id>` (epoch ms) when
 * a chat reads a final job's status or results, or cancels it (hswarm/job.py mark_seen). On 2026-10-13 a chat that had
 * read one job and cancelled another was pinged about both an hour later. The outbox asks again (seenByChat) before a
 * line that waited on a busy chat goes out.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type CliMayteOrigin, type PingEvent, SWARM_KEY } from './climayte-ping'

export const SWARM_POLL_MS = 30_000
export const SWARM_MAX_AGE_MS = 24 * 3_600_000
const HEAD_BYTES = 4096
const LABEL_MAX = 80
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** `20261012-214624-d894`: the UTC second the job was created. */
const JOB_ID = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]+$/

export interface SwarmJobPingDeps {
  /** ~/.hswarm/jobs */
  jobsDir: string
  /** The outbox's emit (CliMaytePing.emit). */
  emit(origin: CliMayteOrigin, events: PingEvent[]): boolean
  /** Whether `<dir>/ping-off` exists (the outbox refuses while it does; those jobs are looked at again). */
  off?(): boolean
  now?(): number
  setInterval?(fn: () => void, ms: number): unknown
  clearInterval?(h: unknown): void
  /** The Claude home of a caller's instance name. */
  homeOf?(instance: string): string
}

export interface SwarmJobPing {
  /** Look at the recent jobs now. */
  scan(): void
  stop(): void
}

const defaultHome = (instance: string): string => {
  const inst = join(homedir(), '.claude-instances', instance)
  return instance && existsSync(inst) ? inst : join(homedir(), '.claude')
}

/** When the folder's job was created, from its name; null when the name is not a job id. */
export function jobCreatedAt(id: string): number | null {
  const m = JOB_ID.exec(id)
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null
}

/** state and returned_at, from the first bytes of job.json (hswarm writes both before the summary). */
function peek(file: string): { state: string; returnedAt: number } | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const head = buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8')
    const state = /"state":\s*"([^"]*)"/.exec(head)?.[1]
    if (state === undefined) return null
    return { state, returnedAt: Number(/"returned_at":\s*(\d+)/.exec(head)?.[1] ?? 0) }
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Whether this chat has seen how the job ended: hswarm's stamp `seen/<session id>` is beside the job. */
export function seenByChat(jobsDir: string, id: string, sessionId: string): boolean {
  return UUID.test(sessionId) && existsSync(join(jobsDir, id, 'seen', sessionId))
}

export function startSwarmJobPing(deps: SwarmJobPingDeps): SwarmJobPing {
  const now = deps.now ?? Date.now
  const setIv =
    deps.setInterval ??
    ((fn, ms) => {
      const t = setInterval(fn, ms)
      t.unref?.()
      return t
    })
  const clearIv = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))
  const homeOf = deps.homeOf ?? defaultHome
  /** Jobs settled for this daemon's life: pinged, or never to be. The outbox's key keeps the rest. */
  const settled = new Set<string>()

  const look = (id: string) => {
    const file = join(deps.jobsDir, id, 'job.json')
    const head = peek(file)
    if (!head || head.state === 'running') return
    if (!head.returnedAt) {
      settled.add(id) // its result came back inside the call
      return
    }
    let doc: Record<string, unknown>
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return // half-written: the next look
    }
    const caller = (doc.caller ?? {}) as Record<string, unknown>
    const sessionId = typeof caller.session_id === 'string' ? caller.session_id : ''
    if (
      !UUID.test(sessionId) ||
      caller.climayte_worker === true ||
      seenByChat(deps.jobsDir, id, sessionId)
    ) {
      settled.add(id)
      return
    }
    const summary = (doc.summary ?? {}) as Record<string, unknown>
    const counts = (summary.counts ?? {}) as Record<string, unknown>
    const label = String(summary.label ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, LABEL_MAX)
    const state = String(doc.state)
    const cost = n(summary.cost_usd)
    const origin: CliMayteOrigin = {
      kind: 'chat',
      sessionId,
      home: homeOf(typeof caller.instance === 'string' ? caller.instance : ''),
      transcript: null,
      how: 'hswarm job caller',
    }
    const line =
      `HSwarm job ${id}${label ? ` "${label}"` : ''} ${state}: ${n(counts.ok)} ok, ` +
      `${n(counts.error)} error, ${n(counts.cancelled)} cancelled, $${cost.toFixed(2)}. ` +
      `Read it with hswarm_results('${id}').`
    const queued = deps.emit(origin, [
      { key: `${SWARM_KEY}${id}`, kind: 'swarm-job', workerId: null, group: '', at: now(), line },
    ])
    // Not queued: the outbox has this key already, or pings are switched off (looked at again).
    if (queued || !deps.off?.()) settled.add(id)
  }

  const scan = () => {
    let names: string[]
    try {
      names = readdirSync(deps.jobsDir)
    } catch {
      return
    }
    const t = now()
    for (const id of names) {
      if (settled.has(id)) continue
      const created = jobCreatedAt(id)
      if (created === null || t - created > SWARM_MAX_AGE_MS) continue
      try {
        look(id)
      } catch {
        // one unreadable job never stops the rest
      }
    }
  }

  scan()
  const timer = setIv(scan, SWARM_POLL_MS)
  return {
    scan,
    stop: () => clearIv(timer),
  }
}
