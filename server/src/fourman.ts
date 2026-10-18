// 4MAN, the owner's board of AI work, read through its own engine (tools/4man/4man.mjs in the Connections
// checkout), and the human to-do list read through the Connections local MCP. Read-only: AgentHydra never
// writes to 4MAN. Absent engine means every board answer says available:false.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export const ENGINE_TIMEOUT_MS = 15_000
export const CACHE_MS = 30_000
export const NOTES_CACHE_MS = 60_000
export const DISCOVERY_CACHE_MS = 5 * 60_000
export const LIST_CAP = 200
export const BODY_CHARS = 600
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const HELPER_TIMEOUT_MS = 10_000
const MCP_TIMEOUT_MS = 20_000
const NOT_INSTALLED = '4MAN is not installed on this PC'
const NO_LOCAL_MCP = 'the Connections local MCP is not set up in ~/.claude.json'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export interface FourmanEngine {
  path: string
  via: 'env' | 'claude-config' | 'port-owner'
}

export interface FourmanTask {
  id: string
  title: string
  body: string
  project?: string | null
  status?: string
  tier?: string
  quadrant?: string
  type?: string
  size?: string
  impact?: string
  live?: boolean
  risky?: boolean
  needsHuman?: boolean
  claimedBy?: string | null
  createdAt?: string
  updatedAt?: string
  tierWhy?: string
}

export interface FourmanNoteTodo {
  id: string
  title: string
  due?: string
  done: boolean
  labels?: string[]
}

export interface FourmanBoard {
  available: boolean
  why?: string
  project: string | null
  readyCount: number
  ready: FourmanTask[]
  human: FourmanTask[]
  claimed: FourmanTask[]
  pending: FourmanTask[]
  notes: FourmanNoteTodo[]
  fetchedAt: string
}

export interface FourmanStatus {
  available: boolean
  why?: string
  engine?: string
  notes: { available: boolean; why?: string }
}

export type FourmanScope = { folder: string } | { project: string } | { all: true }

export interface FourmanDeps {
  env: NodeJS.ProcessEnv
  home: string
  portOwner: (port: number) => Promise<string | null>
}

let overrides: Partial<FourmanDeps> = {}

/** Tests replace the environment, home folder and port-owner lookup; production never calls this. */
export function setFourmanDeps(next: Partial<FourmanDeps>): void {
  overrides = next
}

function currentDeps(): FourmanDeps {
  return { env: process.env, home: homedir(), portOwner: listeningCommandLine, ...overrides }
}

/** The engine from AGENTHYDRA_FOURMAN, else from the Connections MCP entry in ~/.claude.json, else none. */
export function findEngine(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): FourmanEngine | null {
  const fromEnv = env.AGENTHYDRA_FOURMAN?.trim()
  if (fromEnv) return existsSync(fromEnv) ? { path: fromEnv, via: 'env' } : null
  const fromConfig = engineFromClaudeConfig(home)
  return fromConfig ? { path: fromConfig, via: 'claude-config' } : null
}

function readClaudeConfig(home: string): Record<string, unknown> | null {
  try {
    const config: unknown = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    return config && typeof config === 'object' ? (config as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function configServers(home: string): Record<string, unknown> {
  const servers = readClaudeConfig(home)?.mcpServers
  return servers && typeof servers === 'object' ? (servers as Record<string, unknown>) : {}
}

function engineFromClaudeConfig(home: string): string | null {
  for (const entry of Object.values(configServers(home))) {
    const args = (entry as { args?: unknown } | null)?.args
    if (!Array.isArray(args)) continue
    for (const arg of args) {
      if (typeof arg !== 'string') continue
      const p = arg.replace(/\\/g, '/')
      const at = p.toLowerCase().indexOf('/services/studio/local-mcp')
      if (at < 0) continue
      const engine = join(p.slice(0, at), 'tools', '4man', '4man.mjs')
      if (existsSync(engine)) return engine
    }
  }
  return null
}

export interface LocalMcp {
  url: string
  port: number
  headersHelper?: string
}

function localMcp(home: string): LocalMcp | null {
  const servers = configServers(home)
  for (const name of ['connections-local', 'connections']) {
    const entry = servers[name] as { type?: unknown; url?: unknown; headersHelper?: unknown } | null
    if (entry?.type !== 'http' || typeof entry.url !== 'string') continue
    let url: URL
    try {
      url = new URL(entry.url)
    } catch {
      continue
    }
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || !url.port) continue
    const headersHelper =
      typeof entry.headersHelper === 'string' && entry.headersHelper.trim()
        ? entry.headersHelper
        : undefined
    return { url: entry.url, port: Number(url.port), headersHelper }
  }
  return null
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: HELPER_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    )
  })
}

