// The Background tasks panel's model (the real app's side panel, with CliMayte as its workflows): the
// CliMayte workers a chat dispatched, one unit per group (a worker without a group is its own unit),
// the chat's own background tasks, running and finished, and the HSwarm jobs the chat called, one unit
// each (the same jobs the sidebar's HSwarm badge counts), and the session's own of both that the server read for it
// (session.ts), which outlast the window's lists. Pure, so the grouping and the labels are tested.
import type { CliMayteWorker, SessionTasks, SwarmJob, TranscriptIndex, TranscriptItem } from '@shared/protocol'
import { buildTranscriptIndex } from '@shared/transcript-index'
import { modelName } from '@/components/shell/logic'
import { chatWorkers } from '@/components/climayte/dock'

type TaskItem = Extract<TranscriptItem, { kind: 'task' }>

export type AgentState = 'running' | 'waiting' | 'done' | 'failed'

export interface TaskAgent {
  id: string
  name: string
  model: string // 'Opus 5.5', '' when unknown
  tokens: number | null
  startedAt: number | null
  endedAt: number | null
  state: AgentState
  sessionId: string | null
  /** The minutes it said its current message would take (its `ETA:` line), null when it gave none. */
  etaMin: number | null
  /** What a worker is doing now (its hold reason while held), and since when (epoch ms). */
  doing?: string | null
  doingSince?: number | null
  doingKind?: DoingKind | null
  /** When the worker last took a tool step (epoch ms); a running worker quiet for QUIET_MS shows as quiet. */
  lastStepAt?: number | null
}

export type DoingKind = 'hold' | 'said' | 'step' | 'wait'

/** A running worker with no tool step for this long is quiet, not doing its last line. */
export const QUIET_MS = 15 * 60_000
const SAID_AGO_MS = 2 * 60_000

export interface DoingOf {
  name: string
  doing: string
  kind: DoingKind | null
  state: AgentState
  since: number | null
  lastStepAt: number | null
}

export interface TaskPhase {
  name: string
  done: number
  total: number
  agents: TaskAgent[]
}

export interface TaskUnit {
  /** 'group:<name>', 'worker:<id>' or 'task:<item id>': stable, and what the cleared list stores. */
  id: string
  name: string
  /** The bold word before the elapsed time: 'CliMayte' for workers, the task's kind otherwise. */
  label: string
  running: boolean
  startedAt: number | null
  endedAt: number | null
  agents: number
  tokens: number | null
  description: string
  account: string | null // '#68', or '#68, #41' when its workers ran on several
  phases: TaskPhase[]
  /** Active worker ids, for Stop (cancelled through AgentHydra). Empty for a transcript task. */
  stoppable: string[]
  /** A Hydra Desk chat's running background task: its task id, which Stop sends to the chat. Null for a
   *  worker unit, a settled task, or a task of a session outside Hydra Desk (nothing here runs it). */
  stopTask: string | null
  /** The ids the trash button hides: its workers, or the task item. */
  keys: string[]
  /** A transcript task that failed or was stopped: its finished row shows an X. */
  failed?: boolean
  /** When its last still-working estimate runs out (epoch ms): the latest `at + minutes` among its
   *  active workers whose current message is not done yet. Null when none of them gave one. */
  etaEndsAt: number | null
}

/** The real app's panel lists a chat's 50 newest finished tasks (owner's screenshot, 2026-10-05: "Finished 50"). */
export const FINISHED_CAP = 50

export function agentState(w: CliMayteWorker): AgentState {
  if (w.status === 'running' || w.status === 'checking') return 'running'
  if (w.active) return 'waiting'
  if (w.status === 'failed' || w.status === 'cancelled' || w.error || (w.verdict && w.verdict !== 'ok' && w.verdict !== 'pass')) return 'failed'
  return 'done'
}

