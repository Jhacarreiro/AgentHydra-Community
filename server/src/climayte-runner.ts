// server/src/climayte-runner.ts — the process a CliMayte worker's CLI runs under, OUTSIDE the daemon:
// what the daemon hands it and reads back.
//
// Owner, 2026-09-30: "I need to be able to restart AgentHydra without breaking CliMayte runners." A
// Bun.spawn child sits in the daemon's kill-on-close job on Windows, so every daemon restart killed
// every worker, which then resumed as 'interrupted' and redid its current step. `detached` is no
// escape (DETACHED_PROCESS flashes a console per child, and the job still holds it).
//
// So a worker's CLI runs under a RUNNER, launched through the WMI hand-off (detached-spawn.mjs,
// hidden), which is born outside the daemon's tree. The runner starts the CLI with the attempt's
// prompt, log and error files as its stdin/stdout/stderr, writes both pids, waits, and writes an exit
// file. The daemon only ever reads files: the log it already tails, the pid file, and the exit file
// for the end. A restarted daemon therefore finds its running workers still running and simply goes
// on reading them.
//
// On Windows the runner is misc/climayte-runner.exe (source beside it in misc/climayte-runner-native/),
// a small native program rather than this app in runner mode: a Bun runtime per worker measured
// 123-177 MB, about 3 GB with 20 workers, to wait on one process (owner, 2026-10-04: "instead of
// spinning up 50 of one thing"). One runner per worker stays on purpose: a runner that dies takes
// only its own worker with it. It also puts itself in a kill-on-close job
// before it starts the CLI, so what the session leaves running (a dev server, a watcher) ends with
// it and the exit file names it, and it answers the worker's wind-down hook over loopback http.
// Elsewhere the runner is still this app in `--climayte-runner` mode (climayte-runner-posix.ts).
//
// The spec carries the CLI's environment (WMI starts the runner with the user's default one, not
// the daemon's), so the runner deletes it the moment it has read it.
//
// The spec is also a single-owner claim. The runner takes it by renaming it to `.taken` before
// reading; the daemon voids an attempt that has not started by renaming it to `.void` (voidSpec in
// climayte-core.ts). Exactly one rename wins, so a cancel either stops the attempt before anything
// starts or knows the runner has it. Measured 2026-10-02: the WMI hand-off takes 0.4-2.2 s to reach
// that point, and three cancels 87-209 ms after launch each found no pid file, marked the attempt
// stopped and left the runner to run the CLI to completion ($0.145-0.150 and ~30k cache-write tokens
// each, charged to nothing).

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './climayte-core'
import { APP_ROOT, IS_RELEASE } from './config'
import { spawnCaptured } from './core/process'
import { buildDetachedSpawn } from './detached-spawn.mjs'
import { CLIMAYTE_RUNNER_FILE, embeddedMiscFiles } from './misc-assets'

export interface RunnerSpec {
  argv: string[]
  cwd: string
  env: Record<string, string>
  stdin: string
  stdout: string
  stderr: string
  pidFile: string
  exitFile: string
  /** The output files are new (a check's log): open them for writing, one handle when stdout and
   *  stderr are the same file. Git Bash cannot write through an append-only handle: its output
   *  vanished and `sleep` exited 1 (measured 2026-10-02), where the CLI appends to its logs fine. */
  fresh?: boolean
  /** A worker's wind-down channel (climayte-signal.ts): the runner answers the CLI's PostToolUse
   *  hook from `file` itself, and rewrites the `settings` file the CLI was given to say so before
   *  it starts the CLI. Absent for a check's log, which has no hooks. */
  signal?: { file: string; settings: string }
  /** The most processes the worker's tree may have alive at once, the runner included (the Windows
   *  runner's job ceiling). Absent: no ceiling, as for a check's log. */
  maxProcesses?: number
}

/** Written by the runner the moment it has claimed the spec (`runner` only), then again once the CLI
 *  has started (with `child`), so the daemon can tell a runner still starting from a dead one. */
export interface RunnerPids {
  runner: number
  child?: number
}

