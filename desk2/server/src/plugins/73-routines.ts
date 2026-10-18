// Routines (shared/routines.ts says what a routine is and what its file holds). GET /api/routines answers what its last look
// saw (?fresh=1 looks first); POST /api/routines does one action: run, pause, propose (any caller), resume, approve,
// discard (the window only), and turns the manager on or off with `enabled` (the window only). A look reads each routine's
// file, runs each status command, reads each Windows task in one call, judges (routines/decide.ts) and starts the runs that
// fell due. Its memory (each routine's last 30 runs, the one running, the newest slot it ran for, paused) is
// <home>/routines.json, so a restart goes on watching a run it had not seen end (a command run's runner, routines/runner.ts,
// and a prompt run's chat both outlive Desk) and never starts a slot twice. A proposal (routines/proposed) is listed and
// never run. No model decides here: a prompt routine is a Desk chat that runs its prompt, and a routine whose file says
// `describe` has each run's output read by one Haiku turn afterwards (routines/describe.ts), kept with the run.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import {
  ROUTINES_EVERY_MS,
  type Routine,
  type RoutineDetails,
  type RoutineDefinition,
  type RoutineOutcome,
  type RoutineProposal,
  type RoutineRun,
  type RoutinesRequest,
  type RoutinesStatus,
  type RunDescription,
} from '@shared/routines'
import type { ServerContext } from '../context'
import { AsyncFile } from '../async-file'
import { bridge } from '../bridge'
import { createClient, type AhWorker, type StartWorker } from '../bridge/client'
import { isActiveWorkerStatus } from '../bridge/climayte'
import { callerKind } from '../caller'
import { claudeCodeBinaryFor } from '../engine/claude-code-binary'
import { chatAddOns } from '../engine/desk-prompt'
import { killHostTree, pidAlive, recordedPidOwner, startDetached } from '../host/launch'
import { emptyMemory, judge, lastEndOf, parseReading, slotsOf, type Memory, type Reading, type Seen } from '../routines/decide'
import { sdkDescriber, type Describer } from '../routines/describe'
import { checkDefinition, kindOf, parseProposalText, parseRoutineText, checkProposal, readEntries, ROUTINE_ID, TIMEOUT_DEFAULT, type Entry } from '../routines/manifest'
import { routineBrokenMessage, routineIncidentAction } from '../routines/incident'
import { descriptionRow, appendRows, pageOf, readHistory, statsOf, sumCounters, syncHistory } from '../routines/history'
import { lastLineOf, LINE_CHARS, message, runArgv } from '../routines/proc'
import { readJson, RUNNER_ENTRY, runPaths, writeJson, type RunFile, type RunResult, type RunSpec } from '../routines/runner'
import { readTasks, runTaskNow, setTaskEnabled, TASK_NEVER_RAN, TASK_RUNNING, type TaskReading } from '../routines/wintask'
import { renameOver, writeFlushed } from '../write-flushed'

/** The first look after a start waits for the rest of Desk to come up. */
const FIRST_LOOK_MS = 60_000
/** While a prompt run is going, the manager looks this often to see whether its chat has ended. */
const PROMPT_LOOK_MS = 30_000
/** A status command has this long to print its object. */
const STATUS_MS = 60_000
/** Runs kept per routine. */
const RUNS_KEPT = 30
/** A run's log moves to <id>.log.1 once it passes this. */
const LOG_MAX_BYTES = 2 * 1024 * 1024
/** The exit code a busy routine answers with: its own lock is held by another run. */
const BUSY_EXIT = 75
/** A command run's runner has this long to say it runs (<id>.run.json) before the run counts as not started: twice a chat
 *  host's start, as a powershell asking WMI on a PC at full load can take tens of seconds. */
const RUNNER_START_MS = 60_000
/** A runner still going this long past its run's timeout (it ends the command itself at the timeout) is ended here. */
const RUNNER_GRACE_MS = 2 * 60_000
/** The actions a caller may ask for, one per call; and those only the window may ask for. */
const ACTIONS = ['run', 'pause', 'resume', 'approve', 'discard', 'propose', 'edit'] as const
const OWNER_ACTIONS: readonly string[] = ['resume', 'approve', 'discard', 'edit']
const OWNER_ONLY = { error: 'only the owner can do that, in Settings > Managers > Routines' }
const SHAPE =
  'the body must be JSON: { "enabled"?: true | false, "run"?: "<id>", "pause"?: "<id>", "resume"?: "<id>", "approve"?: "<id>", "discard"?: "<id>", "propose"?: { "id", "why", ...the contract }, "edit"?: { "id": "<id>", "set": { ...contract keys, null removes one } } }, one action per call besides "enabled"'
/** A description still being written when Desk stopped is never finished: the output it read went with that Desk. */
const RESTARTED: RunDescription = { state: 'failed', text: 'AgentHydra restarted before it was described' }

/** How a worker stands now: the bridge's view of it. */
export type WorkerView = Pick<AhWorker, 'status' | 'error' | 'result' | 'sessionId'>

/** Desk's chats, as a routine's prompt run uses them. The default is AgentHydra's own bridge. */
export interface RoutineWorkers {
  start(task: StartWorker): Promise<{ id: string; sessionId: string | null }>
  read(id: string): Promise<WorkerView | null>
  cancel(id: string): Promise<void>
}

/** AgentHydra's incidents, as a routine's failed, timed-out or ok run opens or resolves them. The default is the daemon. */
export interface RoutineIncidents {
  record(body: { scope: string; key: string; message: string }): Promise<unknown>
  resolve(scope: string, key: string): Promise<unknown>
}