const firstLine = (s: string | null | undefined): string => (s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''

const capital = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

const sumOrNull = (xs: (number | null)[]): number | null => {
  const ok = xs.filter((x): x is number => x !== null)
  return ok.length ? ok.reduce((a, b) => a + b, 0) : null
}

const minOf = (xs: (number | null)[]): number | null => {
  const ok = xs.filter((x): x is number => x !== null)
  return ok.length ? Math.min(...ok) : null
}
const maxOf = (xs: (number | null)[]): number | null => {
  const ok = xs.filter((x): x is number => x !== null)
  return ok.length ? Math.max(...ok) : null
}

function toAgent(w: CliMayteWorker): TaskAgent {
  return {
    id: w.id,
    name: w.title,
    model: w.model ? modelName(w.model) : '',
    tokens: w.tokens,
    startedAt: w.startedAt,
    endedAt: w.active ? null : (w.endedAt ?? w.lastActivityAt),
    state: agentState(w),
    sessionId: w.sessionId,
    etaMin: w.eta?.minutes ?? null,
    doing: w.doing ?? null,
    doingSince: w.doingSince ?? null,
    doingKind: w.doingKind ?? null,
    lastStepAt: w.lastStepAt ?? null,
  }
}

/** When a worker's estimate runs out, while it is still working on the message it gave it for. */
const etaEnd = (w: CliMayteWorker): number | null =>
  w.active && w.eta && w.eta.tookS === null ? w.eta.at + w.eta.minutes * 60_000 : null

/** One phase per stage (the worker's kind), in the order the stages started. */
function phasesOf(workers: CliMayteWorker[]): TaskPhase[] {
  const byStage = new Map<string, CliMayteWorker[]>()
  for (const w of [...workers].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
    const stage = capital(w.kind ?? '') || 'Tasks'
    byStage.set(stage, [...(byStage.get(stage) ?? []), w])
  }
  return [...byStage].map(([name, ws]) => {
    const agents = ws.map(toAgent).sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.startedAt ?? 0) - (b.startedAt ?? 0))
    return { name, done: agents.filter((a) => a.state === 'done' || a.state === 'failed').length, total: agents.length, agents }
  })
}

const STATE_ORDER: Record<AgentState, number> = { running: 0, waiting: 1, done: 2, failed: 2 }

function workerUnit(id: string, name: string, workers: CliMayteWorker[]): TaskUnit {
  const running = workers.some((w) => w.active)
  const oldest = [...workers].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))[0]!
  const accounts = [...new Set(workers.map((w) => w.account).filter((a): a is string => !!a))]
  return {
    id,
    name,
    label: 'CliMayte',
    running,
    startedAt: minOf(workers.map((w) => w.startedAt)),
    endedAt: running ? null : maxOf(workers.map((w) => w.endedAt ?? w.lastActivityAt)),
    agents: workers.length,
    tokens: sumOrNull(workers.map((w) => w.tokens)),
    description: firstLine(oldest.description) || (workers.length > 1 ? '' : firstLine(oldest.lastActivity)),
    account: accounts.length ? accounts.join(', ') : null,
    phases: phasesOf(workers),
    stoppable: workers.filter((w) => w.active).map((w) => w.id),
    stopTask: null,
    keys: workers.map((w) => w.id),
    etaEndsAt: maxOf(workers.map(etaEnd))
  }
}

const TASK_LABEL: Record<NonNullable<TaskItem['taskKind']>, string> = {
  workflow: 'Workflow',
  bash: 'Background command',
  agent: 'Agent',
  other: 'Task'
}

function taskUnit(t: TaskItem, deskChat: boolean): TaskUnit {
  const running = t.status === 'running'
  // A finished task that never said when it settled shows a dash, not a time still counting up.
  const timed = running || t.durationMs !== undefined
  return {
    id: `task:${t.id}`,
    name: firstLine(t.description) || 'Background task',
    label: TASK_LABEL[t.taskKind ?? 'other'],
    running,
    startedAt: timed ? t.ts : null,
    endedAt: running || t.durationMs === undefined ? null : t.ts + t.durationMs,
    agents: t.agents ?? 0,
    tokens: t.tokens ?? null,
    description: firstLine(t.summary),
    account: null,
    phases: [],
    stoppable: [],
    stopTask: running && deskChat ? t.taskId : null,
    keys: [`task:${t.id}`],
    failed: t.status === 'failed' || t.status === 'stopped',
    etaEndsAt: null
  }
}

/** The HSwarm jobs a session called: its caller id is the session, or the 8-character prefix a job stamps
 *  for it. Another session's job never matches; the prefix match cannot tell two sessions that share it apart. */
function chatJobs(jobs: readonly SwarmJob[], sessionId: string | null | undefined): SwarmJob[] {
  if (!sessionId) return []
  const mine = (id: string | null) => !!id && (id === sessionId || (id.length === 8 && sessionId.startsWith(id)))
  return jobs.filter((j) => mine(j.callerSessionId) || mine(j.callerHostSessionId))
}

/**
 * `listed` plus each of the session's own (`own`) it lacks: the window's copy when the window lists it (fresher), else
 * the session's copy of a finished one. The window lists every running worker and job, so an own copy still running
 * that the window lacks is a read from before it finished, and waits for the next. Both are this PC's: another PC's ids
 * may repeat them.
 */
