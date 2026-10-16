// server/src/core/codex-hub-relay-pc.ts — this PC's half of the Codex hub relay (codex-hub-relay.ts).
//
// While the pusher runs, one WebSocket stays open to the hub. When Desk continues one of this PC's chats, the hub
// asks for an app-server: this side starts `codex app-server` on this PC's CODEX_HOME and carries its JSON-RPC lines
// over the socket. The turn runs here, with this PC's files, tools and Codex login, as if typed in the Codex app.
//
// The hub is not trusted with more than continuing a chat. Of the requests it sends, only the ones Desk needs to go
// on in an existing thread pass (RELAY_METHODS); anything else is refused here without reaching Codex. A turn that
// would run without approvals or outside the sandbox (Desk's bypass mode) is refused unless this PC allows it
// (AGENTHYDRA_CODEX_HUB_RELAY=full). AGENTHYDRA_CODEX_HUB_RELAY=off keeps the socket closed: chats are pushed only.
//
// While Desk holds an app-server here, the pusher lists chats through it (localRpc) rather than starting a second
// one on the same home, whose refresh token rotates (codex-rpc.ts). A turn's end pushes at once, so the copy on
// the hub catches up with what was just written.

import { type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { appEnv, CODEX_HOME, codexSpawnEnv, resolveCodexExe } from '../config'
import type { CodexHubPushConfig } from './codex-hub-push'
import type { RelayFromPc, RelayToPc } from './codex-hub-relay'
import { type CodexRpc, takeHomeTurn } from './codex-rpc'

export type RelayMode = 'off' | 'ask' | 'full'

/** Requests the hub may send: what Desk needs to continue an existing thread, and nothing that starts one. */
export const RELAY_METHODS = new Set([
  'initialize',
  'thread/resume',
  'thread/read',
  'thread/unsubscribe',
  'turn/start',
  'turn/interrupt',
])

export function relayMode(): RelayMode {
  const v = appEnv('CODEX_HUB_RELAY')?.trim().toLowerCase()
  return v === 'off' || v === 'full' ? v : 'ask'
}

/** Why the hub may not send this request, or null when it may. */
export function refuseRelayRequest(
  method: string,
  params: Record<string, unknown> | undefined,
  mode: RelayMode,
): string | null {
  if (!RELAY_METHODS.has(method)) return `This PC does not let the Codex hub call ${method}.`
  if (mode === 'full') return null
  const p = params ?? {}
  const sandboxPolicy = p.sandboxPolicy as { type?: unknown } | undefined
  if (
    p.approvalPolicy === 'never' ||
    p.sandbox === 'danger-full-access' ||
    sandboxPolicy?.type === 'dangerFullAccess'
  )
    return 'This PC lets the Codex hub run turns only with approvals and the sandbox on. Use another permission mode, or set AGENTHYDRA_CODEX_HUB_RELAY=full on the PC.'
  return null
}

/** What the relay needs of an app-server process; tests give a fake one. */
export interface AppServerProcess {
  write(line: string): void
  onLine(f: (line: string) => void): void
  onExit(f: (why: string) => void): void
  end(): void
}

interface RelayDeps {
  spawnAppServer?: (codexHome: string) => Promise<AppServerProcess>
  connect?: (url: string, headers: Record<string, string>) => WebSocket
  codexHome?: string
  mode?: RelayMode
  /** A turn ended on this PC: its rollout changed. */
  onTurnDone?: () => void
}

const LOCAL_ID = 'hub-pc-'
const LOCAL_TIMEOUT_MS = 60_000
const EXIT_GRACE_MS = 5_000
const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000

/** `codex app-server` on `codexHome`, holding the home's turn until it has exited. */
async function spawnLocalAppServer(codexHome: string): Promise<AppServerProcess> {
  const release = await takeHomeTurn(codexHome)
  let child: ChildProcess
  try {
    const exe = resolveCodexExe()
    child = spawn(exe, ['app-server'], {
      env: { ...codexSpawnEnv(exe), CODEX_HOME: codexHome },
      cwd: codexHome,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
  } catch (error) {
    release()
    throw error
  }
  const exitHandlers: ((why: string) => void)[] = []
  let gone = false
  const exited = (why: string) => {
    if (gone) return
    gone = true
    release()
    for (const f of exitHandlers) f(why)
  }
  child.once('error', () => exited('Could not start Codex on the PC.'))
  child.once('close', () => exited('Codex stopped on the PC.'))
  child.stdin?.on('error', () => exited('The connection to Codex on the PC closed.'))
  const lines = createInterface({ input: child.stdout! })
  return {
    write: (line) => {
      if (!gone) child.stdin?.write(`${line}\n`)
    },
    onLine: (f) => lines.on('line', f),
    onExit: (f) => exitHandlers.push(f),
    end: () => {
      child.stdin?.end()
      const kill = setTimeout(() => child.kill(), EXIT_GRACE_MS)
      ;(kill as { unref?: () => void }).unref?.()
      child.once('close', () => clearTimeout(kill))
    },
  }
}

interface Local {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface Session {
  proc: AppServerProcess | null
  /** Lines the hub sent before the process was up. */
  queued: string[]
  /** Settles when Desk's `initialized` has gone through: only then may this side call it. */
  ready: PromiseWithResolvers<void>
  initialized: boolean
  nextLocal: number
  locals: Map<string, Local>
  closed: boolean
}

export interface CodexHubRelay {
  stop(): void
  /** An rpc on an app-server Desk holds open here, or null when none is. */
  localRpc(): CodexRpc | null
}

export function relayUrl(hubUrl: string, pc: string): string {
  const u = new URL(`${hubUrl}/api/codex-hub/relay`)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.searchParams.set('pc', pc)
  return u.toString()
}

/** Keeps the relay socket open (reconnecting with backoff) until stopped; null when this PC turned it off. */
export function startCodexHubRelay(
  cfg: CodexHubPushConfig,
  deps: RelayDeps = {},
): CodexHubRelay | null {
  const mode = deps.mode ?? relayMode()
  if (mode === 'off') return null
  const codexHome = deps.codexHome ?? CODEX_HOME
  const spawnProc = deps.spawnAppServer ?? spawnLocalAppServer
  const connect =
    deps.connect ?? ((url, headers) => new WebSocket(url, { headers } as unknown as string[]))
  const sessions = new Map<string, Session>()
  let ws: WebSocket | null = null
  let stopped = false
  let retryMs = RETRY_MIN_MS
  let retry: ReturnType<typeof setTimeout> | null = null

  const send = (msg: RelayFromPc) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  const endSession = (sid: string, why: string, tellHub: boolean) => {
    const s = sessions.get(sid)
    if (!s || s.closed) return
    s.closed = true
    sessions.delete(sid)
    for (const l of s.locals.values()) {
      clearTimeout(l.timer)
      l.reject(new Error(why))
    }
    s.locals.clear()
    s.ready.reject(new Error(why))
    s.proc?.end()
    if (tellHub) send({ t: 'exit', sid, why })
  }

  /** A line from the app-server: answers to this side's own calls stay here, the rest go to Desk. */
  const fromCodex = (sid: string, s: Session, line: string) => {
    let msg: { id?: unknown; method?: string; result?: unknown; error?: { message?: string } }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (typeof msg.id === 'string' && msg.id.startsWith(LOCAL_ID) && !msg.method) {
      const l = s.locals.get(msg.id)
      if (!l) return
      s.locals.delete(msg.id)
      clearTimeout(l.timer)
      if (msg.error) l.reject(new Error(msg.error.message ?? 'Codex refused the request.'))
      else l.resolve(msg.result)
      return
    }
    if (msg.method === 'turn/completed') deps.onTurnDone?.()
    send({ t: 'line', sid, line })
  }

  /** A line from Desk: a request outside what the hub may ask is answered here with an error. */
  const fromHub = (sid: string, s: Session, line: string) => {
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown> }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.method && msg.id !== undefined) {
      const why = refuseRelayRequest(msg.method, msg.params, mode)
      if (why)
        return send({
          t: 'line',
          sid,
          line: JSON.stringify({ id: msg.id, error: { code: -32600, message: why } }),
        })
    } else if (msg.method && msg.method !== 'initialized') return
    if (msg.method === 'initialized' && !s.initialized) {
      s.initialized = true
      queueMicrotask(() => s.ready.resolve())
    }
    if (s.proc) s.proc.write(line)
    else s.queued.push(line)
  }

  const open = async (sid: string) => {
    const ready = Promise.withResolvers<void>()
    ready.promise.catch(() => {})
    const s: Session = {
      proc: null,
      queued: [],
      ready,
      initialized: false,
      nextLocal: 0,
      locals: new Map(),
      closed: false,
    }
    sessions.set(sid, s)
    let proc: AppServerProcess
    try {
      proc = await spawnProc(codexHome)
    } catch {
      return endSession(sid, 'Could not start Codex on the PC.', true)
    }
    if (s.closed) return proc.end()
    s.proc = proc
    proc.onLine((line) => fromCodex(sid, s, line))
    proc.onExit((why) => endSession(sid, why, true))
    for (const line of s.queued.splice(0)) proc.write(line)
  }

  const onMessage = (raw: string) => {
    let msg: Partial<RelayToPc>
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof msg.sid !== 'string') return
    if (msg.t === 'open' && !sessions.has(msg.sid)) void open(msg.sid)
    else if (msg.t === 'close') endSession(msg.sid, 'Desk let go.', false)
    else if (msg.t === 'line' && typeof msg.line === 'string') {
      const s = sessions.get(msg.sid)
      if (s) fromHub(msg.sid, s, msg.line)
    }
  }

  const dial = () => {
    retry = null
    if (stopped) return
    const socket = connect(relayUrl(cfg.url, cfg.pc), {
      ...cfg.headers,
      authorization: `Bearer ${cfg.token}`,
    })
    ws = socket
    socket.addEventListener('open', () => {
      retryMs = RETRY_MIN_MS
    })
    socket.addEventListener('message', (e) => onMessage(String((e as MessageEvent).data)))
    socket.addEventListener('close', () => {
      if (ws !== socket) return
      ws = null
      for (const sid of [...sessions.keys()]) endSession(sid, 'The hub connection closed.', false)
      if (stopped) return
      retry = setTimeout(dial, retryMs)
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS)
    })
  }
  dial()

  return {
    stop() {
      stopped = true
      if (retry) clearTimeout(retry)
      const socket = ws
      ws = null
      for (const sid of [...sessions.keys()]) endSession(sid, 'The PC stopped relaying.', false)
      socket?.close()
    },
    localRpc() {
      const live = [...sessions.values()].find((s) => s.proc && s.initialized && !s.closed)
      if (!live) return null
      return {
        async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
          await live.ready.promise
          if (live.closed || !live.proc) throw new Error('Codex on the PC is closed.')
          const id = `${LOCAL_ID}${++live.nextLocal}`
          return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
              live.locals.delete(id)
              reject(new Error(`Codex did not answer ${method}.`))
            }, LOCAL_TIMEOUT_MS)
            live.locals.set(id, { resolve: (v) => resolve(v as T), reject, timer })
            live.proc!.write(JSON.stringify({ id, method, params }))
          })
        },
        close: () => undefined,
      }
    },
  }
}
