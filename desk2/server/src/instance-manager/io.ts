// The instance manager's reads and acts against the one AgentHydra daemon (the bridge's address) and Desk's own
// outside-session list. Every call is bounded by a timeout and answers null (or an error) rather than throwing, so a
// look that cannot read something judges nothing instead of judging on a guess.
//
// Claude Desktop: the apps and their sign-in come from GET /api/fleet, usage from GET /api/usage/survey, the account
// probe from GET /api/instances/:dir/account, opening from POST /api/instances/:dir/open, and the move from the
// orchestrator's migrate_batch (POST /api/orchestrator/run, polled at /api/orchestrator/operations/:id), the same
// move AgentHydra's move_chats tool runs: it verifies each landing and starts each chat again with `--resume`.
// Codex: GET /api/codex-instances, /:id/usage, /:id/account, POST /:id/desktop/open and /:id/move-chat.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ExternalSession } from '@shared/protocol'
import type { ManagedKind } from '@shared/instance-manager'
import type { AccountProbe, Candidate, SeenInstance, WorkingChat } from './decide'
import type { InstanceManagerIO, Landed, MoveResult } from './engine'

const READ_TIMEOUT_MS = 8_000
/** The usage survey re-reads a stale account and can take seconds. */
const SURVEY_TIMEOUT_MS = 60_000
/** Opening an app waits for its debugger when the profile has one. */
const OPEN_TIMEOUT_MS = 120_000
/** A Codex move copies and verifies one transcript. */
const CODEX_MOVE_TIMEOUT_MS = 120_000
/** The fleet's line: an account at or past it on either window takes no new work (AgentHydra's 85%). */
export const CAP_PCT = 85
/** How much of an app's log is read from its end. */
const LOG_TAIL_BYTES = 512 * 1024

type Json = Record<string, unknown>

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A JSON call to AgentHydra: its answer and status, or null when it did not answer in time. */
async function call(base: string, path: string, init: RequestInit = {}, timeoutMs = READ_TIMEOUT_MS): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body: unknown = await res.json().catch(() => null)
    return { status: res.status, body }
  } catch {
    return null
  }
}

const errorOf = (body: unknown, fallback: string): string => str(obj(body).error) ?? str(obj(body).message) ?? fallback