function withOwn<T extends { id: string; active: boolean; pc?: string | null }>(listed: T[], own: readonly T[], window: readonly T[]): T[] {
  if (!own.length) return listed
  const shown = new Set(listed.filter((x) => !x.pc).map((x) => x.id))
  const live = new Map(window.filter((x) => !x.pc).map((x) => [x.id, x]))
  const more = own.filter((x) => !shown.has(x.id)).flatMap((x) => {
    const l = live.get(x.id)
    return l ? [l] : x.active ? [] : [x]
  })
  return more.length ? [...listed, ...more] : listed
}

/** A job as a unit: its tasks are the description, and nothing is stoppable here (Stop lives in the HSwarm tab). */
export function jobUnit(j: SwarmJob): TaskUnit {
  const { total, done, failed } = j.tasks
  return {
    id: `job:${j.id}`,
    name: j.title,
    label: 'HSwarm',
    running: j.active,
    startedAt: j.startedAt ?? null,
    // A cancelled job has no finished time from the daemon: a dash, never a time counted from nothing.
    endedAt: j.active || !j.endedAt ? null : j.endedAt,
    agents: total,
    tokens: null,
    description: `${done} of ${total} done`,
    account: null,
    phases: [],
    stoppable: [],
    stopTask: null,
    keys: [`job:${j.id}`],
    failed: j.status === 'cancelled' || failed > 0,
    etaEndsAt: null
  }
}

/** The HSwarm job a unit opens, null for any other unit. */
export const jobIdOf = (u: TaskUnit): string | null => (u.id.startsWith('job:') ? u.id.slice('job:'.length) : null)

/** Workers grouped into units: a group is one unit, a worker with no group its own. */
export function workerUnits(workers: CliMayteWorker[]): TaskUnit[] {
  const groups = new Map<string, CliMayteWorker[]>()
  const units: TaskUnit[] = []
  for (const w of workers) {
    if (w.group) groups.set(w.group, [...(groups.get(w.group) ?? []), w])
    else units.push(workerUnit(`worker:${w.id}`, w.title, [w]))
  }
  for (const [g, ws] of groups) units.push(workerUnit(`group:${g}`, g, ws))
  return units
}

const TASK_STATUSES = new Set<string>(['running', 'completed', 'failed', 'stopped'])

/** The unit has something Stop can end: active workers, or a Desk chat's running task. */
export const canStop = (u: TaskUnit): boolean => u.stoppable.length > 0 || u.stopTask !== null

export interface PanelLists {
  running: TaskUnit[]
  finished: TaskUnit[]
}

/** The transcript's background tasks: the index's (every one running, the last finished) under the loaded items' own, which are newer. */
export function wholeTasks(items: readonly TranscriptItem[], index?: TranscriptIndex | null): TaskItem[] {
  const own = items.filter((i): i is TaskItem => i.kind === 'task' && TASK_STATUSES.has(i.status ?? ''))
  if (!index) return own
  const ids = new Set(own.map((t) => t.id))
  const above = [...index.recentTasks, ...index.runningTasks].filter((t): t is TaskItem => t.kind === 'task' && !ids.has(t.id))
  return [...above, ...own]
}

/** The newest to-do list: the loaded items' when they hold one, else the index's, else one built from the items. */
export function latestTodoList(items: readonly TranscriptItem[], index?: TranscriptIndex | null) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (it.kind === 'todos') return it.todos.length ? it.todos : null
  }
  const t = (index ?? buildTranscriptIndex(items)).latestTodos
  return t && t.kind === 'todos' && t.todos.length ? t.todos : null
}

/**
 * What the panel lists. `workerIds` (the server's match) scope it to the workers this chat dispatched (`all`:
 * every worker AgentHydra lists); `items` adds the chat's own task items, running or finished
 * (completed, failed, stopped), so a chat's finished background tasks list and count as the real
 * app's do (owner, 2026-10-05: "there actually is one running and one finished"); a Desk chat's running
 * task can be stopped (`chatId`). `jobs` (the window's HSwarm jobs) adds the ones this session called, one unit
 * each, running or finished like the rest. `own` (the session's own workers and jobs, read for it) adds those the
 * window's lists dropped: they keep the 20 newest finished of the whole PC, and a busy PC turns that over in minutes
 * (owner, 2026-10-10: the session view shows the HSwarm and CliMayte items the session called). Running
 * units newest first; finished ones most recent first, minus the cleared, capped at FINISHED_CAP.
 */
