// server/src/dashboards.ts - a project's dashboard is a small static website its AIs write (any HTML, CSS, JS, images,
// data files, or a whole built folder). DATA_DIR/dashboards/<id>/site/ holds the files exactly as written and
// DATA_DIR/dashboards/<id>/meta.json who wrote last through the API. <id> is a DNS-label-safe slug of the project folder
// plus 6 hex of a sha1 of the workspace key; the daemon serves each site as its own origin <id>.localhost:<port>.
// Writes to one workspace are serialized in this process and applied all-or-nothing through a staging copy.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { DATA_DIR, PORT } from './config'
import {
  type DashboardBackend,
  ensureDashboardBackend,
  stopDashboardBackend,
} from './dashboard-backend'
import TODO_WIDGET from './dashboard-widgets/todo.js' with { type: 'text' }
import { fourmanBoard, unavailableBoard } from './fourman'

export class DashboardError extends Error {}

export const MAX_FILE_BYTES = 5 * 1024 * 1024
export const MAX_SITE_BYTES = 50 * 1024 * 1024
export const MAX_SITE_FILES = 1000
const MAX_DEPTH = 8
const MAX_BY = 60
const DEFAULT_BY = 'the person'
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/
const ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[0-9a-f]{6}$/
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export interface DashboardSummary {
  id: string
  workspace: string
  name: string
  url: string
  files: number
  bytes: number
  updatedAt: string | null
  updatedBy: string | null
}

export interface DashboardEntry {
  path: string
  bytes: number
  updatedAt: string
}

export interface DashboardRead extends DashboardSummary {
  folder: string
  entries: DashboardEntry[]
  backend: DashboardBackend | null
  path?: string
  content?: string
  encoding?: 'utf8' | 'base64'
}

export interface DashboardFile {
  path: string
  content: string
  encoding?: 'utf8' | 'base64'
}

export interface DashboardEdit {
  path: string
  old: string
  new: string
}

export interface DashboardChange {
  by?: string
  clear?: boolean
  from?: string
  files?: DashboardFile[]
  edits?: DashboardEdit[]
  remove?: string[]
  backend?: DashboardBackend | null
}

interface Meta {
  workspace: string
  name: string
  updatedBy: string
  updatedAt: string
  backend?: DashboardBackend
}

function fail(message: string): never {
  throw new DashboardError(message)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const root = () => join(DATA_DIR, 'dashboards')

// The daemon's own address, so a site's url carries the port it is really served on.
let selfUrl = `http://127.0.0.1:${PORT}`
export function setDashboardSelfUrl(url: string): void {
  selfUrl = url
}
function selfPort(): string {
  try {
    return new URL(selfUrl).port || '80'
  } catch {
    return String(PORT)
  }
}
const urlFor = (id: string) => `http://${id}.localhost:${selfPort()}/`

/** The workspace key: the nearest checkout (a folder with .git) up from `folder`, else the folder itself. */
export function workspaceOf(folder: string): string {
  let real: string
  try {
    real = realpathSync.native(resolve(folder))
  } catch {
    throw new DashboardError(`cwd is not an existing folder: ${folder}`)
  }
  let at = real
  for (;;) {
    if (existsSync(join(at, '.git'))) return at.replace(/\\/g, '/')
    const up = dirname(at)
    if (up === at) return real.replace(/\\/g, '/')
    at = up
  }
}

/** The stable DNS-label-safe id of a workspace. */
export function dashboardId(workspace: string): string {
  const key = process.platform === 'win32' ? workspace.toLowerCase() : workspace
  const hex = createHash('sha1').update(key).digest('hex').slice(0, 6)
  const slug = basename(workspace)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return `${slug || 'project'}-${hex}`
}

const dirOf = (id: string) => join(root(), id)
const siteOf = (id: string) => join(dirOf(id), 'site')

/** Why a site-relative path is refused, or the normalized path (forward slashes). */
export function checkPath(raw: unknown, what = 'path'): string {
  if (typeof raw !== 'string' || !raw.trim()) fail(`${what} must be a non-empty relative path`)
  const p = raw.replace(/\\/g, '/')
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p))
    fail(
      `${what} ${JSON.stringify(raw)} must be relative to the site (no leading "/" or drive letter)`,
    )
  const parts = p.split('/')
  if (parts[0]?.toLowerCase() === '_hydra')
    fail(`${what} ${JSON.stringify(raw)}: the _hydra folder is reserved for AgentHydra's feeds`)
  if (parts.length > MAX_DEPTH)
    fail(`${what} ${JSON.stringify(raw)} is deeper than ${MAX_DEPTH} folders`)
  for (const seg of parts) {
    if (seg === '' || seg === '.' || seg === '..')
      fail(`${what} ${JSON.stringify(raw)} has an empty, "." or ".." part`)
    if (!SEGMENT_RE.test(seg))
      fail(
        `${what} ${JSON.stringify(raw)}: "${seg}" may only use letters, digits, ".", "_" and "-"`,
      )
    if (seg.endsWith('.')) fail(`${what} ${JSON.stringify(raw)}: "${seg}" must not end with "."`)
    if (RESERVED_RE.test(seg.split('.')[0] ?? ''))
      fail(`${what} ${JSON.stringify(raw)}: "${seg}" is a name Windows reserves`)
  }
  return p
}

