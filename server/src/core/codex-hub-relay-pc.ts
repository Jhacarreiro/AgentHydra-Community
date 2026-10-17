// server/src/core/codex-hub-relay-pc.ts — this PC's half of the Codex hub relay (codex-hub-relay.ts).
//
// While the pusher runs, one WebSocket stays open to the hub. When Desk continues one of this PC's chats, the hub
// asks for an app-server: this side starts `codex app-server` on this PC's CODEX_HOME and carries its JSON-RPC lines
// over the socket. The turn runs here, with this PC's files, tools and Codex login, as if typed in the Codex app.
//
// The hub is not trusted with more than continuing a chat. Codex is never sent a request as the hub wrote it: each
// one is rebuilt from what its method may carry (RELAY_PARAMS), which is what Desk sends to go on in an existing
// thread. A request for any other method, or one carrying anything else (a config override, another thread's
// history or file, instructions, a folder for the turn, an input read from a file here), is refused here without
// reaching Codex; resume's folder is left out instead, so the thread keeps its own. initialize goes on with the
// experimental API off, which is where history and path live. A turn that would run without approvals or outside
// the sandbox (Desk's bypass mode) is refused unless this PC allows it (AGENTHYDRA_CODEX_HUB_RELAY=full); granular
// approvals, an outside sandbox and more writable folders, which Desk never asks for, are refused in either mode. A
// line that is not one JSON object is dropped, and so is an answer to anything but a request Codex asked of Desk
// and Desk has not answered yet. AGENTHYDRA_CODEX_HUB_RELAY=off keeps the socket closed: chats are pushed only.
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

export function relayMode(): RelayMode {
  const v = appEnv('CODEX_HUB_RELAY')?.trim().toLowerCase()
  return v === 'off' || v === 'full' ? v : 'ask'
}

/** Thrown while a request is rebuilt; with no message, the request is refused for the param it was in. */
class Refused extends Error {
  /** That param: the outermost one, set as the throw leaves each pick. */
  param = ''
}

/** Why 'ask' mode refuses Desk's bypass: approvalPolicy never, or no sandbox. */
const BYPASS =
  'This PC lets the Codex hub run turns only with approvals and the sandbox on. Use another permission mode, or set AGENTHYDRA_CODEX_HUB_RELAY=full on the PC.'

/** One param the hub may send: what Codex is sent for it (undefined leaves it out), or a throw of Refused. */
type Param = (value: unknown, mode: RelayMode) => unknown

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A JSON-RPC request id as text, so 1 and "1" stay apart; null when it is not one. */
const idKey = (id: unknown): string | null =>
  typeof id === 'string' || typeof id === 'number' ? JSON.stringify(id) : null