export function panelLists(o: {
  workers: CliMayteWorker[]
  items?: TranscriptItem[]
  /** The whole transcript's index: its running and recent tasks outlast the loaded rows (the loaded items win by id). */
  index?: TranscriptIndex | null
  jobs?: readonly SwarmJob[]
  own?: SessionTasks | null
  sessionId: string | null | undefined
  workerIds?: readonly string[]
  all?: boolean
  cleared?: ReadonlySet<string>
  /** The Hydra Desk chat the items are of; null or absent for a session outside it (its tasks get no Stop). */
  chatId?: string | null
}): PanelLists {
  const own = o.own && o.own.sessionId === o.sessionId ? o.own : null
  const scoped = withOwn(o.all ? o.workers : chatWorkers(o.workers, o.sessionId, o.workerIds), own?.workers ?? [], o.workers)
  const tasks = wholeTasks(o.items ?? [], o.index).map((t) => taskUnit(t, !!o.chatId))
  const jobs = withOwn(chatJobs(o.jobs ?? [], o.sessionId), own?.jobs ?? [], o.jobs ?? []).map(jobUnit)
  const units = [...workerUnits(scoped), ...tasks, ...jobs]
  const cleared = o.cleared ?? new Set<string>()
  const running = units.filter((u) => u.running).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const finished = units
    .filter((u) => !u.running && !u.keys.every((k) => cleared.has(k)))
    .sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0))
    .slice(0, FINISHED_CAP)
  return { running, finished }
}

/** The latest estimate end among running units, null when none gave one. */
export function latestEtaEnd(units: readonly TaskUnit[]): number | null {
  return maxOf(units.filter((u) => u.running).map((u) => u.etaEndsAt))
}

