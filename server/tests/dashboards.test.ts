import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  DashboardError,
  dashboardId,
  listDashboards,
  MAX_SITE_FILES,
  readDashboard,
  serveDashboardSite,
  setDashboardSelfUrl,
  workspaceOf,
  writeDashboard,
} from '../src/dashboards'
import { app } from '../src/http-app'
import '../src/routes/dashboards'
import { TOOLS } from '../src/mcp'
import { resetDaemonResolutionForTests, useOwnDaemon } from '../src/mcp-client'
import { withDeskChat } from '../src/mcp-find'

// A copy of the routes so far: a request through the shared app builds its router, and every later
// test file that loads a routes/*.ts module then dies at import (queue-patch-guard.test.ts).
const http = new Hono().route('/', app)

const root = mkdtempSync(join(tmpdir(), 'dashboards-test-'))
const project = join(root, 'My Project!')
const inside = join(project, 'src', 'deep')
mkdirSync(join(project, '.git'), { recursive: true })
mkdirSync(inside, { recursive: true })

const saved: Record<string, string | undefined> = {}
function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

let daemon: ReturnType<typeof Bun.serve>
let desk: ReturnType<typeof Bun.serve>
let port = 0

const fresh = (name: string) => {
  const dir = join(root, name)
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}
const refused = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(DashboardError)
const get = (id: string, path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { host: `${id}.localhost:${port}` },
  })

beforeAll(() => {
  daemon = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req, srv) => (await serveDashboardSite(req)) ?? http.fetch(req, srv),
  })
  port = daemon.port as number
  setDashboardSelfUrl(`http://127.0.0.1:${port}`)
  desk = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => Response.json([{ id: 'chat-1', title: 'Example chat', cwd: inside }]),
  })
  useOwnDaemon(`http://127.0.0.1:${port}`)
  setEnv('HYDRA_DESK_PORT', String(desk.port))
  setEnv('HYDRA_DESK_CHAT_ID', 'chat-1')
})

afterAll(() => {
  daemon.stop(true)
  desk.stop(true)
  resetDaemonResolutionForTests()
  for (const [key, value] of Object.entries(saved)) setEnv(key, value)
  rmSync(root, { recursive: true, force: true })
})

describe('ids and keying', () => {
  test('the id is a DNS-safe slug plus 6 hex, stable, and any folder inside the project shares it', async () => {
    const id = dashboardId(workspaceOf(project))
    expect(id).toMatch(/^my-project-[0-9a-f]{6}$/)
    expect(dashboardId(workspaceOf(project))).toBe(id)
    expect((await readDashboard(inside)).id).toBe(id)
    expect((await readDashboard(project)).url).toBe(`http://${id}.localhost:${port}/`)
  })

  test('an empty name falls back to "project"', () => {
    expect(dashboardId('/')).toMatch(/^project-[0-9a-f]{6}$/)
  })

  test('a missing folder is refused', async () => {
    await refused(readDashboard(join(root, 'missing')))
  })
})