/** `value` with only the params `allowed` names, each as its rule returns it. A null is no value: it is left out. */
function pick(
  value: unknown,
  allowed: Record<string, Param>,
  mode: RelayMode,
): Record<string, unknown> {
  if (!isObject(value)) throw new Refused()
  const out: Record<string, unknown> = {}
  for (const [name, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue
    const rule = Object.hasOwn(allowed, name) ? allowed[name] : undefined
    try {
      if (!rule) throw new Refused()
      const kept = rule(v, mode)
      if (kept !== undefined) out[name] = kept
    } catch (error) {
      if (error instanceof Refused) error.param = name
      throw error
    }
  }
  return out
}

/** A rule that keeps only the given values, and the bypass ones only in 'full' mode. */
const oneOf =
  (values: unknown[], bypass: unknown[]): Param =>
  (v, mode) => {
    if (values.includes(v)) return v
    if (!bypass.includes(v)) throw new Refused()
    if (mode !== 'full') throw new Refused(BYPASS)
    return v
  }
const text: Param = (v) => {
  if (typeof v !== 'string') throw new Refused()
  return v
}
const flag: Param = (v) => {
  if (typeof v !== 'boolean') throw new Refused()
  return v
}
/** A list Desk sends empty (writableRoots, text_elements), and so may the hub. */
const none: Param = (v) => {
  if (!Array.isArray(v) || v.length) throw new Refused()
  return []
}
/** A picture Desk sends in the line itself (a data URL), never one read from a file or fetched by this PC. */
const picture: Param = (v) => {
  if (typeof v !== 'string' || !v.startsWith('data:')) throw new Refused()
  return v
}
const leftOut: Param = () => undefined
const same: Param = (v) => v

const approvalPolicy = oneOf(['on-request', 'untrusted'], ['never'])
const sandbox = oneOf(['read-only', 'workspace-write'], ['danger-full-access'])

/** Desk's sandboxes: read-only or the workspace with no other writable folder, and no sandbox only in 'full' mode. */
const sandboxPolicy: Param = (v, mode) => {
  const type = isObject(v) ? v.type : undefined
  if (type === 'readOnly') return pick(v, { type: same, networkAccess: flag }, mode)
  if (type === 'workspaceWrite')
    return pick(
      v,
      {
        type: same,
        writableRoots: none,
        networkAccess: flag,
        excludeTmpdirEnvVar: flag,
        excludeSlashTmp: flag,
      },
      mode,
    )
  if (type !== 'dangerFullAccess') throw new Refused()
  const kept = pick(v, { type: same }, mode)
  if (mode !== 'full') throw new Refused(BYPASS)
  return kept
}

/** What Desk types and pastes: text and pictures, never a file on this PC (a local image, a mention, a skill). */
const input: Param = (v, mode) => {
  if (!Array.isArray(v)) throw new Refused()
  return v.map((item) => {
    const type = isObject(item) ? item.type : undefined
    if (type === 'text') return pick(item, { type: same, text, text_elements: none }, mode)
    if (type !== 'image') throw new Refused()
    return pick(item, { type: same, url: picture }, mode)
  })
}

/**
 * What each request the hub may send can carry: what Desk sends to continue an existing thread
 * (desk2/server/src/engine/codex/runtime.ts), and no request that starts one.
 */
const RELAY_PARAMS: Record<string, Record<string, Param>> = {
  initialize: {
    clientInfo: (v, mode) => pick(v, { name: text, title: text, version: text }, mode),
    // Rebuilt below with the experimental API off.
    capabilities: leftOut,
  },
  'thread/resume': {
    threadId: text,
    // The thread keeps its own folder on this PC.
    cwd: leftOut,
    model: text,
    approvalPolicy,
    sandbox,
    excludeTurns: flag,
  },
  'thread/read': { threadId: text, includeTurns: flag },
  'thread/unsubscribe': { threadId: text },
  'turn/start': {
    threadId: text,
    input,
    approvalPolicy,
    sandboxPolicy,
    effort: text,
    model: text,
  },
  'turn/interrupt': { threadId: text, turnId: text },
}

/** The params Codex is sent for a request the hub sent, rebuilt from what its method may carry; or why it may not. */
export function relayRequest(
  method: string,
  params: unknown,
  mode: RelayMode,
): { params: Record<string, unknown> } | { refused: string } {
  if (!Object.hasOwn(RELAY_PARAMS, method))
    return { refused: `This PC does not let the Codex hub call ${method}.` }
  try {
    const kept = pick(params ?? {}, RELAY_PARAMS[method]!, mode)
    if (method === 'initialize') kept.capabilities = { experimentalApi: false }
    return { params: kept }
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    if (error.message) return { refused: error.message }
    return {
      refused: error.param
        ? `This PC does not let the Codex hub send ${error.param} with ${method}.`
        : `This PC does not let the Codex hub call ${method} that way.`,
    }
  }
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
  /** Requests Codex asked of Desk that Desk has not answered (their ids, idKey): the only answers Codex is sent. */
  asked: Set<string>
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
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (!isObject(parsed)) return
    const msg = parsed as {
      id?: unknown
      method?: string
      params?: { requestId?: unknown }
      result?: unknown
      error?: { message?: string }
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
    if (msg.method !== undefined) {
      const asked = idKey(msg.id)
      if (asked) s.asked.add(asked)
      else if (msg.method === 'serverRequest/resolved')
        s.asked.delete(idKey(msg.params?.requestId) ?? '')
    }
    if (msg.method === 'turn/completed') deps.onTurnDone?.()
    send({ t: 'line', sid, line })
  }

  /**
   * A line from Desk, rebuilt for Codex: a request outside what the hub may ask is answered here with an error,
   * and anything else but `initialized` and an answer Codex is waiting for is dropped.
   */
  const fromHub = (sid: string, s: Session, line: string) => {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (!isObject(msg)) return
    const { id, method } = msg
    const key = idKey(id)
    let out: Record<string, unknown>
    if (typeof method === 'string' && key) {
      const r = relayRequest(method, msg.params, mode)
      if ('refused' in r)
        return send({
          t: 'line',
          sid,
          line: JSON.stringify({ id, error: { code: -32600, message: r.refused } }),
        })
      out = { id, method, params: r.params }
    } else if (method === 'initialized' && id === undefined) {
      out = { method }
      if (!s.initialized) {
        s.initialized = true
        queueMicrotask(() => s.ready.resolve())
      }
    } else if (method === undefined && key && s.asked.has(key)) {
      const error = msg.error
      if ('result' in msg) out = { id, result: msg.result }
      else if (isObject(error))
        out = {
          id,
          error: {
            code: typeof error.code === 'number' ? error.code : -32603,
            message: typeof error.message === 'string' ? error.message : 'Desk refused it.',
          },
        }
      else return
      s.asked.delete(key)
    } else return
    const rebuilt = JSON.stringify(out)
    if (s.proc) s.proc.write(rebuilt)
    else s.queued.push(rebuilt)
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
      asked: new Set(),
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