/** The last `bytes` of a file as text, or null when it cannot be read. */
export function readTail(file: string, bytes = LOG_TAIL_BYTES): string | null {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, bytes)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, size - length)
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** migrate_batch's --json report, from the operation's stdout (its last JSON object when anything printed before). */
export function moveReport(stdout: string): Json | null {
  const text = stdout.trim()
  // A pretty-printed report's inner objects are indented, so only its own first line opens at column 0.
  for (const m of text.matchAll(/(^|\n)\{/g)) {
    try {
      return obj(JSON.parse(text.slice(m.index + m[1].length)))
    } catch {
      // floor-ok: not the report yet; the next line that opens a JSON object is tried
    }
  }
  return null
}

/** One chat's line of migrate_batch's report. */
export function moveResultOf(row: unknown): MoveResult | null {
  const r = obj(row)
  const id = str(r.chat) ?? str(r.sessionId)
  if (!id) return null
  const resume = obj(r.resume)
  return {
    id,
    landed: r.landed === true,
    resumed: resume.delivered === true,
    detail: str(resume.why) ?? str(r.report) ?? str(r.outcome) ?? '',
  }
}

export interface IoOptions {
  /** AgentHydra's address (the bridge's). */
  base: string
  /** Desk's own outside-session list (GET /api/external/sessions), read through Desk's routes. */
  outside: () => Promise<ExternalSession[] | null>
}

export function daemonIO(o: IoOptions): InstanceManagerIO {
  const { base } = o

  async function desktops(): Promise<SeenInstance[] | null> {
    const r = await call(base, '/api/fleet')
    if (!r || r.status !== 200) return null
    const rows = obj(r.body).instances
    if (!Array.isArray(rows)) return null
    return rows.flatMap((row): SeenInstance[] => {
      const i = obj(row)
      const dir = str(i.dir)
      const n = num(i.num)
      if (!dir || n === null) return []
      const account = obj(i.account)
      return [
        {
          ref: str(i.ref) ?? `desktop:${dir}`,
          kind: 'desktop',
          num: n,
          name: str(i.name) ?? dir,
          handle: dir,
          email: str(account.email),
          plan: str(account.planLabel),
          running: i.isRunning === true,
          signedIn: i.signedIn === true && account.status !== 'loggedout',
        },
      ]
    })
  }

  async function codexes(): Promise<SeenInstance[] | null> {
    const r = await call(base, '/api/codex-instances')
    if (!r || r.status !== 200 || !Array.isArray(r.body)) return null
    return r.body.flatMap((row): SeenInstance[] => {
      const i = obj(row)
      const id = str(i.id)
      const n = num(i.num)
      if (!id || n === null || i.isExternal === true) return []
      const account = obj(i.account)
      return [
        {
          ref: `codex:${id}`,
          kind: 'codex',
          num: n,
          name: str(i.name) ?? id,
          handle: id,
          email: str(account.email),
          plan: str(account.planLabel) ?? str(account.planType),
          running: i.isDesktopRunning === true,
          signedIn: i.loggedIn === true,
        },
      ]
    })
  }

  return {
    async instances() {
      const [d, c] = await Promise.all([desktops(), codexes()])
      // Both or nothing: a Codex list that did not load would read as every Codex app gone.
      return d === null || c === null ? null : [...d, ...c]
    },

    async working(seen) {
      const list = await o.outside()
      if (list === null) return null
      // A Desktop session names its app by the profile's name, its folder or its number.
      const desktop = seen.filter((i) => i.kind === 'desktop')
      const byName = new Map(desktop.map((i) => [i.name.toLowerCase(), i.ref]))
      const byFolder = new Map(desktop.map((i) => [basename(i.handle).toLowerCase(), i.ref]))
      const byNum = new Map(desktop.map((i) => [String(i.num), i.ref]))
      return list.flatMap((s): WorkingChat[] => {
        if (s.status !== 'working' || s.fromPc) return []
        if (s.source === 'desktop') {
          const key = (s.instance ?? '').toLowerCase().replace(/^#/, '')
          const ref = byName.get(key) ?? byFolder.get(key) ?? byNum.get(key)
          return ref ? [{ id: s.id, title: s.title, ref }] : []
        }
        if (s.source === 'codex' && s.codexAccountId) return [{ id: s.id, title: s.title, ref: `codex:${s.codexAccountId}` }]
        return []
      })
    },

    async candidates(kind: ManagedKind, seen) {
      if (kind === 'desktop') {
        const r = await call(base, '/api/usage/survey', {}, SURVEY_TIMEOUT_MS)
        const rows = r && r.status === 200 ? obj(r.body).rows : null
        const byNum = new Map<number, Json>()
        if (Array.isArray(rows)) for (const row of rows) if (obj(row).kind === 'desktop' && num(obj(row).num) !== null) byNum.set(num(obj(row).num) as number, obj(row))
        return seen
          .filter((i) => i.kind === 'desktop')
          .map((instance): Candidate => {
            const row = byNum.get(instance.num)
            const snap = obj(obj(row?.result).snapshot)
            const advice = obj(row?.advice ?? obj(row?.result).advice)
            const weeklyPct = num(obj(snap.weekAll).pct)
            return {
              instance,
              fiveHourPct: num(obj(snap.session).pct),
              weeklyPct,
              capPct: CAP_PCT,
              known: row !== undefined && advice.severity !== 'unknown' && weeklyPct !== null,
            }
          })
      }
      const codex = seen.filter((i) => i.kind === 'codex' && i.signedIn)
      return Promise.all(
        codex.map(async (instance): Promise<Candidate> => {
          const r = await call(base, `/api/codex-instances/${encodeURIComponent(instance.handle)}/usage`)
          const snap = obj(obj(r?.body).snapshot)
          const weeklyPct = num(obj(snap.weekAll).pct)
          return {
            instance,
            fiveHourPct: num(obj(snap.session).pct),
            weeklyPct,
            capPct: CAP_PCT,
            known: r?.status === 200 && weeklyPct !== null,
          }
        }),
      )
    },

    async probe(inst) {
      const path =
        inst.kind === 'desktop'
          ? `/api/instances/${encodeURIComponent(inst.handle)}/account`
          : `/api/codex-instances/${encodeURIComponent(inst.handle)}/account`
      const r = await call(base, path, {}, 30_000)
      if (!r || r.status !== 200) return null
      const a = obj(r.body)
      return { status: str(a.status) ?? 'unknown', plan: str(a.planLabel) ?? str(a.planType) ?? str(a.plan) }
    },

    async appLog(inst) {
      return inst.kind === 'desktop' ? readTail(join(inst.handle, 'logs', 'main.log')) : null
    },

    async open(inst) {
      const path =
        inst.kind === 'desktop'
          ? `/api/instances/${encodeURIComponent(inst.handle)}/open`
          : `/api/codex-instances/${encodeURIComponent(inst.handle)}/desktop/open`
      const r = await call(base, path, { method: 'POST', body: JSON.stringify({ raise: false }) }, OPEN_TIMEOUT_MS)
      if (!r) return { ok: false, detail: 'AgentHydra did not answer' }
      const b = obj(r.body)
      return { ok: r.status === 200 && b.ok === true, detail: str(b.message) ?? str(b.error) ?? `answered ${r.status}` }
    },

    async startMove(from, to, ids, text, key, terminateLive) {
      if (from.kind === 'codex') return moveCodex(from, to, ids)
      const args = ['--from', String(from.num), '--to', String(to.num), '--stop-idle', '--now', '--idle-wait', '0', '--json']
      for (const id of ids) args.push('--chat', id)
      args.push('--resume', text)
      if (terminateLive) args.push('--terminate-live')
      // AgentHydra's move_chats budgets each chat its wait, its move and its resume; the same here.
      const timeoutMs = Math.min(3_600_000, (ids.length * (90 + 75 + (terminateLive ? 60 : 0)) + 180) * 1000)
      const r = await call(
        base,
        '/api/orchestrator/run',
        { method: 'POST', headers: { 'x-idempotency-key': key }, body: JSON.stringify({ script: 'migrate_batch', args, async: true, timeoutMs }) },
        30_000,
      )
      if (!r) return { error: 'AgentHydra did not answer', busy: true }
      const b = obj(r.body)
      if (r.status === 202 && str(b.operationId)) return { operationId: str(b.operationId) as string }
      if (r.status === 409) return { error: errorOf(r.body, 'another move holds the route'), busy: true }
      return { error: errorOf(r.body, `answered ${r.status}`) }
    },

    async moveResult(operationId) {
      const r = await call(base, `/api/orchestrator/operations/${encodeURIComponent(operationId)}`)
      if (!r) return null
      if (r.status === 404) return { error: errorOf(r.body, 'AgentHydra no longer has this move (it restarted)') }
      const op = obj(r.body)
      if (op.status === 'running') return null
      const result = obj(op.result)
      if (str(result.error)) return { error: str(result.error) as string }
      const report = moveReport(str(result.stdout) ?? '')
      if (!report) return { error: `the move printed no report (exit ${String(result.exitCode)}): ${(str(result.stderr) ?? '').slice(-300)}` }
      const rows = Array.isArray(report.results) ? report.results : []
      return { results: rows.map(moveResultOf).filter((m): m is MoveResult => m !== null) }
    },

    async chatsIn(inst, ids, since) {
      const want = new Set(ids)
      const out = new Map<string, Landed>()
      if (inst.kind === 'desktop') {
        const r = await call(base, `/api/chats?instance=${inst.num}&archived=include&limit=1000`, {}, 30_000)
        const rows = r && r.status === 200 ? obj(r.body).rows : null
        if (!Array.isArray(rows)) return null
        for (const row of rows) {
          const c = obj(row)
          const id = str(c.sessionId)
          if (!id || !want.has(id)) continue
          const at = Date.parse(str(c.lastActivityAt) ?? '')
          out.set(id, { archived: c.isArchived === true || c.archived === true, activeSince: Number.isFinite(at) && at > since })
        }
        return out
      }
      const list = await o.outside()
      if (list === null) return null
      for (const s of list) {
        if (s.source !== 'codex' || s.codexAccountId !== inst.handle || !want.has(s.id)) continue
        out.set(s.id, { archived: false, activeSince: (s.lastActivityAt ?? 0) > since })
      }
      return out
    },

    now: () => Date.now(),
  }

  async function moveCodex(from: SeenInstance, to: SeenInstance, ids: string[]): Promise<{ results: MoveResult[] } | { error: string }> {
    const fromId = encodeURIComponent(from.handle)
    const plan = await call(base, `/api/codex-instances/${fromId}/move-chats?targetId=${encodeURIComponent(to.handle)}`, {}, 60_000)
    if (!plan || plan.status !== 200) return { error: plan ? errorOf(plan.body, `answered ${plan.status}`) : 'AgentHydra did not answer' }
    const p = obj(plan.body)
    const chats = Array.isArray(p.chats) ? p.chats.map(obj) : []
    const results: MoveResult[] = []
    for (const id of ids) {
      const chat = chats.find((c) => c.id === id)
      if (!chat) {
        results.push({ id, landed: false, resumed: false, detail: 'it is not among the Codex account’s open chats' })
        continue
      }
      const r = await call(
        base,
        `/api/codex-instances/${fromId}/move-chat`,
        {
          method: 'POST',
          body: JSON.stringify({
            targetId: to.handle,
            threadId: id,
            updatedAt: num(chat.updatedAt) ?? 0,
            sourceAccountId: str(p.sourceAccountId),
            targetAccountId: str(p.targetAccountId),
          }),
        },
        CODEX_MOVE_TIMEOUT_MS,
      )
      const b = obj(r?.body)
      if (r && r.status === 200 && b.ok === true)
        results.push({ id, landed: true, resumed: false, detail: '', newId: str(b.destinationThreadId) ?? undefined })
      else results.push({ id, landed: false, resumed: false, detail: r ? errorOf(r.body, `answered ${r.status}`) : 'AgentHydra did not answer' })
    }
    return { results }
  }
}
