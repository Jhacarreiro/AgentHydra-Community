// The orchestrator: GET /api/diagnostics/orchestrator lists every open chat and outside session (a Claude Desktop,
// CLI, CliMayte or Codex session AgentHydra knows) active in the last `?days=` days (3 by default) with the one move
// the orchestrator would make next and why; `?ask=1` also asks the CreAitor, when this machine has it, what the owner
// would answer each one that waits on a question. Phase A, shadow: that is all it does. Phase B, armed: the
// `orchestrator` setting (Settings > Managers, beside the babysitter's switch; or POST the same path { armed }), off by
// default and kept until it is turned off (owner, 2026-10-09: "I may not always want the foreman on ... but sometimes I
// might want it on"). Armed, it looks every TICK_MS, and a model judges each chat that needs it (orchestrator/judge.ts):
// every running chat due a peek, and every Desk chat an error stopped. The model's verdict decides; its message goes
// through the send queue or the outside session's message route. The rules stay as its inputs and its hard limits
// (orchestrator/act.ts, foreman.ts): a usage limit's stop is the babysitter's (plugins/72-babysitter.ts), a chat a person
// wrote in is left alone, and a chat gets two check-ins an hour at most. It never acts blind: no read of Desk's chats,
// no act. Own page only, and GET /api/orchestrator/model says which model the judge asks.
// README "What Desk 2 adds", the orchestrator.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Hono } from 'hono'
import type { AccountInfo, ChatSummary, CliMayteWorker, ExternalSession, QueueState, TranscriptItem } from '@shared/protocol'
import { ORCHESTRATOR_FROM, type OrchestratorAct, type OrchestratorArm, type OrchestratorJudgment, type OrchestratorPlan, type OrchestratorRow } from '@shared/orchestrator'
import type { ServerContext } from '../context'
import { claudeCodeBinaryFor } from '../engine/claude-code-binary'
import { DIAGNOSTICS_API } from '../engine/diagnostics'
import { afterGivingUp, decide } from '../orchestrator/act'
import { askCreaitor, creaitorTool } from '../orchestrator/creaitor'
import { DEFAULT_ACCOUNT, ROOM_PCT } from '../bridge/accounts'
import { pickHealthy } from '../engine/chat-manager'
import {
  askOf,
  CONTEXT_STEPS,
  JUDGE_TIMEOUT_MS,
  judgeChat,
  recentText,
  sdkAskModel,
  stepBudget,
  transcriptChars,
  type AskModel,
  type JudgeBrief,
  type JudgeResult
} from '../orchestrator/judge'
import { NOTES_PER_HOUR, PEEK_MS, peek, personRecent, type Peek } from '../orchestrator/foreman'
import { classify, fromChat, fromExternal, rank, WAIT_MS } from '../orchestrator/plan'
import { stuckWorkers } from '../orchestrator/stuck'
import { notOwnPage } from '../own-page'

const WHAT = "the orchestrator's plan"
/** At most this many chats and outside sessions are read per plan, the most recently active first. */
const MAX_CHATS = 100
/** CreAitor asks run this many at once. */
const ASK_WIDTH = 4
/** The judge asks at most this many models at once (each one a 90 s call at most). */
const JUDGE_WIDTH = 3
/** Bun closes a request that sends nothing for 10 s, and one ask may take a minute: while the CreAitor answers, the
 *  reply sends a space this often ahead of its JSON, which JSON allows. */
const KEEPALIVE_MS = 4_000
const DEFAULT_DAYS = 3
/** How often the armed orchestrator looks at Desk's chats. */
const TICK_MS = 60_000
/** Acts kept for the page. */
const ACTS_KEPT = 50
const HOUR_MS = 3_600_000
/** The wait before a stuck worker's failed nudge or cancel is tried again: after the first failure, the second, then each later one. */
const STUCK_BACKOFF_MS = [10 * 60_000, 30 * 60_000, 2 * HOUR_MS]
/** A job or worker still running this long after a chat began waiting on it is overdue, and its chat is judged anyway. */
const WAIT_OVERDUE_MS = 6 * HOUR_MS
/** Judgments kept for the page. */
const JUDGED_KEPT_MS = 24 * HOUR_MS
/** A judge error that is the account's login being refused, worth one try on another account. */
const LOGIN_REFUSED = /authenticat|oauth|log ?in|sign(?:ed)? ?in|credential/i
/** Accounts one judgment tries, moving on only when a login is refused. */
const JUDGE_ACCOUNT_TRIES = 3