interface Walked {
  path: string
  bytes: number
  mtimeMs: number
}

/** Every regular file under `dir` (symlinks skipped), sorted by path. */
async function walk(dir: string, prefix = ''): Promise<Walked[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: Walked[] = []
  for (const n of names) {
    const full = join(dir, n)
    const s = await lstat(full)
    if (s.isSymbolicLink()) continue
    if (s.isDirectory()) out.push(...(await walk(full, `${prefix}${n}/`)))
    else if (s.isFile()) out.push({ path: `${prefix}${n}`, bytes: s.size, mtimeMs: s.mtimeMs })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

async function readMeta(id: string): Promise<Meta | null> {
  try {
    const m = JSON.parse(await readFile(join(dirOf(id), 'meta.json'), 'utf8')) as Meta
    return isObj(m) ? m : null
  } catch {
    return null
  }
}

async function summarize(
  id: string,
  workspace: string,
  files: Walked[],
): Promise<DashboardSummary> {
  const meta = await readMeta(id)
  const newest = files.reduce((m, f) => Math.max(m, f.mtimeMs), 0)
  return {
    id,
    workspace,
    name: basename(workspace),
    url: urlFor(id),
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    updatedAt: files.length ? new Date(newest).toISOString() : null,
    updatedBy: meta?.updatedBy ?? null,
  }
}

async function fullRead(id: string, workspace: string, path?: string): Promise<DashboardRead> {
  await mkdir(siteOf(id), { recursive: true })
  const files = await walk(siteOf(id))
  const out: DashboardRead = {
    ...(await summarize(id, workspace, files)),
    folder: siteOf(id),
    entries: files.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      updatedAt: new Date(f.mtimeMs).toISOString(),
    })),
    backend: (await readMeta(id))?.backend ?? null,
  }
  if (path !== undefined) {
    const rel = checkPath(path)
    if (!files.some((f) => f.path === rel))
      fail(
        `there is no file ${rel} in this dashboard; the files are: ${files.map((f) => f.path).join(', ') || '(none yet)'}`,
      )
    const buf = await readFile(join(siteOf(id), ...rel.split('/')))
    out.path = rel
    if (buf.includes(0)) {
      out.encoding = 'base64'
      out.content = buf.toString('base64')
    } else out.content = buf.toString('utf8')
  }
  return out
}

export async function readDashboard(folder: string, path?: string): Promise<DashboardRead> {
  const workspace = workspaceOf(folder)
  return fullRead(dashboardId(workspace), workspace, path || undefined)
}

/** Writes to one workspace run one after another in this process. */
const queues = new Map<string, Promise<unknown>>()
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
  const tail = next.catch(() => {})
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return next
}

