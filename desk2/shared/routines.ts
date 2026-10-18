// Routines (the owner, 2026-10-12: "like how Claude has routines. It's essentially tasks, like a cron job ... we'll want
// this routine manager, I guess, to be available to the AI ... if it wants to put something there, it has to ask"). The
// routine manager runs the user's routines on their schedule, each one hidden or as an AI chat, and shows what they did.
// The server keeps it (server/src/plugins/73-routines.ts, deciding in
// server/src/routines/); GET /api/routines answers what it saw last, Settings > Managers draws it, and AgentHydra's MCP
// tool `routines` reads the same answer. Plain types only.
//
// THE ROUTINE CONTRACT. One file per routine: <desk home>/routines/<id>.json. The id is the file name without .json and
// matches ^[a-z0-9][a-z0-9-]{0,39}$. The body is:
//   {
//     "name": "Example routine",
//     "askedBy": "Example Owner, 2026-10-12: \"check the inbox every weekday morning\"",
//     "schedule": "57 8,12 * * 1-5",
//     "prompt": "Check the replies ...",
//     "cwd": "C:/Users/me/project",
//     "timeoutMinutes": 60,
//     "until": "2026-10-23"
//   }
// `name` is required. `askedBy` is required (at most 500 characters): who asked for the routine, in their own words, with
// the date. A file without it is 'broken'.
//
// WHEN, exactly one of:
//   "schedule"     a 5-field cron expression in LOCAL time (minute hour day-of-month month day-of-week). Supports *, numbers,
//                  a-b, lists a,b, steps */n and a-b/n; day-of-week 0-7 (0 and 7 are Sunday). When both day-of-month and
//                  day-of-week are restricted, either matching counts (standard cron).
//   "status"       a command (argv, run with no shell, the program first) that prints ONE JSON object within 60 seconds.
//                  The routine paces itself by it: next_tick_at, last_tick_at, off, headline, totals, settings. Its runs
//                  keep at least 15 minutes apart.
//   "windowsTask"  the full path of a Windows Task Scheduler task, e.g. "\Example nightly job". Windows runs it, not the
//                  routine manager; the manager shows it and controls it (run, pause, resume). Windows only.
// WHAT, for "schedule" and "status" routines, exactly one of:
//   "run"          an argv, run hidden with no shell. Exit 0 = ok, 75 = busy, anything else = failed.
//   "prompt"       an AI run: a Desk chat started with this prompt (needs "cwd"). It ends when the worker is no longer active.
// A "windowsTask" routine has neither.
// "cwd" is required for a prompt routine and optional for the others. "timeoutMinutes" is 5 to 360, default 120.
// "until" is an optional YYYY-MM-DD: after the end of that local day the routine is 'ended' and never runs.
// "describe" is an optional true or false (default false), for "schedule" and "status" routines: true, and once each run
// that printed something ends (a prompt run: its chat's last answer), an AI reads it and writes what the run did in two or
// three plain sentences, kept with the run (owner, 2026-10-13: "every time they finish, to have a, like, AI description of
// what they did ... have a toggle"). A busy run is not described. The card's Describe runs switch sets it.
// The owner edits a routine's file in its card (owner, 2026-10-13: "I need to be able to, like, edit them ... rename them"):
// POST `edit` changes the keys it names (null removes one), and the file must still check out.
//
// A routine's file is written by its owner. An AI can only propose one (see RoutineProposal): a proposal lives in
// <desk home>/routines/proposed/<id>.json with a required "why" and never runs until the owner approves it in Settings >
// Managers > Routines.

/** How often the manager looks at its routines. */
export const ROUTINES_EVERY_MS = 5 * 60_000

/** How a run ended: ok, busy (exit 75), failed (a failing exit, or its runner never started), timed-out (killed past its
 *  timeout), or interrupted (it ended without saying how: its runner was killed or the PC restarted, or Desk stopped while it
 *  was starting a prompt run's chat). A Desk restart alone leaves a command run going, and the next Desk goes on watching it. */
