import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  DashboardError,
  dashboardId,
  serveDashboardSite,
  workspaceOf,
  writeDashboard,
} from '../src/dashboards'
import {
  clearFourmanCaches,
  findEngine,
  fourmanBoard,
  fourmanStatus,
  parseTodoChecklist,
  runEngine,
  setFourmanDeps,
} from '../src/fourman'
import { app } from '../src/http-app'
import '../src/routes/fourman'

// A copy of the routes so far: a request through the shared app builds its router, and every later
// test file that loads a routes/*.ts module then dies at import (queue-patch-guard.test.ts).
const http = new Hono().route('/', app)

const scratch = mkdtempSync(join(tmpdir(), 'fourman-test-'))
const engine = join(scratch, 'fake-4man.mjs')
const logPath = join(scratch, 'engine-runs.log')

writeFileSync(
  engine,
  `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
const at = args.indexOf('--folder')
const scope = at >= 0 ? args[at + 1] : args.includes('--all') ? 'all' : args[args.indexOf('--project') + 1]
if (process.env.FAKE_4MAN_LOG) appendFileSync(process.env.FAKE_4MAN_LOG, scope + '\\n')
const base = String(scope).replace(/\\\\/g, '/').split('/').pop()
if (base === 'slow') setTimeout(() => {}, 60000)
else {
  const task = (n, body) => ({
    id: 't' + n, title: 'Task ' + n, body, project: base, status: 'ready', tier: 'A', quadrant: 'Q1',
    type: 'build', size: 'S', impact: 'high', live: false, risky: false, needsHuman: false,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', tierWhy: 'example',
    cwd: 'C:/Users/me/Example', secret: 'not copied',
  })
  const ready = base === 'big'
    ? Array.from({ length: 250 }, (_, n) => task(n, 'b'))
    : [task(1, 'x'.repeat(700)), task(2, 'short')]
  process.stdout.write(JSON.stringify({ project: base, ready, readyCount: ready.length, human: [task(3, 'h')], claimed: [], pending: [], directions: [] }))
}
`,
)

const savedEnv = {
  AGENTHYDRA_FOURMAN: process.env.AGENTHYDRA_FOURMAN,
  FAKE_4MAN_LOG: process.env.FAKE_4MAN_LOG,
}

beforeAll(() => {
  process.env.AGENTHYDRA_FOURMAN = engine
  process.env.FAKE_4MAN_LOG = logPath
  setFourmanDeps({
    env: process.env,
    home: join(scratch, 'fake-home'),
    portOwner: async () => null,
  })
})

beforeEach(() => {
  clearFourmanCaches()
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratch, { recursive: true, force: true })
})

describe('discovery', () => {
  test('no engine means not installed', async () => {
    const emptyHome = join(scratch, 'empty-home')
    mkdirSync(emptyHome, { recursive: true })
    expect(findEngine({}, emptyHome)).toBeNull()
    process.env.AGENTHYDRA_FOURMAN = join(scratch, 'missing', '4man.mjs')
    const status = await fourmanStatus()
    process.env.AGENTHYDRA_FOURMAN = engine
    expect(status.available).toBe(false)
    expect(status.notes.available).toBe(false)
  })

  test('the env variable names the engine', () => {
    expect(findEngine({ AGENTHYDRA_FOURMAN: engine }, join(scratch, 'none'))).toEqual({
      path: engine,
      via: 'env',
    })
  })

  test('the Connections local MCP entry in ~/.claude.json gives the checkout', () => {
    const checkout = join(scratch, 'Connections')
    const home = join(scratch, 'config-home')
    const found = join(checkout, 'tools', '4man', '4man.mjs')
    mkdirSync(join(checkout, 'tools', '4man'), { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(found, '')
    const server = join(checkout, 'services', 'studio', 'local-mcp', 'src', 'index.mjs')
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          other: { command: 'node', args: ['C:/Example/other.mjs'] },
          connections: { command: 'node', args: [server] },
        },
      }),
    )
    expect(findEngine({}, home)).toEqual({ path: found, via: 'claude-config' })
  })
})