function parseChange(raw: unknown): DashboardChange & { by: string } {
  if (!isObj(raw)) fail('the change must be an object')
  const by = typeof raw.by === 'string' && raw.by.trim() ? raw.by.trim() : DEFAULT_BY
  if (by.length > MAX_BY) fail(`by is over ${MAX_BY} characters`)
  const list = (v: unknown, name: string): unknown[] => {
    if (v === undefined || v === null) return []
    if (!Array.isArray(v)) fail(`${name} must be a list`)
    return v
  }
  if (raw.from !== undefined && raw.from !== null && typeof raw.from !== 'string')
    fail('from must be an absolute folder path')
  const files = list(raw.files, 'files').map((f, i) => {
    if (!isObj(f) || typeof f.content !== 'string')
      fail(`files[${i}] needs a path and a string content`)
    const encoding = f.encoding ?? 'utf8'
    if (encoding !== 'utf8' && encoding !== 'base64')
      fail(`files[${i}].encoding must be "utf8" or "base64"`)
    const path = checkPath(f.path, `files[${i}].path`)
    const bytes = Buffer.byteLength(f.content, encoding === 'base64' ? 'base64' : 'utf8')
    if (bytes > MAX_FILE_BYTES)
      fail(`${path} is ${bytes} bytes; a file is at most ${MAX_FILE_BYTES} (5 MB)`)
    return { path, content: f.content, encoding } as DashboardFile
  })
  // A call that could never fit is refused here, before its files are written to a staging copy.
  const distinct = new Set(files.map((f) => f.path)).size
  if (distinct > MAX_SITE_FILES)
    fail(`a dashboard holds at most ${MAX_SITE_FILES} files; this change writes ${distinct}`)
  const edits = list(raw.edits, 'edits').map((e, i) => {
    if (!isObj(e) || typeof e.old !== 'string' || typeof e.new !== 'string' || !e.old)
      fail(`edits[${i}] needs a path, a non-empty "old" text and a "new" text`)
    return { path: checkPath(e.path, `edits[${i}].path`), old: e.old, new: e.new }
  })
  const remove = list(raw.remove, 'remove').map((p, i) => checkPath(p, `remove[${i}]`))
  return {
    by,
    clear: raw.clear === true,
    from: typeof raw.from === 'string' && raw.from.trim() ? raw.from : undefined,
    files,
    edits,
    remove,
    backend: parseBackendArg(raw.backend),
  }
}

function parseBackendArg(raw: unknown): DashboardBackend | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (!isObj(raw))
    fail('backend must be an object {command, cwd, port, health}, or null to remove it')
  const { command, cwd, port, health } = raw
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((c) => typeof c !== 'string' || !c)
  )
    fail('backend.command must be a list of strings: the program, then its arguments')
  const exe = command[0] as string
  if (!isAbsolute(exe) && !/[\\/]/.test(exe))
    fail(
      `backend.command[0] ${JSON.stringify(exe)} must be an absolute path or a path relative to cwd`,
    )
  if (typeof cwd !== 'string' || !isAbsolute(cwd))
    fail('backend.cwd must be an absolute folder path')
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535)
    fail('backend.port must be a port number from 1 to 65535')
  if (typeof health !== 'string' || !health.startsWith('/'))
    fail('backend.health must be a path such as /api/ping')
  return { command: command as string[], cwd, port: port as number, health }
}

/** The backend's folder must be inside the project and its program must exist; both are checked on write. */
async function checkBackend(backend: DashboardBackend, workspace: string): Promise<void> {
  let cwd: string
  try {
    cwd = await realpath(backend.cwd)
    if (!(await stat(cwd)).isDirectory()) throw new Error('not a folder')
  } catch {
    fail(`backend.cwd is not an existing folder: ${backend.cwd}`)
  }
  const ws = await realpath(workspace).catch(() => resolve(workspace))
  const lower = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  if (lower(cwd) !== lower(ws) && !lower(cwd).startsWith(lower(ws) + sep))
    fail('backend.cwd must be inside the project folder')
  const exe = resolve(backend.cwd, backend.command[0] ?? '')
  try {
    if (!(await stat(exe)).isFile()) throw new Error('not a file')
  } catch {
    fail(`backend.command[0] is not an existing file: ${exe}`)
  }
}

