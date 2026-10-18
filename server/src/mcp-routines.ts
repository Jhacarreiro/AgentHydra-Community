// server/src/mcp-routines.ts - the `routines` MCP tool: the routines AgentHydra's routine manager runs (each defined by a file in
// <desk home>/routines), each one's state and why, its schedule, when it last ran and how, and when it runs next; plus the
// proposals waiting for the owner's yes. Routines live in AgentHydra 2.0 (Desk, desk2/server/src/plugins/73-routines.ts), so
// this file keeps no state: it reads Desk's /api/routines, which answers from its last look (no model asked), and turns its
// times into ISO. An agent may run, pause and propose a routine here; only the owner resumes, approves, discards or edits one.
import { desk2Present, desk2Url } from './desk2'
import { type HydraTool, S } from './mcp-client'

// The parts of desk2/shared/routines.ts this reads. Not imported: a release build may carry no desk2/.
interface Run {
  startedAt: number
  endedAt: number
  outcome: string
  exitCode: number | null
  lastLine: string
  workerId: string | null
  description?: { state: string; text: string }
}
interface Routine {
  id: string
  name: string
  kind: string | null
  state: string
  reason: string
  askedBy: string | null
  schedule: string | null
  windowsTask: string | null
  what: string | null
  paused: boolean
  describe?: boolean
  headline: string | null
  totals: Record<string, number> | null
  lastRunAt: number | null
  nextRunAt: number | null
  running: { startedAt: number; pid: number | null; workerId: string | null } | null
  runs: Run[]
}
interface Status {
  enabled: boolean
  checkedAt: number | null
  nextCheckAt: number | null
  routines: Routine[]
  proposals: Record<string, unknown>[]
  error: string | null
}

const RUNS_SHOWN = 5
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

async function routines(args: {
  fresh?: boolean
  run?: string
  pause?: string
  propose?: Record<string, unknown>
}): Promise<unknown> {
  if (!desk2Present())
    throw new Error('Routines live in AgentHydra 2.0 (desk2/), which this install does not have.')
  const base = desk2Url()
  const mutates =
    typeof args.run === 'string' ||
    typeof args.pause === 'string' ||
    typeof args.propose === 'object'
  let res: Response
  try {
    res = mutates
      ? await fetch(`${base}/api/routines`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            typeof args.run === 'string'
              ? { run: args.run }
              : typeof args.pause === 'string'
                ? { pause: args.pause }
                : { propose: args.propose },
          ),
          signal: AbortSignal.timeout(90_000),
        })
      : await fetch(`${base}/api/routines${args.fresh ? '?fresh=1' : ''}`, {
          signal: AbortSignal.timeout(90_000),
        })
  } catch {
    throw new Error(
      `AgentHydra's window (Desk 2, ${base}) is not answering. Routines run there: open AgentHydra, then call again.`,
    )
  }
  const json = (await res.json().catch(() => null)) as (Status & { error?: string }) | null
  if (!res.ok || !json)
    throw new Error(
      res.status === 404 && !mutates
        ? 'This AgentHydra window predates Routines: restart it (Restart to update in its menu).'
        : (json?.error ?? `HTTP ${res.status}`),
    )
  return {
    enabled: json.enabled,
    checkedAt: iso(json.checkedAt),
    nextCheckAt: iso(json.nextCheckAt),
    routines: json.routines.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      state: r.state,
      reason: r.reason,
      askedBy: r.askedBy,
      schedule: r.schedule,
      windowsTask: r.windowsTask,
      what: r.what,
      paused: r.paused,
      describe: r.describe === true,
      headline: r.headline,
      totals: r.totals,
      lastRunAt: iso(r.lastRunAt),
      nextRunAt: iso(r.nextRunAt),
      running: r.running
        ? { startedAt: iso(r.running.startedAt), pid: r.running.pid, workerId: r.running.workerId }
        : null,
      recent: r.runs
        .slice(0, RUNS_SHOWN)
        .map((x) => ({ ...x, startedAt: iso(x.startedAt), endedAt: iso(x.endedAt) })),
    })),
    waitingForOwner: json.proposals,
    error: json.error,
  }
}

const CONTRACT =
  'name, askedBy (who asked, in their words, with the date), exactly one of schedule (5-field cron, local time), status (argv) or windowsTask (a Windows task path), and for schedule or status exactly one of run (argv) or prompt (an AI run, needs cwd); optional cwd, timeoutMinutes (5-360), until (YYYY-MM-DD), describe (true: an AI describes each run once it ends)'

export const ROUTINES_TOOLS: HydraTool[] = [
  {
    name: 'routines',
    description:
      "The owner's routines (AgentHydra's routine manager): standing jobs on a schedule, each a command, an AI prompt that runs as a chat, or a Windows scheduled task, with its state (idle, due, running, paused, off, ended, or broken, and why), its schedule, when it last ran and how (ok, busy, failed, timed-out or interrupted, with the last output line, and for a routine whose `describe` is on, an AI's description of what each run did), and when it runs next; plus the proposals waiting for the owner's yes. It looks every 5 minutes and asks no model itself. Answers from its last look in milliseconds; `fresh` looks first. " +
      'The owner (2026-10-12): never schedule anything the owner did not ask for. To add a routine you must ask: `propose` it, and it runs only after the owner approves it in Settings > Managers > Routines. Prefer a temporary background task you run and manage yourself over adding a routine or sub-tasks on other things. Only a routine the owner asked for in their own words belongs here. ' +
      "MUTATES: `run` (runs one routine now; refused when it is paused, off, ended, broken or running), `pause` (pauses one, so it never starts on its own) and `propose` (writes a proposal; it never runs until the owner approves it). Only one of them per call. Resume, approve and discard are the owner's alone, in Settings, and so is editing a routine (its Edit form and Describe runs switch).",
    inputSchema: S({
      fresh: { type: 'boolean', description: 'Look now before answering.' },
      run: { type: 'string', description: 'MUTATES: the id of one routine to run now.' },
      pause: { type: 'string', description: 'MUTATES: the id of one routine to pause.' },
      propose: {
        type: 'object',
        description: `MUTATES: a proposal, with id (lowercase letters, digits and -, up to 40), why (one or two sentences: what it does and why it should be a routine rather than a background task you run yourself) and the contract: ${CONTRACT}.`,
      },
    }),
    run: (args) =>
      routines(
        args as {
          fresh?: boolean
          run?: string
          pause?: string
          propose?: Record<string, unknown>
        },
      ),
  },
]