const liveIncidents: RoutineIncidents = {
  record: (body) => createClient().recordIncident(body),
  resolve: (scope, key) => createClient().resolveIncidents(scope, key),
}

/** Windows' scheduled tasks, as a windowsTask routine uses them. The default is PowerShell and schtasks. */
export interface RoutineTasks {
  read(paths: string[]): Promise<TaskReading[]>
  run(path: string): Promise<void>
  setEnabled(path: string, enabled: boolean): Promise<void>
}

export interface RoutinesOptions {
  /** Test seam: scales every routine's timeout (its minutes times this). The server leaves it at 1. */
  timeoutScale?: number
  /** Test seam: the clock. The server leaves it at Date.now. */
  now?: () => number
  /** Test seam: the chats a prompt run uses. */
  workers?: RoutineWorkers
  /** Test seam: the Windows tasks a windowsTask routine uses. */
  tasks?: RoutineTasks
  /** Test seam: the incidents a failed or timed-out run opens and an ok run resolves. The server posts to AgentHydra. */
  incidents?: RoutineIncidents
  /** Test seam: the platform a windowsTask routine needs. */
  platform?: NodeJS.Platform
  /** Test seam: what describes a run. The server asks Haiku 5.5 (routines/describe.ts). */
  describer?: Describer
}

const liveWorkers: RoutineWorkers = {
  start: (task) => bridge().startWorker(task),
  read: async (id) => (await bridge().workersByIds([id]))[0] ?? null,
  cancel: (id) => bridge().cancelWorker(id),
}

const liveTasks: RoutineTasks = { read: readTasks, run: runTaskNow, setEnabled: setTaskEnabled }

const pad = (n: number): string => String(n).padStart(2, '0')
/** A local time, YYYY-MM-DD HH:mm. */
const localStamp = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** A local time as the chat group's stamp, YYYYMMDDHHmm. */
const groupStamp = (ms: number): string => localStamp(ms).replace(/[-: ]/g, '')

/** <home>/routines.json, or empty memory when it is missing or damaged (a forgotten run only means a routine counts from zero). */
function load(file: string): Record<string, Memory> {
  let saved: { routines?: unknown } | null = null
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') console.error('[routines] routines.json did not load; starting with no memory:', err)
  }
  const routines = saved?.routines && typeof saved.routines === 'object' && !Array.isArray(saved.routines) ? (saved.routines as Record<string, Partial<Memory>>) : {}
  // Keyed by routine id with no prototype: a plain object handed a routine named "constructor" Object's own function as
  // its memory, and the whole list failed.
  const memory: Record<string, Memory> = Object.create(null)
  return Object.assign(memory, Object.fromEntries(
    // Only routine ids: a run's files are named by its id, so a key that is not one never names a path.
    Object.entries(routines).filter(([id]) => ROUTINE_ID.test(id)).map(([id, m]) => {
      const mem: Memory = {
        runs: Array.isArray(m?.runs) ? m.runs.slice(0, RUNS_KEPT).map((r) => (r?.description?.state === 'pending' ? { ...r, description: RESTARTED } : r)) : [],
        running: null,
        lastSlot: typeof m?.lastSlot === 'number' ? m.lastSlot : null,
        paused: m?.paused === true,
      }
      // A run still marked running when AgentHydra started again goes on: a prompt run's chat runs on, and a command run's
      // runner is outside Desk's process tree. The first look reads whether it ended meanwhile.
      if (m?.running && Number.isFinite(m.running.startedAt)) {
        const workerId = typeof m.running.workerId === 'string' ? m.running.workerId : null
        const pid = typeof m.running.pid === 'number' ? m.running.pid : null
        // A run kept without its kind (a Desk before 2026-10-13) is a prompt run when it has its chat, else a command run.
        const kind = m.running.kind === 'prompt' || workerId ? 'prompt' : 'command'
        mem.running = { startedAt: m.running.startedAt, kind, pid: workerId ? null : pid, workerId, sessionId: null }
      }
      return [id, mem]
    }),
  ))
}

/** How long ago a file was last written, ms; null when it is not there. */
function ageMs(file: string): number | null {
  try {
    return Date.now() - statSync(file).mtimeMs
  } catch {
    return null
  }
}

/** A routine or proposal file, whole or not at all: a crash mid-write leaves the file as it was, never half of one. */
function writeWhole(file: string, body: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFlushed(tmp, `${JSON.stringify(body, null, 2)}\n`)
  renameOver(tmp, file)
}

function outcomeOf(r: Pick<RunResult, 'code' | 'timedOut' | 'error'>): RoutineOutcome {
  if (r.timedOut) return 'timed-out'
  if (r.error === null && r.code === 0) return 'ok'
  if (r.error === null && r.code === BUSY_EXIT) return 'busy'
  return 'failed'
}

/** A routine's file body, as written: the contract without its id (the file name) and without `why`. */
function contractOf(def: RoutineDefinition | RoutineProposal): Record<string, unknown> {
  const body: Record<string, unknown> = { ...def }
  delete body.id
  return body
}