export type RoutineOutcome = 'ok' | 'busy' | 'failed' | 'timed-out' | 'interrupted'

/**
 * Where a routine stands:
 * idle      not due yet (its schedule or status says when)
 * due       due, but the manager is off or its last run ended under 15 minutes ago: it waits
 * running   a run of it is running now
 * paused    the owner paused it: it never starts on its own
 * off       its status says off: never run
 * ended     past its `until` day: never runs, still listed
 * broken    its file or its status does not check out (the reason says which)
 * waiting   a proposal waiting for the owner's yes (listed separately, never run)
 */
export type RoutineState = 'idle' | 'due' | 'running' | 'paused' | 'off' | 'ended' | 'broken' | 'waiting'

/** Which way a routine decides when it runs. */
export type RoutineKind = 'schedule' | 'status' | 'windowsTask'

/** One run, as the page and the memory keep it. Times in ms. */
export interface RoutineRun {
  startedAt: number
  endedAt: number
  outcome: RoutineOutcome
  exitCode: number | null
  /** The last non-empty output line (for a prompt run, the worker's last result line), cut to 300 characters. */
  lastLine: string
  /** The Desk chat a prompt run was, so the card can open it; null for the other kinds. */
  workerId: string | null
  /** The chat's session, once it has one (a prompt run); the card opens its transcript by it. */
  sessionId: string | null
  /** What the run did, as an AI read it (its routine's `describe` is on); absent when the run was not described. */
  description?: RunDescription
}

/** An AI's account of one run: `pending` while it is written (text empty), `done` with the account, or `failed` with why. */
export interface RunDescription {
  state: 'pending' | 'done' | 'failed'
  text: string
}

/** A run going on now: when it started, what it runs (kept from its start: the routine's file may change meanwhile), the
 *  process it is (or null), and the chat it is (or null). */
export interface RoutineRunning {
  startedAt: number
  kind: 'command' | 'prompt'
  pid: number | null
  workerId: string | null
  sessionId: string | null
}

/** The definition as the file holds it, checked. A proposal is one of these plus `why`. */
export interface RoutineDefinition {
  id: string
  name: string
  askedBy: string
  schedule?: string
  status?: string[]
  windowsTask?: string
  run?: string[]
  prompt?: string
  cwd?: string
  timeoutMinutes: number
  until?: string
  describe?: boolean
}

/** A proposal an AI wrote: the definition, plus why it should be a routine rather than a background task it runs itself. */
export interface RoutineProposal extends RoutineDefinition {
  why: string
}

/** One routine, as the last look saw it. */
export interface Routine {
  id: string
  name: string
  kind: RoutineKind | null
  state: RoutineState
  reason: string
  /** Who asked for it, in their words, with the date; null when its file is broken. */
  askedBy: string | null
  schedule: string | null
  windowsTask: string | null
  /** What a schedule or status routine does when it runs; null for a windowsTask routine. */
  what: 'run' | 'prompt' | null
  /** Its file's prompt, run and status, for its Edit form; null when it has none (or its file is broken). */
  prompt: string | null
  command: string[] | null
  statusCommand: string[] | null
  cwd: string | null
  timeoutMinutes: number | null
  until: string | null
  paused: boolean
  /** Whether an AI describes each of its runs (its file's `describe`). */
  describe: boolean
  /** From its status (status kind): one line, cut to 160 characters. */
  headline: string | null
  totals: Record<string, number> | null
  /** From its status (status kind): at most 12 entries; the routine owns them and the manager never reads them. */
  settings: Record<string, string | number | boolean> | null
  /** When its last run ended, ms, or null when none is known. */
  lastRunAt: number | null
  /** When it next runs, ms, or null when it does not know (or runs now). */
  nextRunAt: number | null
  running: RoutineRunning | null
  /** Its last runs, newest first (at most 30). */
  runs: RoutineRun[]
  /** How many runs it has ever had (its full history; the card shows the newest 30). */
  runsTotal?: number
}