describe('the board', () => {
  test('a fake engine answer is trimmed, and body is cut to 600 characters', async () => {
    const board = await fourmanBoard({ folder: 'C:/Users/me/Example' })
    expect(board.available).toBe(true)
    expect(board.project).toBe('Example')
    expect(board.readyCount).toBe(2)
    expect(board.ready[0]?.body.length).toBe(600)
    expect(board.ready[1]?.body).toBe('short')
    expect(board.human.length).toBe(1)
    expect(board.notes).toEqual([])
    const keys = Object.keys(board.ready[0] ?? {}).sort()
    expect(keys).not.toContain('cwd')
    expect(keys).not.toContain('secret')
    expect(keys).toContain('tierWhy')
  })

  test('each list is capped at 200 and readyCount is the engine total', async () => {
    const board = await fourmanBoard({ folder: 'C:/Users/me/big' })
    expect(board.ready.length).toBe(200)
    expect(board.readyCount).toBe(250)
  })

  test('one engine run serves repeat requests inside the cache window', async () => {
    await fourmanBoard({ folder: 'C:/Users/me/cached' })
    await fourmanBoard({ folder: 'C:/Users/me/cached' })
    const runs = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.endsWith('/cached'))
    expect(runs.length).toBe(1)
  })

  test('an engine that does not answer in time is refused', async () => {
    await expect(runEngine(engine, ['list', '--folder', 'C:/Users/me/slow'], 300)).rejects.toThrow(
      /did not answer/,
    )
  })

  test('a missing engine answers available:false', async () => {
    process.env.AGENTHYDRA_FOURMAN = join(scratch, 'gone', '4man.mjs')
    const board = await fourmanBoard({ all: true })
    process.env.AGENTHYDRA_FOURMAN = engine
    expect(board.available).toBe(false)
    expect(board.ready).toEqual([])
    expect(board.notes).toEqual([])
  })
})

describe('routes', () => {
  test('the board needs a cwd, a project or all=1', async () => {
    const res = await http.fetch(new Request('http://127.0.0.1/api/fourman/board'))
    expect(res.status).toBe(400)
  })

  test('a relative cwd is refused', async () => {
    const res = await http.fetch(
      new Request('http://127.0.0.1/api/fourman/board?cwd=relative/folder'),
    )
    expect(res.status).toBe(400)
  })

  test('GET /api/fourman reports the engine and the notes status', async () => {
    const res = await http.fetch(new Request('http://127.0.0.1/api/fourman'))
    const body = (await res.json()) as { available: boolean; notes: { available: boolean } }
    expect(body.available).toBe(true)
    expect(body.notes.available).toBe(false)
  })
})

describe('dashboard origin', () => {
  const workspace = join(scratch, 'feed-project')
  mkdirSync(join(workspace, '.git'), { recursive: true })

  test('/_hydra/todo.json answers the dashboard folder board', async () => {
    await writeDashboard(workspace, { files: [{ path: 'index.html', content: '<p>x</p>' }] })
    const host = `${dashboardId(workspaceOf(workspace))}.localhost:7777`
    const res = await serveDashboardSite(
      new Request(`http://${host}/_hydra/todo.json`, { headers: { host } }),
    )
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as { available: boolean; project: string; ready: unknown[] }
    expect(body.available).toBe(true)
    expect(body.project).toBe('feed-project')
    expect(body.ready.length).toBe(2)
  })

  test('/_hydra/todo.js is the widget script', async () => {
    const host = `${dashboardId(workspaceOf(workspace))}.localhost:7777`
    const res = await serveDashboardSite(
      new Request(`http://${host}/_hydra/todo.js`, { headers: { host } }),
    )
    expect(res?.headers.get('content-type')).toContain('javascript')
    expect(await res?.text()).toContain('data-hydra-todo')
  })

  test('writes under _hydra/ are refused in every form', async () => {
    const refused = [
      { files: [{ path: '_hydra/todo.json', content: '{}' }] },
      { files: [{ path: '_Hydra/x.js', content: '' }] },
      { edits: [{ path: '_hydra/todo.js', old: 'a', new: 'b' }] },
      { remove: ['_hydra/todo.js'] },
    ]
    for (const change of refused) {
      await expect(writeDashboard(workspace, change)).rejects.toBeInstanceOf(DashboardError)
    }
  })
})

function closedPort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = probe.port as number
  probe.stop(true)
  return port
}

function writeClaudeConfig(home: string, entry: Record<string, unknown>): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ mcpServers: { 'connections-local': entry } }),
  )
}

