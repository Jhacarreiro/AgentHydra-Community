// The core's server (core/README.md): the chat API under /api on 127.0.0.1, and one WebSocket at /ws that sends every
// change as Desk's ServerEvent. Bad input is 400, an unknown chat or session 404, and nothing answers 5xx.
import { isThrowawayCwd } from '../../desk2/shared/throwaway'
import { accounts } from './accounts'
import { chatgptBackend } from './backends/chatgpt'
import { claudeBackend } from './backends/claude'
import { codexBackend } from './backends/codex'
import { ChatError, Chats, type Json, obj } from './chat'
import { history } from './history'
import { Store } from './store'
import { taskRoutes } from './tasks'
import type { Page } from './types'

export const parts = { accounts, history, backends: [claudeBackend, codexBackend, chatgptBackend] }

const PORT = Number(process.env.CORE_PORT ?? 7789)

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function fail(status: number, error: string): Response {
  return json({ error }, status)
}

async function body(req: Request): Promise<Json> {
  let v: unknown
  try {
    v = await req.json()
  } catch {
    throw new ChatError(400, 'the body must be JSON')
  }
  return obj(v)
}

/** A `before` query value: a whole number, or nothing when it is optional. */
function before(url: URL, required: boolean): number | null {
  const raw = url.searchParams.get('before')
  if (raw === null) {
    if (required) throw new ChatError(400, 'before is required')
    return null
  }
  const n = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n))
    throw new ChatError(400, 'before must be a whole number')
  return n
}

/** A page of an outside transcript; the header names the `before` that reads the page above it. */
async function page(p: Promise<Page | null>): Promise<Response> {
  const pg = await p
  if (!pg) return fail(404, 'no such session')
  return json(
    pg.items,
    200,
    pg.olderBefore === null ? {} : { 'x-older-before': String(pg.olderBefore) },
  )
}

const outside = parts.history()
// Tasks (core/README.md, "Tasks"): what CliMayte workers and HSwarm jobs become.
const tasks = taskRoutes()
const store = new Store()
let server: ReturnType<typeof Bun.serve>
const pool = parts.accounts()
const chats = new Chats({
  store,
  accounts: pool,
  history: outside,
  backends: parts.backends.map((make) => make()),
  emit: (event) => server.publish('events', JSON.stringify(event)),
})

type Route = [
  method: string,
  path: RegExp,
  run: (m: RegExpMatchArray, req: Request, url: URL) => Promise<Response> | Response,
]

const id = (m: RegExpMatchArray): string => decodeURIComponent(m[1]!)

const routes: Route[] = [
  // Says which server this is: on 2026-10-14 the orchestrator's dashboard held the core's old port and answered /api/chats.
  ['GET', /^\/api\/health$/, () => json({ ok: true, name: 'agenthydra-core' })],
  ['GET', /^\/api\/chats$/, () => json(chats.list())],
  [
    'GET',
    /^\/api\/usage$/,
    async () =>
      json(
        (await pool.list()).map(({ id, service, label, room }) => ({ id, service, label, room })),
      ),
  ],
  ['POST', /^\/api\/chats$/, async (_m, req) => json(chats.create(await body(req)), 201)],
  [
    'POST',
    /^\/api\/chats\/import$/,
    async (_m, req) => json(await chats.importSession(await body(req))),
  ],
  ['GET', /^\/api\/chats\/([^/]+)$/, (m) => json(chats.get(id(m)))],
  ['PATCH', /^\/api\/chats\/([^/]+)$/, async (m, req) => json(chats.patch(id(m), await body(req)))],
  [
    'DELETE',
    /^\/api\/chats\/([^/]+)$/,
    async (m) => {
      await chats.remove(id(m))
      return json({ ok: true })
    },
  ],
  ['GET', /^\/api\/chats\/([^/]+)\/items$/, (m) => json(chats.items(id(m)))],
  [
    'POST',
    /^\/api\/chats\/([^/]+)\/messages$/,
    async (m, req) => json(chats.send(id(m), await body(req))),
  ],
  [
    'POST',
    /^\/api\/chats\/([^/]+)\/interrupt$/,
    (m) => {
      chats.interrupt(id(m))
      return json({ ok: true })
    },
  ],
  [
    'POST',
    /^\/api\/chats\/([^/]+)\/cancel-queued$/,
    async (m, req) => json(chats.cancelQueued(id(m), await body(req))),
  ],
  // ?throwaway=1: the live probe's own threads too (desk2/shared/throwaway.ts); a person's list never has them.
  [
    'GET',
    /^\/api\/external\/sessions$/,
    async (_m, _req, url) => {
      const all = await outside.list()
      return json(
        url.searchParams.get('throwaway') === '1' ? all : all.filter((s) => !isThrowawayCwd(s.cwd)),
      )
    },
  ],
  ['GET', /^\/api\/external\/sessions\/([^/]+)\/items$/, (m) => page(outside.tail(id(m)))],
  [
    'GET',
    /^\/api\/external\/sessions\/([^/]+)\/older$/,
    (m, _req, url) => page(outside.older(id(m), before(url, true)!)),
  ],
  [
    'GET',
    /^\/api\/sessions\/([^/]+)\/tail$/,
    (m, _req, url) => {
      const at = before(url, false)
      return page(at === null ? outside.tail(id(m)) : outside.older(id(m), at))
    },
  ],
]

async function handle(req: Request, url: URL): Promise<Response> {
  try {
    const task = await tasks(req, url)
    if (task) return task
    for (const [method, path, run] of routes) {
      if (req.method !== method) continue
      const m = path.exec(url.pathname)
      if (m) return await run(m, req, url)
    }
    return fail(404, `no route ${req.method} ${url.pathname}`)
  } catch (err) {
    if (err instanceof ChatError) return fail(err.status, err.message)
    // Anything else is a bad request as far as the window can tell: logged here, never a 5xx.
    console.error(`${req.method} ${url.pathname}:`, err instanceof Error ? err.message : err)
    return fail(400, 'that did not work')
  }
}

server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  // A task wait holds its request up to 50 s; Bun closes one idle for 10 s by default (2026-10-14: ECONNRESET).
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/ws')
      return srv.upgrade(req, { data: undefined })
        ? undefined
        : fail(400, 'not a WebSocket request')
    if (!url.pathname.startsWith('/api/')) return fail(404, 'not found')
    return handle(req, url)
  },
  websocket: {
    open(ws) {
      ws.subscribe('events')
    },
    message() {},
  },
  error(err) {
    console.error('server:', err instanceof Error ? err.message : err)
    return fail(400, 'that did not work')
  },
})

console.log(`AgentHydra core on http://127.0.0.1:${server.port}/api`)
