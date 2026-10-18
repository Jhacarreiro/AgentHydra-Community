// server/src/dashboard-backend.ts - a dashboard may declare a small program its project runs (the owner's own command).
// AgentHydra starts it hidden, logs to the dashboard's backend.log, waits for its health path and restarts it with
// backoff when it exits. The dashboard host proxies /_hydra/api/* to it (see dashboards.ts).
import { type ChildProcess, spawn } from 'node:child_process'
import { closeSync, openSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'

export interface DashboardBackend {
  command: string[]
  cwd: string
  port: number
  health: string
}

const HEALTH_TIMEOUT_MS = 20_000
const POLL_MS = 250
const FAILURE_WINDOW_MS = 10 * 60_000
const MAX_FAILURES = 5
const MAX_BACKOFF_MS = 30_000

interface Run {
  backend: DashboardBackend
  logPath: string
  child: ChildProcess | null
  starting: Promise<string | null> | null
  failures: number[]
  timer: ReturnType<typeof setTimeout> | null
}

const runs = new Map<string, Run>()

async function answers(backend: DashboardBackend): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${backend.port}${backend.health}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(2000),
    })
    res.body?.cancel().catch(() => {})
    return res.status === 200
  } catch {
    return false
  }
}

function recentFailures(run: Run): number {
  const now = Date.now()
  run.failures = run.failures.filter((t) => now - t < FAILURE_WINDOW_MS)
  return run.failures.length
}

function recordFailure(run: Run): void {
  recentFailures(run)
  run.failures.push(Date.now())
}

function scheduleRestart(run: Run): void {
  const count = recentFailures(run)
  if (count >= MAX_FAILURES || run.timer) return
  const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (count - 1))
  run.timer = setTimeout(() => {
    run.timer = null
    void ensureRun(run)
  }, delay)
}

function spawnBackend(run: Run): ChildProcess {
  const { backend } = run
  const [exe = '', ...args] = backend.command
  const log = openSync(run.logPath, 'a')
  try {
    writeSync(log, `\n[${new Date().toISOString()}] starting ${backend.command.join(' ')}\n`)
    return spawn(resolve(backend.cwd, exe), args, {
      cwd: backend.cwd,
      windowsHide: true,
      detached: true,
      stdio: ['ignore', log, log],
    })
  } finally {
    closeSync(log)
  }
}

async function start(run: Run): Promise<string | null> {
  const count = recentFailures(run)
  if (count >= MAX_FAILURES)
    return `the backend failed ${count} times in the last 10 minutes and is not restarted yet; see backend.log`
  let child: ChildProcess
  try {
    child = spawnBackend(run)
  } catch (err) {
    recordFailure(run)
    return `the backend command could not start: ${err instanceof Error ? err.message : String(err)}`
  }
  run.child = child
  let exited = false
  let spawnError: Error | null = null
  child.once('error', (err) => {
    spawnError = err
    if (run.child !== child) return
    run.child = null
    recordFailure(run)
    scheduleRestart(run)
  })
  child.once('exit', () => {
    exited = true
    if (run.child !== child) return
    run.child = null
    recordFailure(run)
    scheduleRestart(run)
  })
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  for (;;) {
    if (spawnError) return `the backend command could not start: ${(spawnError as Error).message}`
    if (exited) return 'the backend exited before it answered its health check; see backend.log'
    if (await answers(run.backend)) return null
    if (Date.now() >= deadline) break
    await new Promise((done) => setTimeout(done, POLL_MS))
  }
  if (run.child === child) {
    run.child = null
    recordFailure(run)
  }
  child.kill()
  return 'the backend did not answer its health check within 20 seconds; see backend.log'
}

function ensureRun(run: Run): Promise<string | null> {
  if (!run.starting) {
    run.starting = (async () => {
      try {
        return (await answers(run.backend)) ? null : await start(run)
      } catch (err) {
        return `the backend could not be started: ${err instanceof Error ? err.message : String(err)}`
      }
    })().finally(() => {
      run.starting = null
    })
  }
  return run.starting
}

function runFor(id: string, backend: DashboardBackend, logPath: string): Run {
  const existing = runs.get(id)
  if (existing && JSON.stringify(existing.backend) === JSON.stringify(backend)) return existing
  if (existing) stopDashboardBackend(id)
  const run: Run = { backend, logPath, child: null, starting: null, failures: [], timer: null }
  runs.set(id, run)
  return run
}

/** Makes sure the declared backend answers its health path, starting it if needed. Null when it is up. */
export function ensureDashboardBackend(
  id: string,
  backend: DashboardBackend,
  logPath: string,
): Promise<string | null> {
  return ensureRun(runFor(id, backend, logPath))
}

/** Kills a dashboard's backend and forgets it; the next request starts it again if one is still declared. */
export function stopDashboardBackend(id: string): void {
  const run = runs.get(id)
  if (!run) return
  runs.delete(id)
  if (run.timer) clearTimeout(run.timer)
  const child = run.child
  run.child = null
  child?.kill()
}