describe('discovery through the local MCP port', () => {
  const checkout = join(scratch, 'Checkout')
  const found = join(checkout, 'tools', '4man', '4man.mjs')
  const home = join(scratch, 'port-home')
  mkdirSync(join(checkout, 'tools', '4man'), { recursive: true })
  writeFileSync(found, '')

  test('the process on the port names its checkout and the engine is found', async () => {
    const port = closedPort()
    writeClaudeConfig(home, { type: 'http', url: `http://127.0.0.1:${port}/mcp` })
    const asked: number[] = []
    setFourmanDeps({
      env: {},
      home,
      portOwner: async (p) => {
        asked.push(p)
        return `node "${join(checkout, 'services', 'studio', 'local-mcp', 'loader.mjs')}" --http --port ${p}`
      },
    })
    const status = await fourmanStatus()
    expect(status.available).toBe(true)
    expect(status.engine).toBe(found)
    await fourmanStatus()
    expect(asked).toEqual([port])
  })

  test('a non-loopback MCP url is never probed', async () => {
    writeClaudeConfig(home, { type: 'http', url: 'https://example.com/mcp' })
    let asked = 0
    setFourmanDeps({
      env: {},
      home,
      portOwner: async () => {
        asked++
        return null
      },
    })
    const status = await fourmanStatus()
    expect(status.available).toBe(false)
    expect(asked).toBe(0)
  })

  test('a port owner that is not a local-mcp script gives no engine', async () => {
    const port = closedPort()
    writeClaudeConfig(home, { type: 'http', url: `http://127.0.0.1:${port}/mcp` })
    setFourmanDeps({
      env: {},
      home,
      portOwner: async () => `node C:/Example/other-server.mjs --port ${port}`,
    })
    expect((await fourmanStatus()).available).toBe(false)
  })
})

describe('notes through the Connections local MCP', () => {
  const home = join(scratch, 'notes-home')
  const helper = join(scratch, 'headers-helper.mjs')
  const failingHelper = join(scratch, 'headers-failing.mjs')
  const token = 'invented-token-7f3a'
  const checklist = [
    '[ ] Renew example certificate - due 2026-10-20 #ops [pinned]  [id:11111111-1111-4111-8111-111111111111]',
    '[x] Sign example form - due 2026-10-01  [id:22222222-2222-4222-8222-222222222222]',
    '[ ] Call the example vendor #phone #billing  [id:33333333-3333-4333-8333-333333333333]',
    '',
    '(3 of 3 to-dos)',
  ].join('\n')
  let requests = 0
  let server: ReturnType<typeof Bun.serve>

  beforeAll(() => {
    writeFileSync(
      helper,
      `process.stdout.write(JSON.stringify({ authorization: 'Bearer ${token}' }))\n`,
    )
    writeFileSync(failingHelper, `process.stdout.write('Bearer ${token}'); process.exit(1)\n`)
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        if (req.headers.get('authorization') !== `Bearer ${token}`)
          return new Response('no', { status: 401 })
        const msg = (await req.json()) as { id?: number; method: string }
        if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 })
        if (msg.method === 'initialize') {
          return Response.json(
            {
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: '2025-03-26', capabilities: {} },
            },
            { headers: { 'mcp-session-id': 'session-1' } },
          )
        }
        if (req.headers.get('mcp-session-id') !== 'session-1')
          return new Response('no session', { status: 400 })
        requests++
        const payload = {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: checklist }] },
        }
        return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
  })

  afterAll(() => {
    server.stop(true)
  })

  beforeEach(() => {
    requests = 0
  })

  test('the checklist is parsed, cached for a minute and read with the helper headers', async () => {
    writeClaudeConfig(home, {
      type: 'http',
      url: `http://127.0.0.1:${server.port}/mcp`,
      headersHelper: `node "${helper}"`,
    })
    setFourmanDeps({ env: {}, home, portOwner: async () => null })
    const status = await fourmanStatus()
    expect(status.notes.available).toBe(true)
    const board = await fourmanBoard({ all: true })
    expect(board.notes).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Renew example certificate',
        due: '2026-10-20',
        done: false,
        labels: ['ops'],
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Sign example form',
        due: '2026-10-01',
        done: true,
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        title: 'Call the example vendor',
        done: false,
        labels: ['phone', 'billing'],
      },
    ])
    expect(requests).toBe(1)
    expect(JSON.stringify({ status, board })).not.toContain(token)
  })

  test('a failing helper retries once without headers and the answer leaks nothing', async () => {
    writeClaudeConfig(home, {
      type: 'http',
      url: `http://127.0.0.1:${server.port}/mcp`,
      headersHelper: `node "${failingHelper}"`,
    })
    setFourmanDeps({ env: {}, home, portOwner: async () => null })
    const status = await fourmanStatus()
    expect(status.notes.available).toBe(false)
    expect(status.notes.why).toBeDefined()
    expect(JSON.stringify(status)).not.toContain(token)
    expect(requests).toBe(0)
  })

  test('a server that is down gives notes.available false', async () => {
    writeClaudeConfig(home, { type: 'http', url: `http://127.0.0.1:${closedPort()}/mcp` })
    setFourmanDeps({ env: {}, home, portOwner: async () => null })
    const status = await fourmanStatus()
    expect(status.notes.available).toBe(false)
    expect(status.notes.why).toBeDefined()
  })

  test('an empty filter is an empty checklist, and text that is no checklist is refused', () => {
    expect(parseTodoChecklist('(no to-dos match)')).toEqual([])
    expect(parseTodoChecklist('something else entirely')).toBeNull()
  })
})
