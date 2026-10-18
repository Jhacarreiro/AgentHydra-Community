// Running one argv for the routines: hidden, no shell, its output streamed, and everything it started ended once it passes
// its timeout. The manager runs status commands with it (plugins/73-routines.ts); the runner runs a routine's command with it
// (runner.ts).

import { spawn, type ChildProcess } from 'node:child_process'

/** After SIGTERM, a process group that has not ended gets SIGKILL this long later (not on Windows, where taskkill ends the tree). */
const GRACE_MS = 5_000
/** Output kept from stdout. */
const STDOUT_CHARS = 1024 * 1024
/** A run's kept line is cut to this. */
export const LINE_CHARS = 300

/** One run of an argv: how it ended. */
export interface Ran {
  code: number | null
  timedOut: boolean
  error: string | null
  stdout: string
}

export const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The last non-empty line of some output, cut to LINE_CHARS. */
export function lastLineOf(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return (lines.at(-1) ?? '').slice(0, LINE_CHARS)
}

/** Ends a process and what it started: taskkill's tree on Windows; elsewhere its process group (runArgv makes it lead one),
 *  SIGTERM and then SIGKILL. Signalled alone, the child ended and what it had started ran on past the timeout. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
    k.on('error', () => child.kill())
    return
  }
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig)
    } catch {
      child.kill(sig)
    }
  }
  signal('SIGTERM')
  const t = setTimeout(() => signal('SIGKILL'), GRACE_MS)
  ;(t as { unref?: () => void }).unref?.()
}

/** Runs an argv hidden, with no shell, until it ends or fails to start. `onStart` gets the child as it starts; `onOutput` sees
 *  each chunk of stdout and stderr; a run past `timeoutMs` is killed with everything it started and reported as timed out. */
export function runArgv(
  argv: string[],
  o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; onStart?: (child: ChildProcess) => void; onOutput?: (text: string) => void },
): Promise<Ran> {
  return new Promise((resolve) => {
    let stdout = ''
    let timedOut = false
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (r: { code: number | null; error: string | null }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ...r, timedOut, stdout })
    }
    let child: ChildProcess
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: o.cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: o.env ?? { ...process.env, PYTHONIOENCODING: 'utf-8' },
        // Off Windows the child leads its own process group, so killTree's signal reaches what it starts.
        detached: process.platform !== 'win32',
      })
    } catch (err) {
      resolve({ code: null, timedOut: false, error: message(err), stdout: '' })
      return
    }
    o.onStart?.(child)
    timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, o.timeoutMs)
    child.stdout?.setEncoding('utf8').on('data', (text: string) => {
      if (stdout.length < STDOUT_CHARS) stdout += text
      o.onOutput?.(text)
    })
    child.stderr?.setEncoding('utf8').on('data', (text: string) => o.onOutput?.(text))
    child.on('error', (err) => finish({ code: null, error: err.message }))
    child.on('close', (code) => finish({ code, error: null }))
  })
}