export default function plugin(app: Hono, ctx: ServerContext, opts: RoutinesOptions = {}): void {
  // Absolute: the runner WMI starts sits in system32, and reads these paths from there.
  const routinesDir = resolve(ctx.home, 'routines')
  const proposedDir = join(routinesDir, 'proposed')
  const logsDir = join(routinesDir, 'logs')
  const runsDir = join(routinesDir, 'runs')
  const file = join(ctx.home, 'routines.json')
  const historyDir = join(routinesDir, 'history')
  const historyFile = (id: string): string => join(historyDir, `${id}.jsonl`)
  const writer = new AsyncFile(file)
  const timeoutScale = opts.timeoutScale ?? 1
  const clock = opts.now ?? Date.now
  const platform = opts.platform ?? process.platform
  const workers = opts.workers ?? liveWorkers
  const incidents = opts.incidents ?? liveIncidents
  const tasks = opts.tasks ?? liveTasks
  const describer = opts.describer ?? sdkDescriber(ctx.home, () => bridge().listAccounts(), () => claudeCodeBinaryFor(ctx.home).path())
  const memory = load(file)
  /** The routines whose broken file this Desk has reported and not yet seen check out (in memory: a restart re-reports). */
  const reportedBroken = new Set<string>()
  /** The prompt runs this Desk is starting (`<id>@<startedAt>`): their chat id is not known yet. */
  const startingPrompts = new Set<string>()
  let settling: Promise<void> | null = null
  let seen: Seen[] = []
  let proposals: RoutineProposal[] = []
  let checkedAt: number | null = null
  let nextCheckAt: number | null = null
  let lastError: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let looking: Promise<void> | null = null
  let stopping = false

  const enabled = (): boolean => ctx.settings().routines && !stopping
  /** A routine's memory. The first time it is seen, a schedule starts from its newest slot: a slot already past never runs. */
  const memOf = (entry: Entry, t: number): Memory => {
    if (!runCounts.has(entry.id) && memory[entry.id]) keepHistory(entry.id, memory[entry.id])
    memory[entry.id] ??= emptyMemory(entry.def?.schedule !== undefined ? (slotsOf(entry, t)?.newest ?? t) : null)
    return memory[entry.id]
  }

  function save(): void {
    writer.write(JSON.stringify({ routines: memory }))
  }

  /** A status command's reading, or why it did not read. A failure is its reason, never a guess. */
  async function readStatus(def: RoutineDefinition): Promise<{ reading: Reading | null; readError: string | null }> {
    if (!def.status) return { reading: null, readError: null }
    const unread = (readError: string): { reading: null; readError: string } => ({ reading: null, readError })
    const r = await runArgv(def.status, { cwd: def.cwd, timeoutMs: STATUS_MS })
    if (r.timedOut) return unread('the status command timed out after 60 seconds')
    if (r.error !== null) return unread(`the status command could not start: ${r.error}`)
    if (r.code !== 0) return unread(`the status command exited ${r.code ?? 'without a code'}`)
    try {
      return { reading: parseReading(r.stdout), readError: null }
    } catch (err) {
      return unread(message(err))
    }
  }

  /** Writes what the memory holds that the routine's full history does not (a new run; the first time, all of them). Best effort. */
  const runCounts = new Map<string, number>()
  function keepHistory(id: string, mem: Memory): void {
    try {
      syncHistory(historyFile(id), mem.runs)
      runCounts.set(id, readHistory(historyFile(id)).length)
    } catch (err) {
      console.error('[routines] history did not save:', message(err))
    }
  }
  /** Records a run and keeps the newest RUNS_KEPT of them. When its routine describes its runs, a run that printed
   *  something (`output`) and was not busy is described in the background. */
  function finishRun(id: string, mem: Memory, r: RoutineRun, output = ''): void {
    const def = seen.find((s) => s.entry.id === id)?.entry.def
    const described = def?.describe === true && r.outcome !== 'busy' && output.trim() !== ''
    if (described) r.description = { state: 'pending', text: '' }
    mem.runs.unshift(r)
    mem.runs.splice(RUNS_KEPT)
    mem.running = null
    save()
    keepHistory(id, mem)
    reportIncident(id, def?.name ?? id, r)
    if (described) void describeRun(id, def, r, output)
  }

  /** A failed or timed-out run opens the routine's incident and pings the owner; an ok run resolves it. Best effort:
   *  an AgentHydra that is down keeps the incident as it was, and the next run of this routine settles it. */
  function reportIncident(id: string, name: string, r: RoutineRun): void {
    const action = routineIncidentAction({ id, name }, r)
    if (!action) return
    const sent = action.kind === 'record'
      ? incidents.record({ scope: action.scope, key: action.key, message: action.message })
      : incidents.resolve(action.scope, action.key)
    sent.catch(() => undefined)
  }

  /** A routine whose file does not check out, its Windows task is missing, or it is a Windows task off Windows: its reason, else null. */
  function brokenReason(s: Seen): string | null {
    if (s.entry.broken !== null) return s.entry.broken
    if (s.task !== null && !s.task.found) return `no Windows task ${s.entry.def?.windowsTask}`
    return null
  }

  /** A broken routine opens one incident until it checks out again, then resolves it. A failed last run keeps its incident open. */
  function reportBroken(s: Seen): void {
    const id = s.entry.id
    const reason = brokenReason(s)
    if (reason !== null) {
      if (reportedBroken.has(id)) return
      reportedBroken.add(id)
      const name = s.entry.def?.name ?? (s.entry.broken === null ? undefined : s.entry.name) ?? id
      incidents.record({ scope: 'routine', key: id, message: routineBrokenMessage({ id, name }, reason) }).catch(() => undefined)
      return
    }
    if (!reportedBroken.delete(id)) return
    const last = memory[id]?.runs[0]
    if (last?.outcome === 'failed' || last?.outcome === 'timed-out') return
    incidents.resolve('routine', id).catch(() => undefined)
  }

  /** Asks for a run's description and keeps it on the run, found again by its start. A failure keeps its reason. */
  async function describeRun(id: string, def: RoutineDefinition, r: RoutineRun, output: string): Promise<void> {
    let description: RunDescription
    try {
      const minutes = Math.round((r.endedAt - r.startedAt) / 6_000) / 10
      const text = await describer({ name: def.name, what: r.workerId ? 'prompt' : 'command', outcome: r.outcome, exitCode: r.exitCode, minutes, output })
      description = { state: 'done', text }
    } catch (err) {
      description = { state: 'failed', text: message(err).slice(0, LINE_CHARS) }
    }
    const kept = memory[id]?.runs.find((x) => x.startedAt === r.startedAt)
    if (!kept || stopping) return
    kept.description = description
    save()
    try {
      appendRows(historyFile(id), [descriptionRow(r.startedAt, description)])
    } catch (err) {
      console.error('[routines] history did not save:', message(err))
    }
  }

  /** Starts a command run: its runner (routines/runner.ts), hidden and outside Desk's process tree, runs it, writes its log
   *  and says how it ended; settleCommands reads that. */
  function startCommand(def: RoutineDefinition, mem: Memory, startedAt: number): void {
    mkdirSync(logsDir, { recursive: true })
    mkdirSync(runsDir, { recursive: true })
    const log = join(logsDir, `${def.id}.log`)
    try {
      if (statSync(log).size > LOG_MAX_BYTES) renameSync(log, `${log}.1`)
    } catch {
      // No log yet.
    }
    const paths = runPaths(runsDir, def.id)
    const spec: RunSpec = {
      id: def.id,
      startedAt,
      launchedAt: startedAt + (Date.now() - clock()),
      argv: def.run ?? [],
      // A runner WMI starts sits in system32: the folder is resolved here, against Desk's own, as the run had it before.
      cwd: resolve(process.cwd(), def.cwd ?? '.'),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' } as Record<string, string>,
      timeoutMs: (def.timeoutMinutes ?? TIMEOUT_DEFAULT) * 60_000 * timeoutScale,
      log,
    }
    const notStarted = (why: string): void =>
      finishRun(def.id, mem, { startedAt, endedAt: clock(), outcome: 'failed', exitCode: null, lastLine: `its runner could not start: ${why}`.slice(0, LINE_CHARS), workerId: null, sessionId: null })
    try {
      for (const f of [paths.spec, paths.taken, paths.run, paths.result]) rmSync(f, { force: true })
      writeJson(paths.spec, spec)
      // The powershell is a console program (hidden); it exits once WMI has started the runner. When it could not, the
      // run fails at once with its reason, the spec taken back as settleCommands takes back one no runner came for.
      startDetached([process.execPath, RUNNER_ENTRY, '--spec', paths.spec], (why) => {
        if (mem.running?.startedAt !== startedAt || !takeBack(paths.spec)) return
        notStarted(why)
      })
    } catch (err) {
      rmSync(paths.spec, { force: true })
      notStarted(message(err))
    }
  }

  /** Takes a spec back from a runner that has not come for it: false when the runner took it first. */
  function takeBack(spec: string): boolean {
    try {
      renameSync(spec, `${spec}.cancelled`)
    } catch {
      return false
    }
    try {
      rmSync(`${spec}.cancelled`, { force: true })
    } catch {
      // Held for a moment: the routine's next start clears its files.
    }
    return true
  }

  /** Off Windows a command leads its own process group, which its runner's end does not end: once the runner is gone or
   *  ended, its group is ended too, when its leader is proven to be the command still (by its start). On Windows the
   *  runner's end ended its command (Bun ends its children). */
  async function endCommandGroup(runner: RunFile): Promise<void> {
    if (process.platform === 'win32' || runner.commandPid === null || typeof runner.commandStartedAt !== 'number') return
    if ((await recordedPidOwner(runner.commandPid, runner.commandStartedAt)) !== 'ours') return
    try {
      process.kill(-runner.commandPid, 'SIGKILL')
    } catch {
      // Its group has ended.
    }
  }

  /** The runs a look cannot watch from outside, read from their runners' files (routines/runner.ts): a command run whose
   *  runner wrote how it ended is recorded; one whose runner is gone without a word, interrupted; one past its timeout that
   *  its runner did not end is ended here; one whose runner never came for its spec, not started. A prompt run that never
   *  got its chat (Desk stopped as it started one) is interrupted. Each by the kind it started as, whatever its routine's
   *  file says now. One reading at a time, so no run is recorded twice; a run is recorded, and on disk, before its files go. */
  function settleCommands(): Promise<void> {
    settling ??= (async () => {
      for (const [id, mem] of Object.entries(memory)) {
        const running = mem.running
        if (!running || running.workerId) continue
        const key = `${id}@${running.startedAt}`
        const def = seen.find((s) => s.entry.id === id)?.entry.def
        const t = clock()
        if (running.kind === 'prompt') {
          if (!startingPrompts.has(key))
            finishRun(id, mem, { startedAt: running.startedAt, endedAt: t, outcome: 'interrupted', exitCode: null, lastLine: 'AgentHydra restarted before its chat started', workerId: null, sessionId: null })
          continue
        }
        const paths = runPaths(runsDir, id)
        const record = (r: Pick<RoutineRun, 'endedAt' | 'outcome' | 'lastLine'> & { exitCode?: number | null }, output = ''): void => {
          finishRun(id, mem, { startedAt: running.startedAt, exitCode: null, workerId: null, sessionId: null, ...r }, output)
          if (def?.status) refreshStatus(def)
          try {
            writer.flushSync()
          } catch {
            return // Not on disk yet: a later save lands the record, and the routine's next start clears its files.
          }
          for (const f of [paths.spec, paths.taken, paths.run, paths.result]) {
            try {
              rmSync(f, { force: true })
            } catch {
              // Held for a moment (an indexer): the routine's next start clears it.
            }
          }
        }
        /** Records the run when its runner wrote how it ended. */
        const ended = (): boolean => {
          const result = readJson<RunResult>(paths.result)
          if (result?.startedAt !== running.startedAt) return false
          record({ endedAt: running.startedAt + result.durationMs, outcome: outcomeOf(result), exitCode: result.code, lastLine: result.lastLine }, result.output ?? result.lastLine)
          return true
        }
        if (ended()) continue
        const runner = readJson<RunFile>(paths.run)
        if (runner?.startedAt === running.startedAt) {
          if (running.pid !== runner.pid) {
            running.pid = runner.pid
            save()
          }
          const owner = pidAlive(runner.pid) ? await recordedPidOwner(runner.pid, runner.pidStartedAt) : 'foreign'
          if (owner !== 'foreign') {
            const minutes = def?.timeoutMinutes ?? TIMEOUT_DEFAULT
            if (t - running.startedAt < minutes * 60_000 * timeoutScale + RUNNER_GRACE_MS) continue
            // Its runner ends the command at the timeout and then itself; one still going hangs, and is ended here. A pid
            // whose start cannot be read is never killed: it is most likely a process that took the number since, one
            // this user cannot read. Nothing would ever end that run, so it is closed, its process left alone.
            if (owner === 'unknown') {
              if (!ended()) record({ endedAt: t, outcome: 'interrupted', lastLine: `its runner could not be checked past its ${minutes}-minute timeout, so Desk stopped watching it and ended nothing` })
              continue
            }
            if (!(await killHostTree(runner.pid, runner.pidStartedAt))) continue
            await endCommandGroup(runner)
            if (!ended()) record({ endedAt: t, outcome: 'timed-out', lastLine: `timed out after ${minutes} minutes; its runner did not end it, so Desk did` })
            continue
          }
          // Gone. Its result may have landed after the read above.
          if (ended()) continue
          await endCommandGroup(runner)
          if (!ended()) record({ endedAt: t, outcome: 'interrupted', lastLine: 'its runner ended without saying how the run ended' })
          continue
        }
        // No runner file. A spec taken: the runner is saying it runs (a moment), or it died there.
        const takenAge = ageMs(paths.taken)
        if (takenAge !== null) {
          if (takenAge < RUNNER_START_MS) continue
          if (!ended()) record({ endedAt: t, outcome: 'interrupted', lastLine: 'its runner stopped as it started' })
          continue
        }
        // A spec waiting: the runner has not come yet. Past the start window Desk takes it back, so a runner that comes late
        // finds nothing to run.
        const specAge = ageMs(paths.spec)
        if (specAge !== null) {
          if (specAge < RUNNER_START_MS) continue
          if (!takeBack(paths.spec)) continue // The runner took it just now.
          record({ endedAt: t, outcome: 'failed', lastLine: `its runner did not start within ${RUNNER_START_MS / 1000} seconds` })
          continue
        }
        // Nothing at all, or the spec gone since the read above: a run from a Desk before runners, or one whose runner
        // has just taken its spec.
        if (existsSync(paths.taken) || existsSync(paths.run) || ended()) continue
        record({ endedAt: t, outcome: 'interrupted', lastLine: 'AgentHydra restarted' })
      }
    })().finally(() => (settling = null))
    return settling
  }

  /** Reads a routine's status again after its run ended, in the background, so the page shows what the run left. */
  function refreshStatus(def: RoutineDefinition): void {
    void readStatus(def).then((fresh) => {
      seen = seen.map((s) => (s.entry.id === def.id ? { ...s, ...fresh } : s))
    })
  }

  /** Starts a prompt run: a Desk chat, its prompt led by a short header that says whose routine it is and who asked for it. */
  async function startPrompt(def: RoutineDefinition, mem: Memory, startedAt: number): Promise<void> {
    const header = `This is the routine "${def.name}" run by AgentHydra's routine manager at ${localStamp(startedAt)}; asked for by ${def.askedBy}. Do exactly what it says; never create, change, pause or schedule any routine or scheduled task.`
    const key = `${def.id}@${startedAt}`
    startingPrompts.add(key)
    try {
      const w = await workers.start({
        prompt: `${header}\n\n${def.prompt ?? ''}`,
        cwd: def.cwd ?? '',
        title: `Routine: ${def.name}`,
        group: `routine-${def.id}-${groupStamp(startedAt)}`,
        desk: chatAddOns(def.cwd ?? '', false),
      })
      mem.running = { startedAt, kind: 'prompt', pid: null, workerId: w.id, sessionId: w.sessionId }
      save()
    } catch (err) {
      finishRun(def.id, mem, { startedAt, endedAt: clock(), outcome: 'failed', exitCode: null, lastLine: message(err).slice(0, LINE_CHARS), workerId: null, sessionId: null })
    } finally {
      startingPrompts.delete(key)
    }
  }

  /** Starts one run of a routine now. The run is marked running before anything waits, so no second run starts meanwhile.
   *  It starts at the clock's now, not at its look's: the status commands a look reads first can take a minute. */
  function startRun(def: RoutineDefinition, mem: Memory, slot: number | null): void {
    const t = clock()
    mem.running = { startedAt: t, kind: def.prompt !== undefined ? 'prompt' : 'command', pid: null, workerId: null, sessionId: null }
    if (slot !== null) mem.lastSlot = slot
    save()
    if (def.prompt !== undefined) void startPrompt(def, mem, t)
    else startCommand(def, mem, t)
  }

  /** The prompt runs going on: each whose chat has ended is recorded; each past its timeout is cancelled and recorded. */
  async function pollPrompts(t: number): Promise<void> {
    for (const [id, mem] of Object.entries(memory)) {
      const running = mem.running
      if (!running?.workerId) continue
      const workerId = running.workerId
      const minutes = seen.find((s) => s.entry.id === id)?.entry.def?.timeoutMinutes ?? TIMEOUT_DEFAULT
      let w: WorkerView | null
      try {
        w = await workers.read(workerId)
      } catch {
        continue
      }
      if (w && isActiveWorkerStatus(w.status)) {
        if (t - running.startedAt < minutes * 60_000 * timeoutScale) continue
        await workers.cancel(workerId).catch(() => undefined)
        finishRun(id, mem, { startedAt: running.startedAt, endedAt: clock(), outcome: 'timed-out', exitCode: null, lastLine: `timed out after ${minutes} minutes`, workerId, sessionId: running.sessionId })
        continue
      }
      const failed = !w || w.error !== null || /fail|cancel|stop|error/.test(w.status)
      const last = w ? lastLineOf(w.result ?? w.error ?? '') || w.status : 'its chat is gone'
      finishRun(id, mem, { startedAt: running.startedAt, endedAt: clock(), outcome: failed ? 'failed' : 'ok', exitCode: null, lastLine: last.slice(0, LINE_CHARS), workerId, sessionId: w?.sessionId ?? running.sessionId }, w?.result ?? '')
    }
  }

  /** A Windows task's last run, recorded once when it is newer than the newest one kept. Still running, or never ran: nothing. */
  function recordTaskRun(s: Seen, mem: Memory): void {
    const task = s.task
    if (!task?.found || task.lastRunAt === null || task.lastTaskResult === null) return
    if (task.lastTaskResult === TASK_RUNNING || task.lastTaskResult === TASK_NEVER_RAN) return
    if (mem.runs[0] && task.lastRunAt <= mem.runs[0].startedAt) return
    const code = task.lastTaskResult
    // Windows says when a task started and never when it ended, so its start stands for both. The time of this look
    // is no run time: after a restart every task read as run minutes ago (2026-10-12: a 03:00 run read "21 min ago").
    mem.runs.unshift({ startedAt: task.lastRunAt, endedAt: task.lastRunAt, outcome: code === 0 ? 'ok' : 'failed', exitCode: code, lastLine: `Windows task result ${code}`, workerId: null, sessionId: null })
    mem.runs.splice(RUNS_KEPT)
    save()
    keepHistory(s.entry.id, mem)
  }

  /** Reads each routine's file, status and Windows task. A windowsTask routine off Windows is broken; the tasks are read in one call. */
  async function readAll(): Promise<{ seen: Seen[]; proposals: RoutineProposal[] }> {
    const entries = readEntries(routinesDir, parseRoutineText).map((e): Entry => {
      if (e.def?.windowsTask !== undefined && platform !== 'win32') return { id: e.id, def: null, broken: 'a Windows task runs only on Windows' }
      return e
    })
    const names = [...new Set(entries.flatMap((e) => (e.def?.windowsTask !== undefined ? [e.def.windowsTask] : [])))]
    let readings: TaskReading[] = []
    let taskError: string | null = null
    if (names.length) {
      try {
        readings = await tasks.read(names)
      } catch (err) {
        taskError = `Windows could not read its tasks: ${message(err)}`
      }
    }
    const reads = await Promise.all(
      entries.map(async (entry): Promise<Seen> => {
        const path = entry.def?.windowsTask
        if (path !== undefined) return { entry, reading: null, readError: taskError, task: readings.find((r) => r.path === path) ?? null }
        const status = entry.def ? await readStatus(entry.def) : { reading: null, readError: null }
        return { entry, reading: status.reading, readError: status.readError, task: null }
      }),
    )
    const found = readEntries(proposedDir, parseProposalText).flatMap((e) => (e.def ? [e.def] : []))
    return { seen: reads, proposals: found }
  }

  /** One look: reads everything, judges, and starts the runs that fell due. One look at a time. */
  function look(): Promise<void> {
    looking ??= (async () => {
      try {
        const t = clock()
        await pollPrompts(t)
        const read = await readAll()
        seen = read.seen
        proposals = read.proposals
        // After the read, so each run is settled against its routine's own file.
        await settleCommands()
        lastError = null
        checkedAt = t
        for (const s of seen) {
          reportBroken(s)
          const mem = memOf(s.entry, t)
          recordTaskRun(s, mem)
          const j = judge(s, mem, t, enabled(), false)
          if (j.skipSlot !== null) mem.lastSlot = j.skipSlot
          if (j.start && s.entry.def) startRun(s.entry.def, mem, j.slot)
        }
        save()
      } catch (err) {
        lastError = `the last look failed: ${message(err)}`
        console.error('[routines] look failed:', err)
      } finally {
        schedule()
      }
    })().finally(() => (looking = null))
    return looking
  }

  /** The next look: in ROUTINES_EVERY_MS, or sooner for the earliest schedule slot (+1 s) or a prompt run being watched. */
  function schedule(delay?: number): void {
    clearTimeout(timer)
    timer = undefined
    nextCheckAt = null
    if (stopping) return
    const t = clock()
    let wait = delay ?? ROUTINES_EVERY_MS
    if (delay === undefined) {
      for (const s of seen) {
        const next = slotsOf(s.entry, t)?.next
        if (next !== null && next !== undefined) wait = Math.min(wait, next - t + 1000)
      }
      if (Object.values(memory).some((m) => m.running?.workerId)) wait = Math.min(wait, PROMPT_LOOK_MS)
    }
    wait = Math.max(wait, 1000)
    nextCheckAt = t + wait
    timer = setTimeout(() => void look(), wait)
    // A look never keeps the process alive: Desk stopping stops it.
    ;(timer as { unref?: () => void }).unref?.()
  }

  function routineView(s: Seen, t: number): Routine {
    const { entry } = s
    const def = entry.def
    const mem = memory[entry.id] ?? emptyMemory()
    const j = judge(s, mem, t, enabled(), false)
    return {
      id: entry.id,
      name: def?.name ?? (entry.def === null ? entry.name : undefined) ?? entry.id,
      kind: def ? kindOf(def) : null,
      state: j.state,
      reason: j.reason,
      askedBy: def?.askedBy ?? null,
      schedule: def?.schedule ?? null,
      windowsTask: def?.windowsTask ?? null,
      what: def?.run !== undefined ? 'run' : def?.prompt !== undefined ? 'prompt' : null,
      prompt: def?.prompt ?? null,
      command: def?.run ?? null,
      statusCommand: def?.status ?? null,
      cwd: def?.cwd ?? null,
      timeoutMinutes: def?.timeoutMinutes ?? null,
      until: def?.until ?? null,
      paused: def?.windowsTask !== undefined ? s.task?.state === 'Disabled' : mem.paused,
      describe: def?.describe === true,
      headline: s.reading?.headline ?? null,
      totals: s.reading?.totals ?? null,
      settings: s.reading?.settings ?? null,
      lastRunAt: def?.windowsTask !== undefined ? (mem.runs[0]?.endedAt ?? null) : lastEndOf(s.reading, mem),
      nextRunAt: j.nextRunAt,
      running: mem.running ? { ...mem.running } : null,
      runs: [...mem.runs],
      runsTotal: Math.max(mem.runs.length, runCounts.get(entry.id) ?? 0),
    }
  }

  function status(): RoutinesStatus {
    const t = clock()
    return { enabled: enabled(), everyMs: ROUTINES_EVERY_MS, checkedAt, nextCheckAt, routines: seen.map((s) => routineView(s, t)), proposals, error: lastError }
  }

  ctx.onStop(async () => {
    stopping = true
    clearTimeout(timer)
    timer = undefined
    // A running run is not killed: a prompt run's chat runs on, and a command run's runner is outside Desk's tree.
    writer.flushSync()
    // A write already under way finishes, so it leaves no temp file behind.
    await writer.quiet()
  })

  app.get('/api/routines/:id/details', (c) => {
    const id = c.req.param('id')
    if (!ROUTINE_ID.test(id)) return c.json({ error: 'no such routine' }, 404)
    const s = seen.find((x) => x.entry.id === id)
    if (!s && !memory[id]) return c.json({ error: 'no such routine' }, 404)
    const mem = memory[id]
    if (mem) keepHistory(id, mem)
    const all = readHistory(historyFile(id))
    const beforeQ = Number(c.req.query('before'))
    const limitQ = Number(c.req.query('limit'))
    const limit = Number.isFinite(limitQ) && limitQ >= 1 ? Math.min(Math.floor(limitQ), 500) : 50
    const page = pageOf(all, Number.isFinite(beforeQ) && c.req.query('before') ? beforeQ : null, limit)
    const r = s?.reading
    const details: RoutineDetails = {
      id,
      name: s?.entry.def?.name ?? (s && s.entry.def === null ? s.entry.name : undefined) ?? id,
      runs: page.runs,
      nextBefore: page.nextBefore,
      stats: statsOf(all, clock()),
      counters: sumCounters(all),
      totals: r?.totals ?? null,
      headline: r?.headline ?? null,
      numbers: r?.numbers ?? null,
      trends: r?.trends ?? null,
    }
    return c.json(details)
  })

  app.get('/api/routines', async (c) => {
    if (checkedAt === null || c.req.query('fresh') === '1') await look()
    else
      await settleCommands().catch((err) => {
        lastError = `reading the runs failed: ${message(err)}`
        console.error('[routines] reading the runs failed:', err)
      })
    return c.json(status())
  })

  app.post('/api/routines', async (c) => {
    const body = (await c.req.json().catch(() => null)) as RoutinesRequest | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: SHAPE }, 400)
    const actions = ACTIONS.filter((k) => body[k] !== undefined)
    const typed = actions.every((k) =>
      k === 'propose'
        ? typeof body.propose === 'object' && body.propose !== null
        : k === 'edit'
          ? typeof body.edit?.id === 'string' && typeof body.edit.set === 'object' && body.edit.set !== null && !Array.isArray(body.edit.set)
          : typeof body[k] === 'string',
    )
    if (
      (body.enabled !== undefined && typeof body.enabled !== 'boolean') ||
      actions.length > 1 ||
      (actions.length === 0 && body.enabled === undefined) ||
      !typed
    )
      return c.json({ error: SHAPE }, 400)
    const owner = callerKind(c.req.raw.headers) === 'window'
    const [action] = actions
    if (body.enabled !== undefined && !owner) return c.json(OWNER_ONLY, 403)
    if (action !== undefined && OWNER_ACTIONS.includes(action) && !owner) return c.json(OWNER_ONLY, 403)
    const id = action === 'propose' ? '' : action === 'edit' ? body.edit!.id : (body[action as 'run'] ?? '')
    if (action !== undefined && action !== 'propose' && !ROUTINE_ID.test(id)) return c.json({ error: `"${id}" is not a routine id` }, 400)

    if (body.enabled !== undefined && body.enabled !== ctx.settings().routines) ctx.updateSettings({ routines: body.enabled })
    if (body.enabled === true) await look()
    if (action === undefined) return c.json(status())

    const t = clock()
    if (action === 'run') {
      await look()
      const s = seen.find((x) => x.entry.id === id)
      if (!s) return c.json({ error: `no routine "${id}" is registered: routines/${id}.json is missing` }, 404)
      const def = s.entry.def
      const mem = memOf(s.entry, t)
      if (def?.windowsTask !== undefined) {
        const j = judge(s, mem, t, enabled(), false)
        if (j.state !== 'idle') return c.json({ error: `"${id}" is ${j.state}: ${j.reason}` }, 409)
        try {
          await tasks.run(def.windowsTask)
        } catch (err) {
          return c.json({ error: `Windows refused to run "${id}": ${message(err)}` }, 500)
        }
        await look()
        return c.json(status())
      }
      const j = judge(s, mem, t, enabled(), true)
      if (!j.start || !def) return c.json({ error: `"${id}" is ${j.state}: ${j.reason}` }, 409)
      startRun(def, mem, null)
      return c.json(status())
    }

    if (action === 'pause' || action === 'resume') {
      const s = seen.find((x) => x.entry.id === id)
      if (!s) return c.json({ error: `no routine "${id}" is registered: routines/${id}.json is missing` }, 404)
      const path = s.entry.def?.windowsTask
      if (path !== undefined) {
        try {
          await tasks.setEnabled(path, action === 'resume')
        } catch (err) {
          return c.json({ error: `Windows refused to ${action} "${id}": ${message(err)}` }, 500)
        }
      } else {
        memOf(s.entry, t).paused = action === 'pause'
        save()
      }
      await look()
      return c.json(status())
    }

    if (action === 'edit') {
      // The owner's edit (its Edit form, its Describe runs switch) writes the routine's own file: the keys `set` names,
      // null removing one, every other key as it was. One that would not check out is refused and the file left alone.
      const routineFile = join(routinesDir, `${id}.json`)
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(readFileSync(routineFile, 'utf8')) as Record<string, unknown>
      } catch {
        return c.json({ error: `no routine "${id}" is registered: routines/${id}.json is missing or not JSON` }, 404)
      }
      const next: Record<string, unknown> = { ...raw }
      for (const [key, value] of Object.entries(body.edit!.set)) {
        if (value === null) delete next[key]
        else next[key] = value
      }
      try {
        checkDefinition(id, next)
      } catch (err) {
        return c.json({ error: `"${id}" was not saved: ${message(err)}` }, 409)
      }
      writeWhole(routineFile, next)
      await look()
      return c.json(status())
    }

    if (action === 'propose') {
      const raw = body.propose as unknown as Record<string, unknown>
      const pid = typeof raw.id === 'string' ? raw.id : ''
      let proposal: RoutineProposal
      try {
        const rest = { ...raw }
        delete rest.id
        proposal = checkProposal(pid, rest)
      } catch (err) {
        return c.json({ error: `the proposal is refused: ${message(err)}` }, 400)
      }
      if (existsSync(join(routinesDir, `${pid}.json`)) || existsSync(join(proposedDir, `${pid}.json`)))
        return c.json({ error: `"${pid}" already exists as a routine or a proposal` }, 409)
      mkdirSync(proposedDir, { recursive: true })
      writeWhole(join(proposedDir, `${pid}.json`), contractOf(proposal))
      await look()
      return c.json(status())
    }

    // approve and discard: the window only (checked above). Each acts on the proposal file of that id.
    const proposal = join(proposedDir, `${id}.json`)
    if (!existsSync(proposal)) return c.json({ error: `no proposal "${id}" is waiting` }, 404)
    if (action === 'discard') {
      rmSync(proposal, { force: true })
      await look()
      return c.json(status())
    }
    if (existsSync(join(routinesDir, `${id}.json`))) return c.json({ error: `a routine "${id}" already exists` }, 409)
    let approved: RoutineProposal
    try {
      approved = parseProposalText(id, readFileSync(proposal, 'utf8'))
    } catch (err) {
      return c.json({ error: `the proposal does not check out: ${message(err)}` }, 400)
    }
    const body2 = contractOf(approved)
    delete body2.why
    writeWhole(join(routinesDir, `${id}.json`), body2)
    rmSync(proposal, { force: true })
    await look()
    return c.json(status())
  })

  // The first look waits for the rest of Desk to come up.
  schedule(FIRST_LOOK_MS)
}