describe('writing', () => {
  test('files, edits, remove and clear', async () => {
    const dir = fresh('w1')
    await writeDashboard(dir, {
      by: 'Example owner',
      files: [
        { path: 'index.html', content: '<h1>A</h1><p>x</p>' },
        { path: 'data/d.json', content: '{}' },
        {
          path: 'pic.png',
          content: Buffer.from([1, 2, 0, 3]).toString('base64'),
          encoding: 'base64',
        },
      ],
    })
    let r = await readDashboard(dir)
    expect(r.entries.map((e) => e.path)).toEqual(['data/d.json', 'index.html', 'pic.png'])
    expect(r.updatedBy).toBe('Example owner')
    r = await writeDashboard(dir, {
      edits: [{ path: 'index.html', old: '<p>x</p>', new: '<p>y</p>' }],
      remove: ['data/d.json'],
    })
    expect(r.entries.map((e) => e.path)).toEqual(['index.html', 'pic.png'])
    expect((await readDashboard(dir, 'index.html')).content).toBe('<h1>A</h1><p>y</p>')
    expect((await readDashboard(dir, 'pic.png')).encoding).toBe('base64')
    r = await writeDashboard(dir, { clear: true, files: [{ path: 'a.txt', content: 'a' }] })
    expect(r.entries.map((e) => e.path)).toEqual(['a.txt'])
  })

  test('a failed edit refuses the whole call and changes nothing', async () => {
    const dir = fresh('w2')
    await writeDashboard(dir, { files: [{ path: 'index.html', content: 'aa bb' }] })
    await expect(
      writeDashboard(dir, {
        files: [{ path: 'new.txt', content: 'n' }],
        edits: [{ path: 'index.html', old: 'a', new: 'c' }],
      }),
    ).rejects.toThrow('more than once')
    await expect(
      writeDashboard(dir, { edits: [{ path: 'index.html', old: 'zz', new: 'c' }] }),
    ).rejects.toThrow('not found')
    const r = await readDashboard(dir)
    expect(r.entries.map((e) => e.path)).toEqual(['index.html'])
    expect((await readDashboard(dir, 'index.html')).content).toBe('aa bb')
  })

  test('from publishes a folder as the whole site', async () => {
    const dir = fresh('w3')
    const dist = join(root, 'dist')
    mkdirSync(join(dist, 'assets'), { recursive: true })
    writeFileSync(join(dist, 'index.html'), '<p>dist</p>')
    writeFileSync(join(dist, 'assets', 'a.js'), '1')
    await writeDashboard(dir, { files: [{ path: 'old.txt', content: 'o' }] })
    const r = await writeDashboard(dir, { from: dist })
    expect(r.entries.map((e) => e.path)).toEqual(['assets/a.js', 'index.html'])
    await refused(writeDashboard(dir, { from: r.folder }))
    await refused(writeDashboard(dir, { from: 'relative/dist' }))
  })

  const bad: [string, string][] = [
    ['dotdot', '../x.txt'],
    ['inner dotdot', 'a/../x.txt'],
    ['absolute', '/x.txt'],
    ['drive letter', 'C:/x.txt'],
    ['reserved name', 'docs/con.txt'],
    ['too deep', 'a/b/c/d/e/f/g/h/i.txt'],
    ['odd character', 'a b.txt'],
  ]
  for (const [label, path] of bad)
    test(`refuses ${label}`, async () => {
      await refused(writeDashboard(fresh('w4'), { files: [{ path, content: 'x' }] }))
    })

  test('size and file-count limits apply to the result of the whole call', async () => {
    const dir = fresh('w5')
    await refused(
      writeDashboard(dir, {
        files: [{ path: 'big.bin', content: 'x'.repeat(5 * 1024 * 1024 + 1) }],
      }),
    )
    const many = Array.from({ length: MAX_SITE_FILES + 1 }, (_, i) => ({
      path: `f${i}.txt`,
      content: '',
    }))
    await refused(writeDashboard(dir, { files: many }))
    expect((await readDashboard(dir)).files).toBe(0)
  })

  test('updatedAt follows file mtimes, so a direct edit shows', async () => {
    const dir = fresh('w6')
    const r = await writeDashboard(dir, { files: [{ path: 'index.html', content: 'a' }] })
    const when = new Date('2031-01-02T03:04:05.000Z')
    utimesSync(join(r.folder, 'index.html'), when, when)
    expect((await readDashboard(dir)).updatedAt).toBe(when.toISOString())
    expect((await listDashboards()).some((d) => d.id === r.id)).toBe(true)
  })

  test('two writes at once both land', async () => {
    const dir = fresh('w7')
    await Promise.all([
      writeDashboard(dir, { files: [{ path: 'a.txt', content: 'a' }] }),
      writeDashboard(dir, { files: [{ path: 'b.txt', content: 'b' }] }),
    ])
    expect((await readDashboard(dir)).entries.map((e) => e.path)).toEqual(['a.txt', 'b.txt'])
  })
})