/** The command line of the process listening on a loopback port, or null when nothing is listening. */
export function listeningCommandLine(port: number): Promise<string | null> {
  return platform() === 'win32' ? windowsCommandLine(port) : unixCommandLine(port)
}

async function windowsCommandLine(port: number): Promise<string | null> {
  const script =
    `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
    `if ($c) { (Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)").CommandLine }`
  const out = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-Command',
    script,
  ])
  return out.trim() || null
}

async function unixCommandLine(port: number): Promise<string | null> {
  const pid = (await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']))
    .split('\n')[0]
    ?.trim()
  if (!pid || !/^\d+$/.test(pid)) return null
  return (await run('ps', ['-o', 'args=', '-p', pid])).trim() || null
}

/** The engine a local MCP server command line runs from: <checkout>/services/studio/local-mcp/<file>.mjs. */
export function engineFromCommandLine(commandLine: string): string | null {
  for (const raw of commandLine.match(/"[^"]*"|\S+/g) ?? []) {
    const token = raw.replace(/"/g, '').replace(/\\/g, '/')
    const checkout = /^(.+)\/services\/studio\/local-mcp\/[^/]+\.mjs$/i.exec(token)?.[1]
    if (!checkout) continue
    const engine = join(checkout, 'tools', '4man', '4man.mjs')
    if (existsSync(engine)) return engine
  }
  return null
}

const discovered = new Map<number, { at: number; engine: FourmanEngine | null }>()

async function engineFromPort(
  port: number,
  portOwner: FourmanDeps['portOwner'],
): Promise<FourmanEngine | null> {
  const hit = discovered.get(port)
  if (hit && Date.now() - hit.at < DISCOVERY_CACHE_MS) return hit.engine
  let engine: FourmanEngine | null = null
  try {
    const commandLine = await portOwner(port)
    const path = commandLine ? engineFromCommandLine(commandLine) : null
    if (path) engine = { path, via: 'port-owner' }
  } catch {
    engine = null
  }
  discovered.set(port, { at: Date.now(), engine })
  return engine
}

export async function resolveEngine(
  deps: FourmanDeps = currentDeps(),
): Promise<FourmanEngine | null> {
  const direct = findEngine(deps.env, deps.home)
  if (direct || deps.env.AGENTHYDRA_FOURMAN?.trim()) return direct
  const local = localMcp(deps.home)
  return local ? engineFromPort(local.port, deps.portOwner) : null
}

export function runEngine(
  engine: string,
  args: string[],
  timeoutMs = ENGINE_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(
      'node',
      [engine, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES },
      (err, stdout) => {
        if (err) {
          const late = (err as { killed?: boolean }).killed
          reject(
            new Error(late ? `4MAN did not answer within ${timeoutMs / 1000} s` : '4MAN failed'),
          )
          return
        }
        try {
          const parsed = JSON.parse(String(stdout))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) resolve(parsed)
          else reject(new Error('4MAN printed no board'))
        } catch {
          reject(new Error('4MAN printed no JSON'))
        }
      },
    )
  })
}

const TASK_KEYS = [
  'id',
  'title',
  'project',
  'status',
  'tier',
  'quadrant',
  'type',
  'size',
  'impact',
  'live',
  'risky',
  'needsHuman',
  'claimedBy',
  'createdAt',
  'updatedAt',
  'tierWhy',
] as const

function trimTask(raw: unknown): FourmanTask {
  const t = (raw ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of TASK_KEYS) if (t[k] !== undefined) out[k] = t[k]
  out.body = typeof t.body === 'string' ? t.body.slice(0, BODY_CHARS) : ''
  return out as unknown as FourmanTask
}