/** Copy an outside folder into `dest`, refusing names the site could not hold and anything over the limits. */
async function copyFrom(src: string, dest: string): Promise<void> {
  if (!/^([A-Za-z]:[\\/]|\/)/.test(src))
    fail(`from must be an absolute folder path, got ${JSON.stringify(src)}`)
  let real: string
  try {
    real = await realpath(src)
    if (!(await stat(real)).isDirectory()) throw new Error('not a folder')
  } catch {
    fail(`from is not an existing folder: ${src}`)
  }
  const store = await realpath(root()).catch(() => resolve(root()))
  const lower = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  if (lower(real) === lower(store) || lower(real).startsWith(lower(store) + sep))
    fail('from cannot be inside the dashboards store; point it at the folder you built')
  const files = await walk(real)
  for (const f of files) checkPath(f.path, `from file`)
  checkLimits(files)
  for (const f of files) {
    const to = join(dest, ...f.path.split('/'))
    await mkdir(dirname(to), { recursive: true })
    await cp(join(real, ...f.path.split('/')), to, { preserveTimestamps: true })
  }
}

function checkLimits(files: { path: string; bytes: number }[]): void {
  if (files.length > MAX_SITE_FILES)
    fail(
      `a dashboard holds at most ${MAX_SITE_FILES} files; this change would leave ${files.length}`,
    )
  let total = 0
  for (const f of files) {
    if (f.bytes > MAX_FILE_BYTES)
      fail(`${f.path} is ${f.bytes} bytes; a file is at most ${MAX_FILE_BYTES} (5 MB)`)
    total += f.bytes
  }
  if (total > MAX_SITE_BYTES)
    fail(`this change would make the site ${total} bytes; the limit is ${MAX_SITE_BYTES} (50 MB)`)
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p)
    return true
  } catch {
    return false
  }
}

export async function writeDashboard(folder: string, raw: unknown): Promise<DashboardRead> {
  const change = parseChange(raw)
  const workspace = workspaceOf(folder)
  const id = dashboardId(workspace)
  if (change.backend) await checkBackend(change.backend, workspace)
  return serialized(id, async () => {
    const dir = dirOf(id)
    const site = siteOf(id)
    const previous = await readMeta(id)
    await mkdir(site, { recursive: true })
    for (const n of await readdir(dir)) {
      if (n.startsWith('.staging-') || n === 'site.old')
        await rm(join(dir, n), { recursive: true, force: true })
    }
    const staging = join(dir, `.staging-${randomBytes(4).toString('hex')}`)
    try {
      await mkdir(staging, { recursive: true })
      if (change.from) await copyFrom(change.from, staging)
      else if (!change.clear) await cp(site, staging, { recursive: true, preserveTimestamps: true })
      const at = (p: string) => join(staging, ...p.split('/'))
      for (const f of change.files ?? []) {
        const data = Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8')
        if (data.length > MAX_FILE_BYTES)
          fail(`${f.path} is ${data.length} bytes; a file is at most ${MAX_FILE_BYTES} (5 MB)`)
        if ((await exists(at(f.path))) && !(await lstat(at(f.path))).isFile())
          fail(`${f.path} is a folder here; write a file inside it or remove it first`)
        await mkdir(dirname(at(f.path)), { recursive: true })
        await writeFile(at(f.path), data)
      }
      for (const [i, e] of (change.edits ?? []).entries()) {
        let text: string
        try {
          text = await readFile(at(e.path), 'utf8')
        } catch {
          fail(`edits[${i}]: ${e.path} does not exist; create it with files first`)
        }
        const first = text.indexOf(e.old)
        if (first < 0)
          fail(
            `edits[${i}]: the "old" text was not found in ${e.path}; read the file again, it may have changed`,
          )
        if (text.indexOf(e.old, first + 1) >= 0)
          fail(
            `edits[${i}]: the "old" text occurs more than once in ${e.path}; include more surrounding text so it is unique`,
          )
        await writeFile(at(e.path), text.slice(0, first) + e.new + text.slice(first + e.old.length))
      }
      for (const p of change.remove ?? []) await rm(at(p), { force: true })
      checkLimits(await walk(staging))
      await rm(join(dir, 'site.old'), { recursive: true, force: true })
      await rename(site, join(dir, 'site.old'))
      await rename(staging, site)
      await rm(join(dir, 'site.old'), { recursive: true, force: true })
    } catch (err) {
      await rm(staging, { recursive: true, force: true })
      if (!(await exists(site)) && (await exists(join(dir, 'site.old'))))
        await rename(join(dir, 'site.old'), site)
      throw err
    }
    const backend = change.backend === undefined ? previous?.backend : (change.backend ?? undefined)
    const meta: Meta = {
      workspace,
      name: basename(workspace),
      updatedBy: change.by,
      updatedAt: new Date().toISOString(),
      ...(backend ? { backend } : {}),
    }
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
    if (JSON.stringify(previous?.backend ?? null) !== JSON.stringify(backend ?? null))
      stopDashboardBackend(id)
    return fullRead(id, workspace)
  })
}