/** GET /api/routines. */
export interface RoutinesStatus {
  enabled: boolean
  everyMs: number
  checkedAt: number | null
  /** When it looks next. It looks while off too, starting nothing. */
  nextCheckAt: number | null
  routines: Routine[]
  /** Proposals waiting for the owner's yes. Never run. */
  proposals: RoutineProposal[]
  /** Why the last look failed as a whole, or null. */
  error: string | null
}

/**
 * POST /api/routines. One action per call besides `enabled`. The window (X-Desk-Caller: window) may do every action; an
 * agent may do `run`, `pause` and `propose` only, and gets 403 for the rest. `edit` sets the keys of a routine's file that
 * `set` names (null removes one: `until`, say), every other key as it was; 409 with the reason when the result does not
 * check out, and the file is left alone.
 */
export interface RoutinesRequest {
  enabled?: boolean
  run?: string
  pause?: string
  resume?: string
  approve?: string
  discard?: string
  propose?: RoutineProposal
  edit?: { id: string; set: Record<string, unknown> }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad2 = (n: number): string => String(n).padStart(2, '0')
/** One cron field's values as a list, when it is plain numbers or a list of them; null for ranges, steps and `*`. */
const plainList = (f: string): number[] | null => (/^\d+(,\d+)*$/.test(f) ? f.split(',').map(Number) : null)

/**
 * A schedule's cron expression in short English: "08:57 and 12:57, Mon to Fri". A form it does not read plainly comes back
 * as the expression itself, so the page never guesses. Local time, as the server reads it.
 */
export function scheduleInWords(expr: string): string {
  const [minute, hour, dom, month, dow] = expr.trim().split(/\s+/)
  if (!minute || !hour || !dom || !month || !dow || expr.trim().split(/\s+/).length !== 5) return expr
  const hours = plainList(hour)
  const minutes = plainList(minute)
  if (!hours || !minutes || month !== '*') return `cron ${expr}`
  const times = hours.flatMap((h) => minutes.map((m) => `${pad2(h)}:${pad2(m)}`))
  const at = times.length > 3 ? `${times.length} times a day` : times.join(' and ')
  let day = 'every day'
  if (dom === '*' && dow === '1-5') day = 'Mon to Fri'
  else if (dom === '*' && dow === '0,6') day = 'weekends'
  else if (dom === '*' && /^[0-6](,[0-6])*$/.test(dow)) day = dow.split(',').map((d) => WEEKDAYS[Number(d)]).join(', ')
  else if (/^\d+$/.test(dom) && dow === '*') day = `on day ${dom} of the month`
  else if (dom !== '*' || dow !== '*') return `cron ${expr}`
  return `${at}, ${day}`
}

/** The whole-history numbers of GET /api/routines/:id/details. Times in ms; rates 0 to 1, null when nothing counts. */
export interface RoutineDetailsStats {
  total: number
  ok: number
  /** failed, timed-out and interrupted */
  failed: number
  busy: number
  /** ok / (ok + failed) */
  successRate: number | null
  avgMs: number | null
  longestMs: number | null
  firstRunAt: number | null
  last24h: number
  last7d: number
}

/** A status command's trend object (Archangel's rsi.keep_rate, say). */
export interface RoutineTrend {
  latest: number
  previous?: number
  best?: number
  trend?: string
}

/** GET /api/routines/:id/details?before=<ms>&limit=<n>. */
export interface RoutineDetails {
  id: string
  name: string
  /** One page of the full history, newest first; ask again with before=nextBefore for the next. */
  runs: RoutineRun[]
  nextBefore: number | null
  stats: RoutineDetailsStats
  /** `word N` pairs of the runs' last lines, summed over the whole history. */
  counters: Record<string, number>
  /** The latest status: its totals, headline, other numbers and groups of trend objects. */
  totals: Record<string, number> | null
  headline: string | null
  numbers: Record<string, number> | null
  trends: Record<string, Record<string, RoutineTrend>> | null
}
