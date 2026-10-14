// One Codex app-server (`codex app-server`, JSON-RPC over stdio) per Codex home in this process, shared by every
// Desk chat pinned to Codex on that account. A Codex login is <home>/auth.json and its refresh token rotates on
// each refresh: two processes refreshing at once leave a token the server has retired, signing the account out
// (AgentHydra's server/src/core/codex-rpc.ts). So Desk never opens a second one on a home it already has open,
// and ends it as soon as the last chat lets go: Codex lets one program write a thread at a time, and the process's
// exit frees every thread it loaded at once, while `thread/unsubscribe` frees one only about a minute later
// (measured 2026-10-14: still loaded and refused to another program's archive, "already has an active writer", 55 s
// after the unsubscribe; unloaded and archived at 60 s). A new one starts in under half a second. Its stderr and raw
// lines are never logged: they can hold private chat text.
//
// Another PC's Codex (a chat pushed to AgentHydra's Codex hub) runs on that PC: its "home" is `relay:<hub id>`, and
// its app-server is the PC's own `codex app-server`, its lines carried over a WebSocket through AgentHydra
// (server/src/core/codex-hub-relay.ts). Everything above it is the same.

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { DEFAULT_HYDRA_URL } from '../../bridge/client'
import { codexExe } from './exe'

const RELAY = 'relay:'

/** The home Desk names another PC's Codex by: its hub id (`hub:<pc>`). */
export const relayHome = (hubId: string): string => `${RELAY}${hubId}`
export const isRelayHome = (home: string): boolean => home.startsWith(RELAY)

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

/** Where an app-server's lines go and come from: a process here, or another PC's through the hub. */
interface Transport {
  write(line: string): void
  /** Lets it finish and exit (its input closes); `kill` after the grace. */
  end(): void
  kill(): void
}

interface Shared {
  io: Transport
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

const keyOf = (home: string): string => (isRelayHome(home) ? home : process.platform === 'win32' ? resolve(home).toLowerCase() : resolve(home))

function write(s: Shared, msg: Record<string, unknown>): void {
  if (s.dead) return
  try {
    s.io.write(JSON.stringify(msg))
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

/** `codex app-server` on this machine. */
function processTransport(home: string, h: { line(l: string): void; ended(why: string): void; gone(): void }): Transport {
  const exe = codexExe()
  const child = spawn(exe, ['app-server'], {
    env: { ...process.env, CODEX_HOME: home },
    cwd: home,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    // An npm shim is a .cmd, which only a shell starts.
    shell: /\.cmd$/i.test(exe),
  })
  child.on('error', () => {
    h.ended('Could not start Codex. Check that the Codex app or CLI is installed.')
    h.gone()
  })
  child.on('exit', () => {
    h.ended('Codex stopped.')
    h.gone()
  })
  child.stdin?.on('error', () => h.ended('The connection to Codex closed.'))
  if (child.stdout) createInterface({ input: child.stdout }).on('line', h.line)
  return {
    write: (line) => child.stdin?.write(`${line}\n`),
    end: () => child.stdin?.end(),
    kill: () => child.kill(),
  }
}

/** Another PC's `codex app-server`, through AgentHydra's relay to that PC. */
function relayTransport(home: string, h: { line(l: string): void; ended(why: string): void; gone(): void }): Transport {
  const hubId = home.slice(RELAY.length)
  const base = new URL((process.env.HYDRA_URL ?? DEFAULT_HYDRA_URL).replace(/\/+$/, ''))
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${base.origin}/api/codex-relay/${encodeURIComponent(hubId.replace(/^hub:/, ''))}/app-server`
  const token = process.env.AGENTHYDRA_CODEX_HUB_TOKEN?.trim() ?? ''
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as unknown as string[])
  const queued: string[] = []
  ws.addEventListener('open', () => {
    for (const line of queued.splice(0)) ws.send(line)
  })
  ws.addEventListener('message', (e) => h.line(String((e as MessageEvent).data)))
  ws.addEventListener('close', (e) => {
    const why = (e as CloseEvent).reason
    h.ended(why ? `Codex on the other PC stopped: ${why}` : 'The connection to the other PC closed.')
    h.gone()
  })
  return {
    write: (line) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(line)
      else if (ws.readyState === WebSocket.CONNECTING) queued.push(line)
    },
    end: () => ws.close(),
    kill: () => ws.close(),
  }
}

function start(home: string, key: string): Shared {
  const { promise: exited, resolve: gone } = Promise.withResolvers<void>()
  const s = { ready: Promise.resolve(), refs: 0, nextId: 0, pending: new Map(), listeners: new Map(), dead: null, exited } as Omit<Shared, 'io'> as Shared
  const hooks = { line: (line: string) => onLine(s, line), ended: (why: string) => end(key, s, why), gone }
  s.io = isRelayHome(home) ? relayTransport(home, hooks) : processTransport(home, hooks)
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
    s.io.end()
  } catch {
    // already gone
  }
  const kill = setTimeout(() => {
    try {
      s.io.kill()
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