/** Every dashboard with at least one file, newest first. Anything in the store that is not an <id> folder is ignored. */
export async function listDashboards(): Promise<DashboardSummary[]> {
  let names: string[]
  try {
    names = await readdir(root())
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const found: DashboardSummary[] = []
  for (const id of names.filter((n) => ID_RE.test(n))) {
    const files = await walk(siteOf(id))
    if (!files.length) continue
    const meta = await readMeta(id)
    found.push(await summarize(id, meta?.workspace ?? id, files))
  }
  return found.sort((a, b) => ((a.updatedAt ?? '') < (b.updatedAt ?? '') ? 1 : -1))
}

// --- hosting: <id>.localhost[:port] answers from that dashboard's site/ folder ---

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  wasm: 'application/wasm',
  map: 'application/json; charset=utf-8',
}

const SITE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

const PLACEHOLDER = `<!doctype html><html><head><meta charset="utf-8"><title>No dashboard yet</title>
<style>body{font:16px system-ui,sans-serif;max-width:34em;margin:15vh auto;padding:0 1em;color:#333}code{background:#eee;padding:.1em .3em;border-radius:3px}</style></head>
<body><h1>No dashboard yet</h1><p>This project has no dashboard page. Ask a chat in this project to build its dashboard with <code>dashboard_write</code> (an <code>index.html</code> is the entry point).</p></body></html>`

/** The dashboard id a Host header names (`<id>.localhost` with or without a port), or null for any other host. */
export function dashboardHostId(host: string | null): string | null {
  if (!host) return null
  const m = /^([a-z0-9-]+)\.localhost(?::\d+)?$/i.exec(host.trim())
  return m?.[1] ? m[1].toLowerCase() : null
}

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...SITE_HEADERS, ...extra },
  })
}

async function hydraFeed(id: string, rest: string[], isHead: boolean): Promise<Response> {
  if (rest.length === 1 && rest[0] === 'todo.json') {
    const meta = await readMeta(id)
    const board = meta
      ? await fourmanBoard({ folder: meta.workspace })
      : unavailableBoard('this dashboard has no project folder')
    return new Response(isHead ? null : JSON.stringify(board), {
      headers: { 'content-type': 'application/json; charset=utf-8', ...SITE_HEADERS },
    })
  }
  if (rest.length === 1 && rest[0] === 'todo.js')
    return new Response(isHead ? null : TODO_WIDGET, {
      headers: { 'content-type': 'text/javascript; charset=utf-8', ...SITE_HEADERS },
    })
  return text(404, 'not found')
}

const API_PREFIX = '/_hydra/api'
const MAX_BODY_BYTES = 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 30_000
const NO_BODY_STATUS = [101, 204, 205, 304]

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SITE_HEADERS, ...extra },
  })
}

async function readBodyLimited(req: Request): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array()
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