/** A JSON reply whose body is still being worked out, kept open with a space every KEEPALIVE_MS. */
function slowJson(work: Promise<unknown>): Response {
  const enc = new TextEncoder()
  let tick: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(out) {
      tick = setInterval(() => out.enqueue(enc.encode(' ')), KEEPALIVE_MS)
      return work.then(
        (value) => {
          clearInterval(tick)
          out.enqueue(enc.encode(JSON.stringify(value)))
          out.close()
        },
        (err: unknown) => {
          clearInterval(tick)
          out.error(err)
        }
      )
    },
    cancel() {
      clearInterval(tick)
    }
  })
  return new Response(body, { headers: { 'content-type': 'application/json; charset=UTF-8' } })
}

/** One chat the judge looks at this tick: a Desk chat an error stopped (`error`), or a running one due a peek. */
interface Candidate {
  id: string
  title: string
  source: OrchestratorRow['source']
  status: string
  kind: 'error' | 'running' | 'waiting'
  items: readonly TranscriptItem[]
  /** The rules' findings, in words, for the judge. */
  signals: string[]
  /** A running chat the foreman's rule finds stalled: its note would queue behind a turn that stopped answering. */
  stalled: boolean
  /** An error chat: how many continues it has had once this one is sent (act.ts). */
  count: number
  /** A waiting chat: what it waits on (the key of its one nudge), and what could be checked about it. */
  waitingOn?: string[]
}

/** What the orchestrator found out about one thing a chat waits on, without a model. */
interface Fact {
  /** The line for the judge. */
  text: string
  /** Still running and not yet overdue: its chat is left alone. */
  running: boolean
}

const HSWARM_JOB = /^\d{8}-\d{6}-[0-9a-f]{4}$/
const WORKER_ID = /^w-[0-9a-f]{8}$/
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