function list(v: unknown): FourmanTask[] {
  return Array.isArray(v) ? v.slice(0, LIST_CAP).map(trimTask) : []
}

function shape(raw: Record<string, unknown>): FourmanBoard {
  const ready = list(raw.ready)
  return {
    available: true,
    project: typeof raw.project === 'string' ? raw.project : null,
    readyCount: typeof raw.readyCount === 'number' ? raw.readyCount : ready.length,
    ready,
    human: list(raw.human),
    claimed: list(raw.claimed),
    pending: list(raw.pending),
    notes: [],
    fetchedAt: new Date().toISOString(),
  }
}

export function unavailableBoard(why: string): FourmanBoard {
  return {
    available: false,
    why,
    project: null,
    readyCount: 0,
    ready: [],
    human: [],
    claimed: [],
    pending: [],
    notes: [],
    fetchedAt: new Date().toISOString(),
  }
}

const cache = new Map<string, { at: number; load: Promise<FourmanBoard> }>()

function cachedBoard(key: string, engine: string, args: string[]): Promise<FourmanBoard> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.load
  const load = runEngine(engine, args).then(shape)
  const entry = { at: Date.now(), load }
  cache.set(key, entry)
  load.catch(() => {
    if (cache.get(key) === entry) cache.delete(key)
  })
  return load
}

export async function fourmanBoard(scope: FourmanScope): Promise<FourmanBoard> {
  const deps = currentDeps()
  const [engine, notes] = await Promise.all([resolveEngine(deps), readNotes(deps)])
  if (!engine) return { ...unavailableBoard(NOT_INSTALLED), notes: notes.todos }
  const args =
    'folder' in scope
      ? ['list', '--folder', scope.folder, '--json']
      : 'project' in scope
        ? ['list', '--project', scope.project, '--json']
        : ['list', '--all', '--json']
  try {
    const board = await cachedBoard(`${engine.path}\0${args.join('\0')}`, engine.path, args)
    return { ...board, notes: notes.todos }
  } catch (err) {
    return {
      ...unavailableBoard(err instanceof Error ? err.message : '4MAN failed'),
      notes: notes.todos,
    }
  }
}

export async function fourmanStatus(): Promise<FourmanStatus> {
  const deps = currentDeps()
  const [engine, notes] = await Promise.all([resolveEngine(deps), readNotes(deps)])
  const notesStatus = notes.available ? { available: true } : { available: false, why: notes.why }
  if (!engine) return { available: false, why: NOT_INSTALLED, notes: notesStatus }
  return { available: true, engine: engine.path, notes: notesStatus }
}

export interface NotesResult {
  available: boolean
  why?: string
  todos: FourmanNoteTodo[]
}

const notesCache = new Map<string, { at: number; load: Promise<NotesResult> }>()

export async function readNotes(deps: FourmanDeps = currentDeps()): Promise<NotesResult> {
  const local = localMcp(deps.home)
  if (!local) return { available: false, why: NO_LOCAL_MCP, todos: [] }
  const key = `${local.url}\0${local.headersHelper ?? ''}`
  const hit = notesCache.get(key)
  if (hit && Date.now() - hit.at < NOTES_CACHE_MS) return hit.load
  const load = loadNotes(local)
  notesCache.set(key, { at: Date.now(), load })
  return load
}

async function loadNotes(local: LocalMcp): Promise<NotesResult> {
  const headers = local.headersHelper
    ? await runHeadersHelper(local.headersHelper).catch(() => null)
    : null
  try {
    return { available: true, todos: await fetchTodos(local.url, headers ?? {}) }
  } catch (err) {
    const why =
      err instanceof Error ? err.message.slice(0, 200) : 'the Connections local MCP failed'
    return { available: false, why, todos: [] }
  }
}

const HEADER_NAME = /^[A-Za-z0-9-]+$/