async function serveBackend(id: string, req: Request, url: URL): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'POST')
    return json(
      405,
      { error: 'a dashboard backend only answers GET and POST' },
      { allow: 'GET, POST' },
    )
  const rest = url.pathname.slice(API_PREFIX.length)
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    return json(400, { error: 'bad path' })
  }
  if (
    decoded.includes('\0') ||
    decoded.includes('\\') ||
    decoded.split('/').some((s) => s === '.' || s === '..')
  )
    return json(404, { error: 'not found' })
  const backend = (await readMeta(id))?.backend
  if (!backend) return json(404, { error: 'this dashboard has no backend' })
  let body: Uint8Array | undefined
  if (req.method === 'POST') {
    const own = `http://${(req.headers.get('host') ?? '').toLowerCase()}`
    const mime = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (req.headers.get('origin')?.toLowerCase() !== own)
      return json(403, { error: 'a POST is accepted only from this dashboard itself' })
    if (mime !== 'application/json')
      return json(403, { error: 'a POST body must be application/json' })
    const read = await readBodyLimited(req)
    if (!read) return json(413, { error: 'the request body is over 1 MB' })
    body = read
  }
  const problem = await ensureDashboardBackend(id, backend, join(dirOf(id), 'backend.log'))
  if (problem) return json(502, { error: problem })
  const headers = new Headers()
  const accept = req.headers.get('accept')
  const type = req.headers.get('content-type')
  if (accept) headers.set('accept', accept)
  if (type) headers.set('content-type', type)
  try {
    const upstream = await fetch(`http://127.0.0.1:${backend.port}/api${rest}${url.search}`, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    const bytes = await upstream.arrayBuffer()
    const nullBody = NO_BODY_STATUS.includes(upstream.status)
    return new Response(nullBody ? null : bytes, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        ...SITE_HEADERS,
      },
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError')
      return json(504, { error: 'the backend did not answer within 30 seconds' })
    return json(502, { error: 'the backend stopped answering; see backend.log' })
  }
}

/** Starts the backend of every dashboard that declares one; called once when the daemon boots. */
export async function startDeclaredBackends(): Promise<void> {
  const names = await readdir(root()).catch(() => [] as string[])
  for (const id of names.filter((n) => ID_RE.test(n))) {
    const backend = (await readMeta(id))?.backend
    if (backend) void ensureDashboardBackend(id, backend, join(dirOf(id), 'backend.log'))
  }
}

/** A Response when the request's Host names a dashboard site (answered here, never reaching /api), else null. */
export async function serveDashboardSite(req: Request): Promise<Response | null> {
  const id = dashboardHostId(req.headers.get('host'))
  if (!id) return null
  const url = new URL(req.url)
  if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`))
    return serveBackend(id, req, url)
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return text(405, 'a dashboard site only answers GET and HEAD', { allow: 'GET, HEAD' })
  if (!ID_RE.test(id) || !(await exists(dirOf(id)))) return text(404, 'no such dashboard')
  let segs: string[]
  try {
    const decoded = decodeURIComponent(url.pathname)
    if (decoded.includes('\0') || decoded.includes('\\')) return text(400, 'bad path')
    segs = decoded.split('/').filter(Boolean)
  } catch {
    return text(400, 'bad path')
  }
  if (segs.some((s) => s === '.' || s === '..')) return text(404, 'not found')
  const isHead = req.method === 'HEAD'
  if (segs[0] === '_hydra') return hydraFeed(id, segs.slice(1), isHead)
  const site = siteOf(id)
  const html = (body: string, status = 200) =>
    new Response(isHead ? null : body, {
      status,
      headers: { 'content-type': TYPES.html as string, ...SITE_HEADERS },
    })
  let siteReal: string
  try {
    siteReal = await realpath(site)
  } catch {
    return html(PLACEHOLDER)
  }
  let target = join(siteReal, ...segs)
  let real: string
  try {
    real = await realpath(target)
  } catch {
    if (segs.length === 0) return html(PLACEHOLDER)
    return text(404, 'not found')
  }
  if (real !== siteReal && !real.startsWith(siteReal + sep)) return text(404, 'not found')
  const s = await stat(real)
  if (s.isDirectory()) {
    if (segs.length && !url.pathname.endsWith('/'))
      return new Response(null, {
        status: 301,
        headers: { location: `${url.pathname}/${url.search}`, ...SITE_HEADERS },
      })
    target = join(real, 'index.html')
    try {
      real = await realpath(target)
    } catch {
      return segs.length === 0 ? html(PLACEHOLDER) : text(404, 'not found')
    }
    if (!real.startsWith(siteReal + sep)) return text(404, 'not found')
  }
  const body = await readFile(real)
  const type = TYPES[extname(real).slice(1).toLowerCase()] ?? 'application/octet-stream'
  return new Response(isHead ? null : body, {
    status: 200,
    headers: { 'content-type': type, 'content-length': String(body.length), ...SITE_HEADERS },
  })
}
