// One run of a routine's command, outside Desk's process tree. The manager (plugins/73-routines.ts) starts it with
// host/launch.ts detachedCommand, the way chat hosts and the dev-servers service start: on Windows a process Desk starts
// dies with Desk, so a restart killed every command run going on (2026-10-12: an Archangel tick and the HSwarm job under
// it, 16 minutes in, because another chat restarted Desk). The runner takes its spec by renaming it (Desk takes a spec the
// runner never came for the same way, so exactly one of them has it), says it is running in <id>.run.json, deletes the spec
// (the environment travels in it: WMI starts the runner with the user's default one), appends the command's output to the
// routine's log, ends the command past its timeout, and writes how it ended to <id>.result.json, whole, before it goes. At
// every moment one of those files is there; Desk deletes them once it has recorded the run. A Desk that starts meanwhile
// reads them and goes on watching the run. On Windows Bun ends a process's own children when it ends, however it ends
// (measured 2026-10-12), so a runner that is killed takes its command with it (not what the command started in turn: that
// leaves Bun's job, measured 2026-10-13). Elsewhere the command leads its own process group, which Desk ends once it finds
// the runner gone.

import { createWriteStream, readFileSync, renameSync, rmSync, utimesSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renameOver, writeFlushed } from '../write-flushed'
import { lastLineOf, runArgv } from './proc'

/** The runner program. */
export const RUNNER_ENTRY = join(import.meta.dir, 'runner.ts')

/** Output kept: its last line is the run's, and a routine that describes its runs has the whole tail read (describe.ts). */
const TAIL_CHARS = 16_384

/** What the manager hands the runner. `startedAt` names the run in the manager's memory (its clock); `launchedAt` is this
 *  machine's time at the start, so the run's length reads the same whichever clock the manager keeps. */
export interface RunSpec {
  id: string
  startedAt: number
  launchedAt: number
  argv: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  log: string
}

/** <id>.run.json: the runner's pid for the run `startedAt`, when the runner started (the proof that pid is still it), and
 *  the command's pid once it runs, with a time it had started by (off Windows it leads its own process group, which the
 *  runner's death does not end). */
export interface RunFile {
  startedAt: number
  pid: number
  pidStartedAt: number
  commandPid: number | null
  commandStartedAt: number | null
}

/** <id>.result.json: how the run `startedAt` ended. */
export interface RunResult {
  startedAt: number
  durationMs: number
  code: number | null
  timedOut: boolean
  error: string | null
  lastLine: string
  /** The end of what the command printed (absent from a runner before 2026-10-13). */
  output?: string
}

/** A routine's run files in `dir`: the spec, the spec the runner took (until it has said it runs), the runner's file and the
 *  result. */
export function runPaths(dir: string, id: string): { spec: string; taken: string; run: string; result: string } {
  const spec = join(dir, `${id}.spec.json`)
  return { spec, taken: `${spec}.taken`, run: join(dir, `${id}.run.json`), result: join(dir, `${id}.result.json`) }
}

/** Writes a JSON file whole (temp file + rename): a reader never sees half of one. */
export function writeJson(file: string, body: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFlushed(tmp, JSON.stringify(body))
  renameOver(tmp, file)
}

/** A JSON file's value, or null when it is missing or does not parse. */
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const at = process.argv.indexOf('--spec')
  const specPath = at > 0 ? process.argv[at + 1] : undefined
  if (!specPath) process.exit(2)
  const taken = `${specPath}.taken`
  try {
    renameSync(specPath, taken)
    // A rename keeps the spec's own time; Desk measures the take from now.
    const now = new Date()
    utimesSync(taken, now, now)
  } catch {
    // Desk gave up on this run before the runner came for it: it is no longer this runner's to run.
    process.exit(2)
  }
  /** A file held for a moment (an indexer) is left for Desk, which clears a routine's files at its next start. */
  const remove = (file: string): void => {
    try {
      rmSync(file, { force: true })
    } catch {
      // Left for Desk.
    }
  }
  const spec = readJson<RunSpec>(taken)
  if (!spec) {
    remove(taken)
    process.exit(2)
  }
  const paths = runPaths(dirname(specPath), spec.id)
  const said: RunFile = { startedAt: spec.startedAt, pid: process.pid, pidStartedAt: Date.now(), commandPid: null, commandStartedAt: null }
  writeJson(paths.run, said)
  remove(taken)
  const out = createWriteStream(spec.log, { flags: 'a' })
  // A log that cannot be written loses the output, never the run's result.
  out.on('error', () => undefined)
  out.write(`\n--- ${new Date(spec.launchedAt).toISOString()} ---\n`)
  let tail = ''
  const r = await runArgv(spec.argv, {
    cwd: spec.cwd,
    env: spec.env,
    timeoutMs: spec.timeoutMs,
    onStart: (child) => {
      try {
        if (child.pid !== undefined) writeJson(paths.run, { ...said, commandPid: child.pid, commandStartedAt: Date.now() } satisfies RunFile)
      } catch {
        // The command still gets its timeout and its log; only Desk's backstop loses its pid.
      }
    },
    onOutput: (text) => {
      out.write(text)
      tail = (tail + text).slice(-TAIL_CHARS)
    },
  })
  // The log is on disk before the result, so a run the page shows has its output.
  await new Promise<void>((done) => out.end(() => done()))
  const result: RunResult = {
    startedAt: spec.startedAt,
    durationMs: Date.now() - spec.launchedAt,
    code: r.code,
    timedOut: r.timedOut,
    error: r.error,
    lastLine: lastLineOf(tail) || (r.error ?? ''),
    output: tail,
  }
  // The run file stays: Desk deletes both once it has recorded the run, so no moment shows neither.
  writeJson(paths.result, result)
}

if (import.meta.main) await main()