function runHeadersHelper(command: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      { shell: true, windowsHide: true, timeout: HELPER_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error('headers helper failed'))
        let parsed: unknown
        try {
          parsed = JSON.parse(String(stdout))
        } catch {
          return reject(new Error('headers helper printed no JSON object'))
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new Error('headers helper printed no JSON object'))
        }
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(parsed)) {
          if (!HEADER_NAME.test(name) || typeof value !== 'string' || /[\r\n\0]/.test(value)) {
            return reject(new Error('headers helper printed an invalid header'))
          }
          headers[name] = value
        }
        resolve(headers)
      },
    )
  })
}

interface RpcMessage {
  jsonrpc: '2.0'
  id?: number
  method: string
  params?: unknown
}

interface RpcReply {
  id?: unknown
  result?: any
  error?: unknown
}

interface RpcAnswer {
  sessionId: string | null
  reply: RpcReply | null
}

function parseReply(text: string, contentType: string, id: number): RpcReply | null {
  const payloads = contentType.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
    : [text]
  for (const payload of payloads) {
    let msg: unknown
    try {
      msg = JSON.parse(payload)
    } catch {
      continue
    }
    if (msg && typeof msg === 'object' && (msg as { id?: unknown }).id === id)
      return msg as RpcReply
  }
  return null
}

async function post(
  url: string,
  headers: Record<string, string>,
  session: string | null,
  message: RpcMessage,
): Promise<RpcAnswer> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
  })
  const sessionId = res.headers.get('mcp-session-id')
  if (message.id === undefined) return { sessionId, reply: null }
  if (!res.ok) throw new Error(`the Connections local MCP answered HTTP ${res.status}`)
  return {
    sessionId,
    reply: parseReply(await res.text(), res.headers.get('content-type') ?? '', message.id),
  }
}

async function fetchTodos(
  url: string,
  headers: Record<string, string>,
): Promise<FourmanNoteTodo[]> {
  const init = await post(url, headers, null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'agenthydra', version: '1' },
    },
  })
  if (!init.reply || init.reply.error)
    throw new Error('the Connections local MCP refused to start a session')
  const session = init.sessionId
  await post(url, headers, session, { jsonrpc: '2.0', method: 'notifications/initialized' })
  const call = await post(url, headers, session, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'connections_execute',
      arguments: { local: true, tool_name: 'todo_list', params: { completed: false } },
    },
  })
  if (!call.reply) throw new Error('the Connections local MCP gave no answer')
  if (call.reply.error || call.reply.result?.isError) throw new Error('todo_list failed')
  const text = ((call.reply.result?.content ?? []) as { type?: string; text?: string }[])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')
  const todos = parseTodoChecklist(text)
  if (!todos) throw new Error('todo_list did not come back as a checklist')
  return todos
}

const CHECK_ROW = /^\[( |x)\] (.*)$/
const ID_TAIL = /\s*\[id:([^\]\s]+)\]\s*$/

/** Parses todo_list's checklist (`[ ] title - due YYYY-MM-DD #label [pinned]  [id:uuid]`); null when it is not one. */
export function parseTodoChecklist(text: string): FourmanNoteTodo[] | null {
  const todos: FourmanNoteTodo[] = []
  for (const line of text.split('\n')) {
    const row = CHECK_ROW.exec(line.trim())
    const body = row?.[2] ?? ''
    const id = ID_TAIL.exec(body)
    if (!row || !id) continue
    let rest = body.slice(0, id.index).replace(/ \[pinned\]$/, '')
    const labelTail = /((?: #\S+)+)$/.exec(rest)
    const labels = labelTail?.[1]?.split(' #').filter(Boolean) ?? []
    if (labelTail) rest = rest.slice(0, labelTail.index)
    const due = / - due (\d{4}-\d{2}-\d{2})$/.exec(rest)
    if (due) rest = rest.slice(0, due.index)
    todos.push({
      id: id[1] ?? '',
      title: rest.trim(),
      done: row[1] === 'x',
      ...(due ? { due: due[1] } : {}),
      ...(labels.length ? { labels } : {}),
    })
  }
  if (todos.length || /\(no to-dos match\)/.test(text)) return todos
  return null
}

export function clearFourmanCaches(): void {
  cache.clear()
  notesCache.clear()
  discovered.clear()
}