/** A process still running in the Windows runner's job when the CLI has exited. */
export interface Leftover {
  pid: number
  /** Its executable's file name, and its command line when it could be read (capped). */
  name: string
  command?: string
}

/** Written by the runner when the CLI has ended (or could not start: `error`). */
export interface RunnerExit {
  code: number | null
  signal: string | null
  endedAt: number
  error?: string
  /** What the CLI left running, ended when the runner's job closed (Windows). */
  left?: Leftover[]
  /** The most processes the worker's tree had alive at once, the runner and console hosts
   *  included (Windows, read every 2 s): what one worker really costs. The ceiling does not count
   *  console hosts, so this can read above it without anything having been refused. */
  peakProcesses?: number
}

/** The Windows runner as it ships: the checkout's misc/ or a bundle's misc/ beside the exe, else the
 *  copy a single-file build embeds (RUNTIME_MISC_FILES). Throws, naming the file, when neither is
 *  there. */
function nativeRunnerSource(): string {
  const onDisk = join(APP_ROOT, 'misc', CLIMAYTE_RUNNER_FILE)
  if (existsSync(onDisk)) return onDisk
  const embedded = embeddedMiscFiles()?.[CLIMAYTE_RUNNER_FILE]
  if (embedded) return embedded
  throw new Error(
    IS_RELEASE
      ? `${onDisk} is missing and this build embeds no copy of it: a build defect (scripts/build.ts embeds RUNTIME_MISC_FILES)`
      : `${onDisk} is missing from this checkout: build it with misc/climayte-runner-native/build.ps1`,
  )
}

/** Older copies are removed only this long after the current one was staged: the WMI hand-off takes
 *  up to a few seconds to start a runner, so a copy just handed to it must still be there. */
const PRUNE_AFTER_MS = 5 * 60_000

let staged: { key: string; path: string; at: number; pruned: boolean } | null = null

/** The Windows runner to start: a copy of misc/climayte-runner.exe named by its content, in
 *  CliMayte's own folder. Windows cannot replace a running exe, so runners started from misc/ itself
 *  would make every update that changes the runner (a `git pull`, a release's misc/ reconcile) fail
 *  while any worker runs, and a single-file build's embedded copy cannot be started at all. Throws
 *  when there is no runner to copy: the attempt then fails saying so. */
export function nativeRunner(): string {
  const source = nativeRunnerSource()
  const st = statSync(source)
  const key = `${source}:${st.size}:${st.mtimeMs}`
  if (staged?.key !== key || !existsSync(staged.path)) {
    const bytes = readFileSync(source)
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
    const path = join(ROOT, 'bin', `climayte-runner-${hash}.exe`)
    if (!existsSync(path)) {
      mkdirSync(join(ROOT, 'bin'), { recursive: true })
      const part = `${path}.${process.pid}.part`
      writeFileSync(part, bytes)
      try {
        renameSync(part, path)
      } catch (err) {
        // Another daemon on this folder staged the same bytes first (and may be running them).
        rmSync(part, { force: true })
        if (!existsSync(path)) throw err
      }
    }
    staged = { key, path, at: Date.now(), pruned: false }
  }
  if (!staged.pruned && Date.now() - staged.at > PRUNE_AFTER_MS) {
    staged.pruned = true
    const dir = join(ROOT, 'bin')
    for (const old of readdirSync(dir)) {
      if (join(dir, old) === staged.path || !old.startsWith('climayte-runner-')) continue
      try {
        rmSync(join(dir, old), { force: true })
      } catch {
        // Still running a worker: it goes with a later runner change.
      }
    }
  }
  return staged.path
}

/** How a runner is started for `specPath`: the native runner on Windows; elsewhere this program in
 *  runner mode (a release runs its bundle on the downloaded bun, a source run goes through main.ts). */
export function runnerArgv(specPath: string): string[] {
  if (process.platform === 'win32') return [nativeRunner(), specPath]
  return IS_RELEASE
    ? [process.execPath, join(import.meta.dir, 'server.js'), '--climayte-runner', specPath]
    : [process.execPath, join(import.meta.dir, 'main.ts'), '--climayte-runner', specPath]
}