const minutesText = (m: number): string => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`)

/** 'about 5 min left', 'about 1 h 20 min left', 'due about now', '3 min over the estimate'. */
export function etaLeft(endsAt: number, now: number): string {
  const left = endsAt - now
  if (left > 0) return `about ${minutesText(Math.ceil(left / 60_000))} left`
  const over = Math.floor(-left / 60_000)
  return over < 1 ? 'due about now' : `${minutesText(over)} over the estimate`
}

/** A worker's estimate in the agent table's Time cell: '~5m', '~1h 20m', '~30s'. */
export function etaShort(minutes: number): string {
  if (minutes < 1) return `~${Math.round(minutes * 60)}s`
  const m = Math.round(minutes)
  return m < 60 ? `~${m}m` : `~${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** A quiet running worker's time since its last tool step; null when it is not quiet. */
const quietMs = (d: DoingOf, now: number): number | null =>
  d.state === 'running' && d.lastStepAt !== null && now - d.lastStepAt >= QUIET_MS ? now - d.lastStepAt : null

/** 'for 6 min', 'no update for 18 min', '3 min ago' (a line said earlier), '' when there is no time to show. */
function doingTime(d: DoingOf, now: number): string {
  const quiet = quietMs(d, now)
  if (quiet !== null) return `no update for ${minutesText(Math.floor(quiet / 60_000))}`
  if (d.since === null) return ''
  if (d.kind === 'said') {
    const ms = now - d.since
    return ms < SAID_AGO_MS ? '' : `${minutesText(Math.floor(ms / 60_000))} ago`
  }
  return forText(d.since, now)
}

/** One task's doing with its time: 'Waiting for CPU: 99% busy · for 6 min'. */
export function doingLine(d: DoingOf, now: number): string {
  return [d.doing, doingTime(d, now)].filter(Boolean).join(' · ')
}

/** The reason's head, before its first colon: 'Waiting for CPU' from 'Waiting for CPU: 99% busy'. */
const headOf = (doing: string): string => {
  const colon = doing.indexOf(':')
  return (colon < 0 ? doing : doing.slice(0, colon)).trim()
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)

/** The label's parts for several tasks: two waiting groups, then the working and quiet counts. */
function doingParts(doings: readonly DoingOf[], now: number): string[] {
  const byHead = new Map<string, DoingOf[]>()
  for (const d of doings.filter((x) => x.state === 'waiting')) {
    const head = headOf(d.doing)
    byHead.set(head, [...(byHead.get(head) ?? []), d])
  }
  const groups = [...byHead]
    .map(([head, ds]) => ({ head, ds, since: Math.min(...ds.map((d) => d.since ?? Number.POSITIVE_INFINITY)) }))
    .sort((a, b) => a.since - b.since)
  const parts = groups.slice(0, 2).map((g) => {
    const since = Number.isFinite(g.since) ? g.since : null
    return [`${g.ds.length} ${lowerFirst(g.head)}`, forText(since, now)].filter(Boolean).join(' ')
  })
  const more = groups.slice(2).reduce((sum, g) => sum + g.ds.length, 0)
  if (more > 0) parts.push(`+${more} more waiting`)

  const running = doings.filter((d) => d.state === 'running')
  const quiet = running.filter((d) => quietMs(d, now) !== null)
  const working = running.length - quiet.length
  if (working > 0) parts.push(`${working} working`)
  if (quiet.length > 0) {
    const since = Math.min(...quiet.map((d) => d.lastStepAt ?? Number.POSITIVE_INFINITY))
    parts.push(`${quiet.length} quiet ${forText(since, now)}`)
  }
  return parts
}

/**
 * The inline row under the last message: '1 running task', '3 running tasks · 2 finished', '4 finished
 * tasks', '' when none. With one task it names what that task is doing: '1 running task · Waiting for CPU:
 * 99% busy · for 6 min'. With more, the waiting tasks come first, grouped by reason, then how many are
 * working or quiet, then the estimate and the finished count: '3 running tasks · 1 waiting for CPU for 6
 * min · 2 working · about 11 min left · 5 finished'.
 */
export function runningLabel(
  n: number,
  finished: number,
  now: number,
  endsAt: number | null,
  doings: readonly DoingOf[],
): string {
  const done = finished > 0 ? `${finished}${finished >= FINISHED_CAP ? '+' : ''} finished` : ''
  if (n <= 0) return done ? `${done} ${finished === 1 ? 'task' : 'tasks'}` : ''
  const running = `${n} running ${n === 1 ? 'task' : 'tasks'}`
  const left = endsAt !== null ? etaLeft(endsAt, now) : ''
  const parts = n === 1 && doings.length === 1 ? [doingLine(doings[0], now)] : doingParts(doings, now)
  return [running, ...parts, left, done].filter(Boolean).join(' · ')
}

/** 'for 40 s', 'for 6 min', 'for 1 h 20 min'; '' when the start is not known. */
export function forText(since: number | null, now: number): string {
  if (since === null) return ''
  const ms = now - since
  return ms < 60_000 ? `for ${Math.max(0, Math.floor(ms / 1000))} s` : `for ${minutesText(Math.floor(ms / 60_000))}`
}

/** An agent's current doing, when it is running or waiting and has one. */
export function doingOfAgent(a: TaskAgent): DoingOf | null {
  if (!a.doing || (a.state !== 'running' && a.state !== 'waiting')) return null
  return {
    name: a.name,
    doing: a.doing,
    kind: a.doingKind ?? null,
    state: a.state,
    since: a.doingSince ?? null,
    lastStepAt: a.lastStepAt ?? null,
  }
}

/** The running and waiting agents' current doings: waiting first, then the longest-held. */
export function doingsOf(units: TaskUnit[]): DoingOf[] {
  return units
    .flatMap((u) => u.phases.flatMap((p) => p.agents))
    .map(doingOfAgent)
    .filter((d): d is DoingOf => d !== null)
    .sort(
      (a, b) =>
        (a.state === 'waiting' ? 0 : 1) - (b.state === 'waiting' ? 0 : 1) ||
        (a.since ?? Number.MAX_SAFE_INTEGER) - (b.since ?? Number.MAX_SAFE_INTEGER),
    )
}

/** The panel's and hover's one line for a doing: 'Name: what it is doing (for 6 min)'. */
export function doingTitle(doings: readonly DoingOf[], now: number): string {
  return doings
    .map((d) => {
      const time = doingTime(d, now)
      return time ? `${d.name}: ${d.doing} (${time})` : `${d.name}: ${d.doing}`
    })
    .join('\n')
}


/** '11m 06s', '45s', '1h 02m'. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${pad(s % 60)}s`
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`
}

export function elapsedOf(start: number | null, end: number | null, now: number): string {
  return start === null ? '–' : formatElapsed((end ?? now) - start)
}

/** '539.6k', '1.2M', '812'; a dash when nothing says. */
export function formatTokens(n: number | null): string {
  if (n === null) return '–'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** The progress squares of a phase: one per agent, finished first, then running, then waiting. */
export function phaseSquares(p: TaskPhase): AgentState[] {
  const order: AgentState[] = ['done', 'failed', 'running', 'waiting']
  return [...p.agents].map((a) => a.state).sort((a, b) => order.indexOf(a) - order.indexOf(b))
}

/** The phase opened at first: the first with a running agent, else the last. */
export function openPhase(u: TaskUnit): string | null {
  return (u.phases.find((p) => p.agents.some((a) => a.state === 'running')) ?? u.phases.at(-1))?.name ?? null
}