export default function plugin(app: Hono, ctx: ServerContext): void {
  let stopped = false
  const armed = (): boolean => !stopped && ctx.settings().orchestrator === true
  let ticking: Promise<void> | null = null
  /** Chat id -> continues sent since its last good turn (act.ts decide). */
  const tries = new Map<string, number>()
  const acts: OrchestratorAct[] = []
  /** Chat id -> the judge's latest judgment of it, shown on its row. */
  const judgments = new Map<string, OrchestratorJudgment>()
  /** Chat id -> the check-ins and continues the judge sent it, newest last (an hour's worth). */
  const sends = new Map<string, { at: number; kind: 'note' | 'continue' }[]>()
  /** Chat id -> the things it waited on that got their one nudge (a waiting chat's waitingOn, joined). */
  const nudged = new Map<string, Set<string>>()
  /** "<worker id>|<reason>" -> already acted on (a nudge or a cancel), kept in a file so a restart does not repeat it. */
  const stuckFile = typeof ctx.home === 'string' ? join(ctx.home, 'orchestrator-stuck.json') : null
  /** "<worker id>|<reason>" -> failed attempts so far and the earliest time of the next one. */
  const stuckRetry = new Map<string, { fails: number; next: number }>()
  const stuckDone = new Set<string>()
  try {
    const saved = stuckFile ? (JSON.parse(readFileSync(stuckFile, 'utf8')) as { done?: string[]; retry?: Record<string, { fails: number; next: number }> } | string[]) : null
    if (Array.isArray(saved)) for (const k of saved) stuckDone.add(k)
    else if (saved) {
      for (const k of saved.done ?? []) stuckDone.add(k)
      for (const [k, v] of Object.entries(saved.retry ?? {})) stuckRetry.set(k, v)
    }
  } catch {
    /* no record yet */
  }
  const saveStuck = (): void => {
    try {
      if (!stuckFile) return
      mkdirSync(dirname(stuckFile), { recursive: true })
      writeFileSync(stuckFile, JSON.stringify({ done: [...stuckDone], retry: Object.fromEntries(stuckRetry) }))
    } catch {
      /* kept in memory for this run */
    }
  }
  /** The model id the SDK last reported for an alias, so Settings can show what it resolves to. */
  let resolved: { setting: string; model: string } | null = null

  /** The judge's model: the owner's test double when the context carries one (tests inject it under deps), else the SDK. */
  const askModel = (): AskModel => (ctx.deps.orchestratorAsk as AskModel | undefined) ?? sdkAskModel(ctx.home, () => claudeCodeBinaryFor(ctx.home).path())

  /** HSwarm's folder: the test's own, else ~/.hswarm. */
  const hswarmHome = (): string => (ctx.deps.hswarmHome as string | undefined) ?? process.env.HSWARM_HOME ?? join(homedir(), '.hswarm')

  /** What a job's record says (~/.hswarm/jobs/<id>/job.json): finished when and with what counts, or still running. */
  function jobFact(id: string, now: number): Fact {
    let job: { state?: unknown; finished?: unknown; summary?: { created?: unknown; finished?: unknown; counts?: unknown } }
    try {
      job = JSON.parse(readFileSync(join(hswarmHome(), 'jobs', id, 'job.json'), 'utf8'))
    } catch {
      return { text: `HSwarm job ${id}: no record of it could be read`, running: false }
    }
    const finished = typeof job.finished === 'string' && job.finished ? job.finished : typeof job.summary?.finished === 'string' ? job.summary.finished : ''
    const counts = job.summary?.counts && typeof job.summary.counts === 'object' ? Object.entries(job.summary.counts as Record<string, unknown>).map(([k, n]) => `${String(n)} ${k}`).join(', ') : ''
    if (finished && Number.isFinite(Date.parse(finished)))
      return { text: `HSwarm job ${id} finished at ${iso(Date.parse(finished))}${counts ? ` (${counts})` : ''}; its results: hswarm_results('${id}')`, running: false }
    const created = typeof job.summary?.created === 'string' ? Date.parse(job.summary.created) : NaN
    const overdue = Number.isFinite(created) && now - created > WAIT_OVERDUE_MS
    return { text: `HSwarm job ${id} is ${String(job.state ?? 'running')}${overdue ? ' and overdue' : ''}${counts ? ` (${counts})` : ''}`, running: !overdue }
  }

  function workerFact(id: string, w: CliMayteWorker | undefined, now: number): Fact {
    if (!w) return { text: `CliMayte worker ${id}: the daemon does not list it`, running: false }
    if (!w.active) return { text: `CliMayte worker ${id} is ${w.status}${w.endedAt ? ` since ${iso(w.endedAt)}` : ''}`, running: false }
    const overdue = w.startedAt !== null && now - w.startedAt > WAIT_OVERDUE_MS
    return { text: `CliMayte worker ${id} is ${w.status}${overdue ? ' and overdue' : ''}`, running: !overdue }
  }

  /** The facts that can be checked without a model about what a chat waits on: HSwarm job ids and CliMayte worker ids. */
  async function factsOf(on: readonly string[], now: number): Promise<Fact[]> {
    const out: Fact[] = []
    let workers: CliMayteWorker[] | null | undefined
    for (const id of on) {
      if (HSWARM_JOB.test(id)) out.push(jobFact(id, now))
      else if (WORKER_ID.test(id)) {
        workers ??= await get<CliMayteWorker[]>('/api/climayte/workers?all=1')
        out.push(workerFact(id, workers?.find((w) => w.id === id), now))
      }
    }
    return out
  }

  async function get<T>(path: string): Promise<T | null> {
    const res = await app.request(path)
    return res.ok ? ((await res.json()) as T) : null
  }

  /** null when the route took it, else why not. */
  async function post(path: string, body?: unknown): Promise<string | null> {
    const res = await app.request(path, body === undefined ? { method: 'POST' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (res.ok) return null
    const answer = (await res.json().catch(() => null)) as { error?: unknown } | null
    return typeof answer?.error === 'string' ? answer.error : `${path} answered ${res.status}`
  }

  /** Each open chat's row (with `outside`, each outside session's too), the most recently active first, and each
   *  one's Claude session and transcript. `blind` when Desk's own chats could not be read; `unread`, the chats whose
   *  transcript could not be (each is classified as if it were empty, which is fine to show and never enough to act on). */
  async function read(
    days: number,
    outside: boolean
  ): Promise<{ rows: OrchestratorRow[]; session: Map<string, string | null>; blind: boolean; unread: Set<string>; items: Map<string, TranscriptItem[]> }> {
    const now = Date.now()
    const [own, others] = await Promise.all([get<ChatSummary[]>('/api/chats'), outside ? get<ExternalSession[]>('/api/external/sessions') : null])
    const subjects = [
      ...(own ?? []).filter((ch) => !ch.archived).map((ch) => ({ s: fromChat(ch), items: `/api/chats/${encodeURIComponent(ch.id)}/items` })),
      ...(others ?? []).filter((x) => !x.archived && x.status !== 'stale').map((x) => ({ s: fromExternal(x), items: `/api/external/sessions/${encodeURIComponent(x.id)}/items` }))
    ]
      .filter(({ s }) => now - s.updatedAt < days * 86_400_000)
      .sort((a, b) => b.s.updatedAt - a.s.updatedAt)
      .slice(0, MAX_CHATS)
    const rows: OrchestratorRow[] = []
    const unread = new Set<string>()
    const transcripts = new Map<string, TranscriptItem[]>()
    for (const { s, items } of subjects) {
      const busy = s.status === 'working' || s.status === 'starting'
      const got = busy ? null : await get<TranscriptItem[]>(items)
      if (!busy && got === null) unread.add(s.id)
      if (got) transcripts.set(s.id, got)
      rows.push(classify(s, got, now))
    }
    return { rows, session: new Map(subjects.map(({ s }) => [s.id, s.session])), blind: own === null, unread, items: transcripts }
  }

  /** The plan as the page shows it: a chat the orchestrator gave up on reads as left to a person, and each row carries
   *  the judge's latest judgment of its chat. */
  function plan(read: OrchestratorRow[], days: number): OrchestratorPlan {
    const now = Date.now()
    const rows = read.map((r) => {
      const row = afterGivingUp(r, tries)
      const judgment = judgments.get(row.id)
      return judgment ? { ...row, judgment } : row
    })
    const counts: OrchestratorPlan['counts'] = {}
    for (const r of rows) counts[r.move] = (counts[r.move] ?? 0) + 1
    return { at: now, mode: armed() ? 'armed' : 'shadow', days, creaitor: creaitorTool() !== null, rows: rank(rows), counts, acts: [...acts] }
  }

  /** Check-ins or continues sent to a chat in the last hour. */
  function sent(id: string, kind: 'note' | 'continue', now: number): number {
    return (sends.get(id) ?? []).filter((s) => s.kind === kind && now - s.at < HOUR_MS).length
  }

  /** Minutes since a person last wrote in the chat, or null when no message of theirs is in view. */
  function minutesSincePerson(items: readonly TranscriptItem[], now: number): number | null {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') return Math.max(0, Math.round((now - items[i].ts) / 60_000))
    return null
  }

  /** The brief the judge reads of one chat at one step: its first message, the newest slice of its transcript that step
   *  allows (judge.ts CONTEXT_STEPS: about 1%, 3%, then 5%), and the rules' findings. */
  function briefOf(c: Candidate, now: number, step: number): JudgeBrief {
    const since = minutesSincePerson(c.items, now)
    let started = c.items[0]?.ts ?? now
    for (const i of c.items) if (i.kind === 'user') started = i.ts
    const total = transcriptChars(c.items)
    const budget = stepBudget(step, total)
    const recent = recentText(c.items, budget)
    return {
      id: c.id,
      title: c.title,
      source: c.source,
      status: c.status,
      ask: askOf(c.items),
      recent,
      read: { chars: Math.min(recent.length, total), of: total, step, more: budget < total && step < CONTEXT_STEPS.length - 1 },
      workingMinutes: c.items.length ? Math.max(0, Math.round((now - started) / 60_000)) : null,
      signals: [...c.signals, since === null ? 'no message from the person in view' : `the person last wrote ${since} min ago`],
      notesThisHour: sent(c.id, 'note', now),
      continuesThisHour: sent(c.id, 'continue', now)
    }
  }

  /** The hard limits that hold a judge's send, the model cannot override them: null when the send may go. */
  function heldBy(c: Candidate, now: number): string | null {
    if (c.kind === 'error') return null
    if (c.stalled) return 'it is stalled: a note would queue behind a turn that stopped answering'
    if (sent(c.id, 'note', now) >= NOTES_PER_HOUR) return `${NOTES_PER_HOUR} check-in notes already went to it this hour`
    return null
  }

  /** Sends a message to a chat: through Desk's send queue (a continue releases its hold), or to an outside session. */
  async function send(c: Candidate, text: string): Promise<string | null> {
    if (c.source !== 'desk' && c.kind === 'waiting') {
      // The peer pipe alone never wakes an idle chat (climayte-ping.ts): a chat Desk owns takes the ping and starts a turn.
      const pinged = await post(`/api/sessions/${encodeURIComponent(c.id)}/ping`, { text })
      if (pinged === null) return null
    }
    // A note held for a busy chat is not sent once the next peek is due: that peek judges the chat afresh. Held
    // with no limit, one waited 6 hours and would have arrived as news (2026-10-13).
    if (c.source !== 'desk')
      return post(`/api/external/sessions/${encodeURIComponent(c.id)}/message`, { text, holdSecs: PEEK_MS / 1000 })
    const id = encodeURIComponent(c.id)
    const error = await post('/api/queue', { kind: 'message', chatId: c.id, text })
    return error ?? (c.kind === 'error' ? await post(`/api/queue/chats/${id}/resume`) : null)
  }

  /** One judgment, signed in with any signed-in account AgentHydra lists that has room, whichever account the judged
   *  chats run on (owner, 2026-10-09: "just use ... anything that's available"): one nobody is using first, the least
   *  used first (chat-manager's pickHealthy), then a busy one, and the next when a login is refused. The default
   *  ~/.claude login comes last: its token expires (every judgment failed "OAuth session expired" on it, 2026-10-09).
   *  With no account listed, the default login is what there is, and its refusal shows on the row. With accounts
   *  listed and none under the 85% line (hasRoom), no judgment runs: the unread default login is no way around it. */
  async function judgeOnAnAccount(c: Candidate, model: string): Promise<JudgeResult> {
    const accounts = (await get<AccountInfo[]>('/api/accounts')) ?? []
    const managed = accounts.filter((a) => a.id !== DEFAULT_ACCOUNT.id)
    const idle = managed.filter((a) => !a.inUse)
    const tried: string[] = []
    let result: JudgeResult | null = null
    for (let attempt = 0; attempt < JUDGE_ACCOUNT_TRIES; attempt++) {
      const account = pickHealthy(idle, tried) ?? pickHealthy(accounts, tried)
      if (!account && !tried.length && managed.length)
        return { ok: false, error: `no account has room: every signed-in account is at or past ${ROOM_PCT}% or unread`, resolved: null, read: null }
      if (!account && tried.length) break
      if (account) tried.push(account.id)
      const now = Date.now()
      result = await judgeChat((step) => briefOf(c, now, step), model, askModel(), JUDGE_TIMEOUT_MS, account?.configDir ?? null)
      if (result.ok || !account || !LOGIN_REFUSED.test(result.error)) break
    }
    return result!
  }

  /** Asks the judge about one chat and carries out its verdict within the hard limits. A failed call sends nothing and
   *  shows its error on the row; there is no fallback text. */
  async function judgeOne(c: Candidate): Promise<void> {
    const model = ctx.settings().orchestratorModel
    const result = await judgeOnAnAccount(c, model)
    const at = Date.now()
    if (result.resolved) resolved = { setting: model, model: result.resolved }
    if (!result.ok) {
      judgments.set(c.id, { at, model, resolved: result.resolved, verdict: null, why: result.error, message: '', held: null, error: result.error, read: result.read })
      return
    }
    const { verdict, message, why } = result.judgment
    const judgment: OrchestratorJudgment = { at, model, resolved: result.resolved, verdict, why, message, held: null, error: null, read: result.read }
    judgments.set(c.id, judgment)
    if (verdict === 'fine' || verdict === 'leave') return
    const base = { at, id: c.id, title: c.title, source: c.source, detail: why }
    const held = heldBy(c, at)
    if (held) {
      judgment.held = held
      if (c.stalled) acts.unshift({ ...base, move: 'watch', did: 'flagged' })
      return
    }
    if (!armed()) {
      judgment.held = 'the orchestrator was disarmed before it sent'
      return
    }
    if (c.kind === 'error') tries.set(c.id, c.count)
    const error = await send(c, `[${ORCHESTRATOR_FROM}] Not from the user.\n${message}`)
    const list = (sends.get(c.id) ?? []).filter((s) => at - s.at < HOUR_MS)
    list.push({ at, kind: c.kind === 'error' ? 'continue' : 'note' })
    sends.set(c.id, list)
    if (c.kind === 'waiting' && !error) nudged.set(c.id, (nudged.get(c.id) ?? new Set()).add((c.waitingOn ?? []).join('|')))
    acts.unshift(
      c.kind === 'error'
        ? { ...base, move: 'retry-error', did: 'continued', ...(error ? { error } : {}) }
        : { ...base, move: c.kind === 'waiting' ? 'waiting' : 'watch', did: 'nudged', ...(error ? { error } : {}) }
    )
  }

  /** The running chats due a judgment: Desk chats and Claude Desktop sessions not judged in PEEK_MS, and not one a
   *  person wrote in within the last 10 minutes or one whose message waits in the send queue (`skip`). */
  async function runningCandidates(now: number, skip: ReadonlySet<string>): Promise<Candidate[]> {
    const [own, others] = await Promise.all([get<ChatSummary[]>('/api/chats'), get<ExternalSession[]>('/api/external/sessions')])
    const live = [
      ...(own ?? []).filter((ch) => !ch.archived && ch.status === 'working').map((ch) => ({ id: ch.id, title: ch.title, status: ch.status, source: 'desk' as const })),
      ...(others ?? []).filter((x) => !x.archived && !x.fromPc && x.source === 'desktop' && x.status === 'working').map((x) => ({ id: x.id, title: x.title, status: x.status, source: 'desktop' as const }))
    ]
    const out: Candidate[] = []
    for (const r of live) {
      if (skip.has(r.id)) continue
      const last = judgments.get(r.id)?.at
      if (last !== undefined && now - last < PEEK_MS) continue
      const id = encodeURIComponent(r.id)
      const items = await get<TranscriptItem[]>(r.source === 'desk' ? `/api/chats/${id}/items` : `/api/external/sessions/${id}/items`)
      if (!items || personRecent(items, now)) continue
      const seen = peek(items, now, r.source === 'desk')
      out.push({
        id: r.id,
        title: r.title,
        source: r.source,
        status: r.status,
        kind: 'running',
        items,
        signals: seen.kind === 'ok' ? [] : [describe(seen)],
        stalled: seen.kind === 'stalled',
        count: 0
      })
    }
    return out
  }

  /** The idle chats whose last reply waits on work that is done, overdue or cannot be checked, and that have not had their
   *  one nudge for it. A chat whose job still runs, or whose transcript could not be read, is left (never blind). */
  async function waitingCandidates(now: number, look: Looked, skip: ReadonlySet<string>): Promise<Candidate[]> {
    const out: Candidate[] = []
    for (const r of look.blind ? [] : look.rows) {
      if (r.move !== 'waiting' || !r.waitingOn || skip.has(r.id)) continue
      if (nudged.get(r.id)?.has(r.waitingOn.join('|'))) continue
      const last = judgments.get(r.id)?.at
      if (last !== undefined && now - last < PEEK_MS) continue
      const facts = await factsOf(r.waitingOn, now)
      if (facts.some((f) => f.running)) continue
      out.push({
        id: r.id,
        title: r.title,
        source: r.source,
        status: r.status,
        kind: 'waiting',
        items: look.items.get(r.id) ?? [],
        signals: [`waiting: ${r.reason}`, ...(facts.length ? facts.map((f) => f.text) : ['nothing it waits on can be checked from here']), `it has waited at least ${WAIT_MS / 60_000} min`],
        stalled: false,
        count: 0,
        waitingOn: r.waitingOn
      })
    }
    return out
  }

  /** A rule finding in words, for the judge. */
  function describe(p: Peek): string {
    return p.kind === 'ok' ? '' : `${p.kind}: ${p.detail}`
  }

  /** Runs each task, at most `width` at once. */
  async function pool<T>(items: readonly T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
    let next = 0
    const lane = async (): Promise<void> => {
      while (next < items.length) await work(items[next++]!)
    }
    await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane))
  }

  /** One look while armed; never two at once. Without a read of the send queue it judges nothing, and a disarm part-way
   *  through stops it before its next send. */
  type Looked = Awaited<ReturnType<typeof read>>

  /** The hard limits first (act.ts): a chat given up on is recorded and never judged; a chat that may still be
   *  continued is judged, unless it was judged within PEEK_MS. */
  function limitCandidates(now: number, look: Looked, skip: Set<string>): Candidate[] {
    const candidates: Candidate[] = []
    for (const a of look.blind ? [] : decide(look.rows, tries, skip)) {
      if (a.kind === 'give-up') {
        tries.set(a.row.id, a.count)
        acts.unshift({ at: now, id: a.row.id, title: a.row.title, move: a.row.move, did: 'gave-up' })
        continue
      }
      const last = judgments.get(a.row.id)?.at
      if (last !== undefined && now - last < PEEK_MS) continue
      candidates.push({
        id: a.row.id,
        title: a.row.title,
        source: a.row.source,
        status: a.row.status,
        kind: 'error',
        items: look.items.get(a.row.id) ?? [],
        signals: [`error: ${a.row.reason}`],
        stalled: false,
        count: a.count
      })
    }
    return candidates
  }

  /** Every CliMayte worker stuck past STUCK_MS (orchestrator/stuck.ts) gets one act per reason: its origin chat is
   *  nudged, or with no such chat the worker is cancelled (its result and question stay on record). */
  async function stuckPass(now: number): Promise<void> {
    const workers = await get<CliMayteWorker[]>('/api/climayte/workers?all=1')
    const stuck = (workers ? stuckWorkers(workers, now) : []).filter((s) => !stuckDone.has(`${s.worker.id}|${s.reason}`) && now >= (stuckRetry.get(`${s.worker.id}|${s.reason}`)?.next ?? 0))
    if (!stuck.length) return
    const [own, others] = await Promise.all([get<ChatSummary[]>('/api/chats'), get<ExternalSession[]>('/api/external/sessions')])
    for (const s of stuck) {
      if (!armed()) return
      const w = s.worker
      const sid = w.originSessionId
      const desk = sid ? (own ?? []).find((ch) => ch.sessionId === sid && !ch.archived) : undefined
      const outside = sid && !desk ? (others ?? []).find((x) => x.id === sid && !x.archived && x.source === 'desktop') : undefined
      const mins = Math.round((now - s.since) / 60_000)
      const how = mins >= 120 ? `${Math.round(mins / 6) / 10} h` : `${mins} min`
      const base = { at: now, id: w.id, title: w.title, detail: s.why }
      const key = `${w.id}|${s.reason}`
      let error: string | null
      let did: OrchestratorAct['did']
      if (desk || outside) {
        const text = `[${ORCHESTRATOR_FROM}] Not from the user.
CliMayte worker ${w.id} (${w.title}) has sat stuck for ${how}: ${s.why}. Answer it with climayte_send ${w.id}, decide it yourself if you can, or cancel it with climayte_cancel ${w.id}.`
        const chat = desk ?? outside!
        error = await send({ id: chat.id, title: chat.title, source: desk ? 'desk' : 'desktop', kind: 'waiting' } as Candidate, text)
        did = 'nudged'
      } else {
        error = await post(`/api/climayte/workers/${encodeURIComponent(w.id)}/cancel`, { reason: `stuck ${how} (${s.why}) and no chat of its origin is left to answer` })
        did = 'flagged'
      }
      acts.unshift({ ...base, move: 'watch', did, ...(error ? { error } : {}) })
      if (!error) {
        stuckDone.add(key)
        stuckRetry.delete(key)
      } else {
        // A failed act is retried after 10 min, then 30 min, then every 2 h.
        const fails = (stuckRetry.get(key)?.fails ?? 0) + 1
        stuckRetry.set(key, { fails, next: now + STUCK_BACKOFF_MS[Math.min(fails - 1, STUCK_BACKOFF_MS.length - 1)]! })
      }
      saveStuck()
    }
  }

  function tick(): Promise<void> {
    ticking ??= (async () => {
      if (!armed()) return
      const now = Date.now()
      const look = await read(DEFAULT_DAYS, true)
      const queue = await get<QueueState>('/api/queue')
      if (armed() && queue) {
        const waiting = new Set(queue.items.flatMap((i) => (i.kind === 'message' && i.state !== 'failed' ? [i.chatId] : [])))
        const skip = new Set([...look.unread, ...waiting])
        const candidates = limitCandidates(now, look, skip)
        candidates.push(...(await runningCandidates(now, skip)), ...(await waitingCandidates(now, look, skip)))
        await pool(candidates, JUDGE_WIDTH, async (c) => {
          if (armed()) await judgeOne(c)
        })
        for (const [id, j] of judgments) if (now - j.at > JUDGED_KEPT_MS) judgments.delete(id)
        if (armed()) await stuckPass(Date.now())
      }
      acts.splice(ACTS_KEPT)
    })()
      .catch((err: unknown) => console.error('[orchestrator] tick failed:', err))
      .finally(() => (ticking = null))
    return ticking
  }

  // It looks every TICK_MS and does nothing while off, so the switch (saved from Settings or here) takes effect on the
  // next look. The timer never keeps the process alive.
  const timer = setInterval(() => void tick(), TICK_MS)
  ;(timer as { unref?: () => void }).unref?.()
  function arm(on: boolean): void {
    if (on !== ctx.settings().orchestrator) ctx.updateSettings({ orchestrator: on })
  }
  ctx.onStop(() => {
    stopped = true
    clearInterval(timer)
  })

  app.get(`${DIAGNOSTICS_API}/orchestrator`, async (c) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    if (why) return c.json({ error: why }, 403)
    const days = Math.min(30, Math.max(1, Number(c.req.query('days')) || DEFAULT_DAYS))
    const { rows, session } = await read(days, true)
    const result = plan(rows, days)
    const tool = creaitorTool()
    const asking = tool && c.req.query('ask') === '1' ? rows.filter((r) => r.question) : []
    if (!tool || !asking.length) return c.json(result)
    return slowJson(
      (async () => {
        for (let i = 0; i < asking.length; i += ASK_WIDTH)
          await Promise.all(asking.slice(i, i + ASK_WIDTH).map(async (r) => (r.creaitor = await askCreaitor(tool, r.question ?? '', r.options ?? [], r.cwd, session.get(r.id) ?? null))))
        return result
      })()
    )
  })

  // The model the judge asks for the setting, and the model id the SDK last reported for it (null until a judgment ran).
  app.get('/api/orchestrator/model', (c) => {
    const setting = ctx.settings().orchestratorModel
    return c.json({ setting, resolved: resolved?.setting === setting ? resolved.model : null })
  })

  // Arm or disarm. Arming looks once at once, so the reply already holds what it did.
  app.post(`${DIAGNOSTICS_API}/orchestrator`, async (c) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    if (why) return c.json({ error: why }, 403)
    const body = (await c.req.json().catch(() => null)) as Partial<OrchestratorArm> | null
    if (typeof body?.armed !== 'boolean') return c.json({ error: 'the body must be JSON: { "armed": true | false }' }, 400)
    arm(body.armed)
    if (armed()) await tick()
    const { rows } = await read(DEFAULT_DAYS, true)
    return c.json(plan(rows, DEFAULT_DAYS))
  })
}
