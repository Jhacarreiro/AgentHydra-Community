// One Codex app-server (`codex app-server`, JSON-RPC over stdio) per Codex home in this process, shared by every
// Desk chat pinned to Codex on that account. A Codex login is <home>/auth.json and its refresh token rotates on
// each refresh: two processes refreshing at once leave a token the server has retired, signing the account out
// (AgentHydra's server/src/core/codex-rpc.ts). So Desk never opens a second one on a home it already has open,
// and ends it as soon as the last chat lets go: Codex lets one program write a thread at a time, and the process's
// exit frees every thread it loaded at once, while `thread/unsubscribe` frees one only about a minute later
// (measured 2026-10-14: still loaded and refused to another program's archive, "already has an active writer", 55 s
// after the unsubscribe; unloaded and archived at 60 s). A new one starts in under half a second. Its stderr and raw
// lines are never logged: they can hold private chat text.

import { type ChildProcess, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { codexExe } from './exe'

/** What one thread hears from its app-server. */
export interface ThreadListener {
  notify(method: string, params: Record<string, unknown>): void
  /** A request the server makes of the client for this thread (an approval, a question): its answer is the result; a throw refuses it. */
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  /** The process ended: nothing on it runs any more. */
  exited(why: string): void
}

export interface AppServer {
  call<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>
  /** Routes this thread's notifications and requests to `l` until the returned function is called. */
  listen(threadId: string, l: ThreadListener): () => void
  /** This holder is done with it; the process ends when the last one is. */
  release(): void
}

export type OpenAppServer = (home: string) => Promise<AppServer>

const CALL_TIMEOUT_MS = 60_000
/** How long an app-server whose input was closed gets to finish writing its threads and exit before it is killed. */
const EXIT_GRACE_MS = 5_000

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface Shared {
  child: ChildProcess
  ready: Promise<void>
  refs: number
  nextId: number
  pending: Map<number, Pending>
  listeners: Map<string, ThreadListener>
  dead: string | null
  /** Settles when the process has gone. */
  exited: Promise<void>
}

const open = new Map<string, Shared>()
/** App-servers asked to end and not gone yet: a new one on the same home waits, or it would find the threads still held. */
const exiting = new Map<string, Promise<void>>()

const keyOf = (home: string): string => (process.platform === 'win32' ? resolve(home).toLowerCase() : resolve(home))

function write(s: Shared, msg: Record<string, unknown>): void {
  if (s.dead) return
  try {
    s.child.stdin?.write(`${JSON.stringify(msg)}\n`)
  } catch {
    // the exit handler says why
  }
}

function call<T>(s: Shared, method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<T> {
  if (s.dead) return Promise.reject(new Error(s.dead))
  const id = ++s.nextId
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.pending.delete(id)
      reject(new Error(`Codex did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`))
    }, timeoutMs)
    s.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer })
    write(s, { id, method, params })
  })
}

function threadOf(params: Record<string, unknown>): string | null {
  if (typeof params.threadId === 'string') return params.threadId
  const thread = params.thread as { id?: unknown } | undefined
  return typeof thread?.id === 'string' ? thread.id : null
}

function onLine(s: Shared, line: string): void {
  let msg: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const params = msg.params ?? {}
  if (msg.method && msg.id !== undefined) {
    const id = msg.id
    const threadId = threadOf(params)
    const l = threadId ? s.listeners.get(threadId) : undefined
    if (!l) return write(s, { id, error: { code: -32601, message: 'Unsupported request' } })
    Promise.resolve()
      .then(() => l.request(msg.method!, params))
      .then(
        (result) => write(s, { id, result }),
        (err: unknown) => write(s, { id, error: { code: -32603, message: err instanceof Error ? err.message : 'Refused' } }),
      )
    return
  }
  if (msg.method) {
    const threadId = threadOf(params)
    if (threadId) s.listeners.get(threadId)?.notify(msg.method, params)
    return
  }
  if (typeof msg.id !== 'number') return
  const p = s.pending.get(msg.id)
  if (!p) return
  s.pending.delete(msg.id)
  clearTimeout(p.timer)
  if (msg.error) p.reject(new Error(msg.error.message ?? 'Codex refused the request.'))
  else p.resolve(msg.result)
}