/** How long a runner has to claim its spec once it can have been started; unclaimed past it, the spec
 *  is voided so the runner never starts late (climayte-stops.ts attemptExited, climayte-checks.ts
 *  checkLost). */
export const RUNNER_CLAIM_MS = 60_000

/** The Windows hand-offs this daemon started, by spec path: null while the hand-off powershell is
 *  still queued or running, then when it ended. A hand-off that has not ended cannot have started
 *  the runner, so its spec is not yet the runner's to claim (unclaimedFor). */
const handoffs = new Map<string, number | null>()
/** An ended hand-off is forgotten this long after: its minute was decided long before. */
const HANDOFF_KEEP_MS = 10 * 60_000

/** Record where a spec's hand-off is (launchRunner; tests stand one in). */
export function noteHandoff(specPath: string, endedAt: number | null): void {
  handoffs.set(specPath, endedAt)
  if (endedAt === null) return
  for (const [path, at] of handoffs)
    if (at !== null && endedAt - at > HANDOFF_KEEP_MS) handoffs.delete(path)
}

/** How long `specPath` has been its runner's to claim, or null while this daemon's hand-off of it has
 *  not ended (the runner cannot have started, so it is neither late nor lost). Counted from that
 *  hand-off's end, else from `launchedAt`: an earlier daemon's hand-off died with it, and POSIX's
 *  detached spawn starts the runner at once.
 *
 *  ⛔ 2026-10-11: counted from `launchedAt` alone, a hand-off queued behind other captures on the
 *  spawn worker for over a minute had its spec voided before the runner could exist, and the attempt
 *  or check was launched again, adding one more hand-off to that same queue. 06:10-08:00 UTC: 405
 *  checks "never started" (35 workers then failed "the check itself is broken"), and 80 workers
 *  failed "stopped three times in a row" with no CLI ever started. */
export function unclaimedFor(
  specPath: string,
  launchedAt: number,
  now = Date.now(),
): number | null {
  const ended = handoffs.get(specPath)
  if (ended === undefined) return now - launchedAt
  return ended === null ? null : now - Math.max(launchedAt, ended)
}

/** Write the spec and hand the runner to the OS, outside this process's tree and hidden. The pids
 *  arrive in `spec.pidFile`: the runner's once it has claimed the spec, the CLI's once it has started
 *  (readRunnerPids). */
export function launchRunner(spec: RunnerSpec, specPath: string): void {
  const argv = runnerArgv(specPath)
  writeFileSync(specPath, JSON.stringify(spec))
  const handoff = buildDetachedSpawn(process.platform, argv, { hideWindow: true })
  if (!handoff.detached) {
    // Windows: the hand-off is a short powershell that has WMI start the runner outside this tree, so it
    // runs on a spawn worker and is not awaited. Spawned here, its CreateProcess held the event loop
    // 204 s over the 24 h to 2026-10-11 (the stall sentinel). Nothing reads the runner's pid from here.
    // Its own lane: on the shared thread it queued behind every netstat, git and taskkill (unclaimedFor).
    noteHandoff(specPath, null)
    void spawnCaptured(handoff.argv, { timeoutMs: 60_000, lane: 'climayte-runner' }).then((r) => {
      noteHandoff(specPath, Date.now())
      if (r.code !== 0)
        console.error(
          `[climayte] runner hand-off for ${specPath} exited ${r.code}${r.timedOut ? ' (timed out)' : ''}: ${r.stderr.slice(0, 300)}`,
        )
    })
    return
  }
  const child = spawn(handoff.argv[0] as string, handoff.argv.slice(1), {
    detached: handoff.detached,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export const readRunnerPids = (pidFile: string): RunnerPids | null => readJson<RunnerPids>(pidFile)
export const readRunnerExit = (exitFile: string): RunnerExit | null =>
  readJson<RunnerExit>(exitFile)