describe('hosting at <id>.localhost', () => {
  test('serves index.html at /, nested files by type, with the site headers', async () => {
    const dir = fresh('h1')
    const r = await writeDashboard(dir, {
      files: [
        { path: 'index.html', content: '<h1>home</h1>' },
        { path: 'css/s.css', content: 'a{}' },
        { path: 'sub/index.html', content: 'sub' },
      ],
    })
    const home = await get(r.id, '/')
    expect(home.status).toBe(200)
    expect(await home.text()).toBe('<h1>home</h1>')
    expect(home.headers.get('cache-control')).toBe('no-store')
    expect(home.headers.get('x-content-type-options')).toBe('nosniff')
    expect(home.headers.get('x-frame-options')).toBeNull()
    const css = await get(r.id, '/css/s.css')
    expect(css.headers.get('content-type')).toContain('text/css')
    expect(await (await get(r.id, '/sub/')).text()).toBe('sub')
    writeFileSync(join(r.folder, 'index.html'), 'edited directly')
    expect(await (await get(r.id, '/')).text()).toBe('edited directly')
  })

  test('traversal is not served, an unknown id is 404, other methods are 405', async () => {
    const dir = fresh('h2')
    const r = await writeDashboard(dir, { files: [{ path: 'index.html', content: 'ok' }] })
    writeFileSync(join(r.folder, '..', 'secret.txt'), 'SECRET')
    for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt']) {
      const t = await get(r.id, p)
      expect(t.status).toBeGreaterThanOrEqual(400)
      expect(await t.text()).not.toContain('SECRET')
    }
    expect((await get('nothing-abcdef', '/')).status).toBe(404)
    expect((await get(r.id, '/', { method: 'POST', body: 'x' })).status).toBe(405)
  })

  test('a workspace with no files, or no index.html, gets the placeholder', async () => {
    const dir = fresh('h3')
    const r = await readDashboard(dir)
    const empty = await get(r.id, '/')
    expect(empty.status).toBe(200)
    expect(await empty.text()).toContain('dashboard_write')
    await writeDashboard(dir, { files: [{ path: 'other.html', content: 'o' }] })
    expect(await (await get(r.id, '/')).text()).toContain('No dashboard yet')
  })

  test('/api with a dashboard Host never reaches the API', async () => {
    const r = await readDashboard(project)
    const res = await get(r.id, '/api/dashboards')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('"dashboards"')
    const post = await get(r.id, '/api/dashboards/workspace', { method: 'POST', body: '{}' })
    expect(post.status).toBe(405)
  })
})

describe('REST routes', () => {
  const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init)
  const json = { 'content-type': 'application/json' }

  test('POST writes, GET reads with a path, a bad write is a 400', async () => {
    const dir = fresh('r1')
    const post = await api('/api/dashboards/workspace', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ cwd: dir, files: [{ path: 'index.html', content: 'hi' }] }),
    })
    expect(post.status).toBe(200)
    const got = (await (
      await api(`/api/dashboards/workspace?cwd=${encodeURIComponent(dir)}&path=index.html`)
    ).json()) as { content: string }
    expect(got.content).toBe('hi')
    const bad = await api('/api/dashboards/workspace', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ cwd: dir, files: [{ path: '../x', content: 'x' }] }),
    })
    expect(bad.status).toBe(400)
    expect((await api('/api/dashboards/workspace')).status).toBe(400)
    const list = (await (await api('/api/dashboards')).json()) as {
      dashboards: { files: number }[]
    }
    expect(list.dashboards.every((d) => d.files > 0)).toBe(true)
  })
})

describe('the MCP tools', () => {
  const tools = withDeskChat(TOOLS, 'chat-1')
  const tool = (name: string) => tools.find((t) => t.name === name)!

  test('dashboard_write with no cwd writes the calling chat folder, by its title', async () => {
    const answer = (await tool('dashboard_write').run({
      files: [{ path: 'index.html', content: 'mcp' }],
    })) as { updatedBy: string; url: string; folder: string }
    expect(answer.updatedBy).toBe('Example chat')
    expect(answer.url).toContain('.localhost:')
    expect(readFileSync(join(answer.folder, 'index.html'), 'utf8')).toBe('mcp')
  })

  test('dashboard_read with no cwd reads the calling chat folder', async () => {
    const answer = (await tool('dashboard_read').run({ path: 'index.html' })) as {
      content: string
    }
    expect(answer.content).toBe('mcp')
  })

  test('dashboard_write refuses a by longer than 60 characters', async () => {
    await expect(tool('dashboard_write').run({ cwd: project, by: 'x'.repeat(61) })).rejects.toThrow(
      'by is over 60 characters',
    )
  })

  test('with no folder and no Desk chat known, the tool says so', async () => {
    setEnv('HYDRA_DESK_CHAT_ID', undefined)
    setEnv('HYDRA_DESK_PORT', '1')
    try {
      await expect(tool('dashboard_read').run({})).rejects.toThrow('no folder to use')
    } finally {
      setEnv('HYDRA_DESK_PORT', String(desk.port))
      setEnv('HYDRA_DESK_CHAT_ID', 'chat-1')
    }
  })
})