function end(key: string, s: Shared, why: string): void {
  if (s.dead) return
  s.dead = why
  if (open.get(key) === s) open.delete(key)
  for (const p of s.pending.values()) {
    clearTimeout(p.timer)
    p.reject(new Error(why))
  }
  s.pending.clear()
  for (const l of [...s.listeners.values()]) l.exited(why)
  s.listeners.clear()
}

function start(home: string, key: string): Shared {
  const exe = codexExe()
  const child = spawn(exe, ['app-server'], {
    env: { ...process.env, CODEX_HOME: home },
    cwd: home,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    // An npm shim is a .cmd, which only a shell starts.
    shell: /\.cmd$/i.test(exe),
  })
  const { promise: exited, resolve: gone } = Promise.withResolvers<void>()
  const s: Shared = { child, ready: Promise.resolve(), refs: 0, nextId: 0, pending: new Map(), listeners: new Map(), dead: null, exited }
  child.on('error', () => {
    end(key, s, 'Could not start Codex. Check that the Codex app or CLI is installed.')
    gone()
  })
  child.on('exit', () => {
    end(key, s, 'Codex stopped.')
    gone()
  })
  child.stdin?.on('error', () => end(key, s, 'The connection to Codex closed.'))
  if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => onLine(s, line))
  s.ready = call(s, 'initialize', { clientInfo: { name: 'hydra_desk', title: 'AgentHydra', version: '2.0.0' }, capabilities: { experimentalApi: true } }, 30_000).then(() =>
    write(s, { method: 'initialized' }),
  )
  return s
}

/**
 * Ends the process: its input closes, so Codex finishes writing its threads and exits (an npm shim's shell would be
 * all a kill reaches); one still running after the grace is killed.
 */
function stop(key: string, s: Shared): void {
  end(key, s, 'Codex was closed.')
  try {
    s.child.stdin?.end()
  } catch {
    // already gone
  }
  const kill = setTimeout(() => {
    try {
      s.child.kill()
    } catch {
      // already gone
    }
  }, EXIT_GRACE_MS)
  ;(kill as { unref?: () => void }).unref?.()
  const done = s.exited.then(() => clearTimeout(kill))
  exiting.set(key, done)
  void done.then(() => {
    if (exiting.get(key) === done) exiting.delete(key)
  })
}

/** The app-server for `home`, started when none runs; every caller releases its own. */
export const openAppServer: OpenAppServer = async (home) => {
  const key = keyOf(home)
  let s = open.get(key)
  if (!s || s.dead) {
    await exiting.get(key)
    s = open.get(key)
    if (!s || s.dead) {
      s = start(home, key)
      open.set(key, s)
    }
  }
  const shared = s
  shared.refs++
  let released = false
  const release = () => {
    if (released) return
    released = true
    shared.refs--
    if (shared.refs === 0 && !shared.dead) stop(key, shared)
  }
  try {
    await shared.ready
  } catch (err) {
    // Every holder waiting on it fails the same way; the last one's release ends it.
    release()
    throw err
  }
  return {
    call: (method, params, timeoutMs = CALL_TIMEOUT_MS) => call(shared, method, params, timeoutMs),
    listen(threadId, l) {
      shared.listeners.set(threadId, l)
      return () => {
        if (shared.listeners.get(threadId) === l) shared.listeners.delete(threadId)
      }
    },
    release,
  }
}

/** Ends every app-server this process opened (the server is stopping). */
export function closeAppServers(): void {
  for (const [key, s] of [...open]) stop(key, s)
}
