import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stopDashboardBackend } from '../src/dashboard-backend'
import {
  DashboardError,
  dashboardId,
  readDashboard,
  serveDashboardSite,
  setDashboardSelfUrl,
  workspaceOf,
  writeDashboard,
} from '../src/dashboards'

const root = mkdtempSync(join(tmpdir(), 'dashboard-backend-test-'))
const serverScript = join(root, 'tiny-backend.ts')
writeFileSync(
  serverScript,
  `const port = Number(process.argv[2])
Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === '/api/ping') return Response.json({ ok: true, port })
    if (u.pathname === '/api/echo') return new Response(await req.text(), { headers: { 'content-type': req.headers.get('content-type') ?? 'text/plain' } })
    if (u.pathname === '/api/query') return Response.json({ q: u.search })
    return new Response('no such route', { status: 404 })
  },
})
`,
)
const notAProgram = join(root, 'not-a-program.txt')
writeFileSync(notAProgram, 'plain text, not an executable\n')

let daemon: ReturnType<typeof Bun.serve>
let port = 0
const started: string[] = []

function projectFor(name: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const p = probe.port as number
  probe.stop(true)
  return p
}

const send = (id: string, path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { host: `${id}.localhost:${port}`, ...(init.headers as Record<string, string>) },
  })

const json = async (res: Response) => (await res.json()) as Record<string, unknown>

const declare = (
  folder: string,
  p: number,
  cmd: string[] = [process.execPath, serverScript, String(p)],
) => ({
  command: cmd,
  cwd: folder,
  port: p,
  health: '/api/ping',
})

beforeAll(() => {
  daemon = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) =>
      (await serveDashboardSite(req)) ?? new Response('no site', { status: 404 }),
  })
  port = daemon.port as number
  setDashboardSelfUrl(`http://127.0.0.1:${port}`)
})

afterAll(() => {
  for (const id of started) stopDashboardBackend(id)
  daemon.stop(true)
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

describe('declaring a backend', () => {
  test('dashboard_write stores it and dashboard_read returns it; null removes it', async () => {
    const project = projectFor('declare')
    const p = freePort()
    const written = await writeDashboard(project, {
      by: 'test',
      files: [{ path: 'index.html', content: '<p>hi</p>' }],
      backend: declare(project, p),
    })
    expect(written.backend).toEqual(declare(project, p))
    expect((await readDashboard(project)).backend).toEqual(declare(project, p))
    expect(
      (await writeDashboard(project, { by: 'test', files: [{ path: 'b.txt', content: 'x' }] }))
        .backend,
    ).toEqual(declare(project, p))
    expect((await writeDashboard(project, { by: 'test', backend: null })).backend).toBeNull()
  })

  test('a folder outside the project, a missing program or a bare program name is refused', async () => {
    const project = projectFor('refused')
    await expect(
      writeDashboard(project, { backend: declare(root, freePort()) }),
    ).rejects.toBeInstanceOf(DashboardError)
    await expect(
      writeDashboard(project, {
        backend: declare(project, freePort(), [join(project, 'missing.exe')]),
      }),
    ).rejects.toBeInstanceOf(DashboardError)
    await expect(
      writeDashboard(project, { backend: declare(project, freePort(), ['bun', serverScript]) }),
    ).rejects.toBeInstanceOf(DashboardError)
  })
})

describe('proxy', () => {
  const project = projectFor('proxy')
  const p = freePort()
  let id = ''

  beforeAll(async () => {
    await writeDashboard(project, {
      by: 'test',
      files: [{ path: 'index.html', content: '<p>app</p>' }],
      backend: declare(project, p),
    })
    id = dashboardId(workspaceOf(project))
    started.push(id)
  })

  test('GET is forwarded with its query, and the backend status, type and body come back', async () => {
    const ping = await send(id, '/_hydra/api/ping')
    expect(ping.status).toBe(200)
    expect(ping.headers.get('content-type')).toContain('application/json')
    expect(await json(ping)).toEqual({ ok: true, port: p })
    const query = await send(id, '/_hydra/api/query?x=1&y=two')
    expect(await json(query)).toEqual({ q: '?x=1&y=two' })
  })

  test('POST with the dashboard own origin and a JSON body is forwarded', async () => {
    const res = await send(id, '/_hydra/api/echo', {
      method: 'POST',
      headers: { origin: `http://${id}.localhost:${port}`, 'content-type': 'application/json' },
      body: '{"a":1}',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"a":1}')
  })

  test('POST is refused with a foreign origin, no origin, or a non-JSON body', async () => {
    const cases: Record<string, string>[] = [
      { origin: 'http://evil.example.test', 'content-type': 'application/json' },
      { 'content-type': 'application/json' },
      { origin: `http://${id}.localhost:${port}`, 'content-type': 'text/plain' },
    ]
    for (const headers of cases) {
      const res = await send(id, '/_hydra/api/echo', { method: 'POST', headers, body: '{}' })
      expect(res.status).toBe(403)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect((await json(res)).error).toBeTruthy()
    }
  })

  test('a dashboard without a backend answers 404 JSON', async () => {
    const bare = projectFor('bare')
    await writeDashboard(bare, { by: 'test', files: [{ path: 'index.html', content: 'x' }] })
    const res = await send(dashboardId(workspaceOf(bare)), '/_hydra/api/ping')
    expect(res.status).toBe(404)
    expect(await json(res)).toEqual({ error: 'this dashboard has no backend' })
  })

  test('a stopped backend is started on demand, and started again after it is killed', async () => {
    const project2 = projectFor('ondemand')
    const p2 = freePort()
    await writeDashboard(project2, {
      by: 'test',
      files: [{ path: 'index.html', content: 'x' }],
      backend: declare(project2, p2),
    })
    const id2 = dashboardId(workspaceOf(project2))
    started.push(id2)
    const before = await fetch(`http://127.0.0.1:${p2}/api/ping`).then(
      () => true,
      () => false,
    )
    expect(before).toBe(false)
    const first = await send(id2, '/_hydra/api/ping')
    expect(first.status).toBe(200)
    stopDashboardBackend(id2)
    const again = await send(id2, '/_hydra/api/ping')
    expect(again.status).toBe(200)
    expect((await json(again)).port).toBe(p2)
  }, 40_000)

  test('a command that cannot start answers 502 JSON with a sentence', async () => {
    const project3 = projectFor('broken')
    await writeDashboard(project3, {
      by: 'test',
      files: [{ path: 'index.html', content: 'x' }],
      backend: declare(project3, freePort(), [notAProgram]),
    })
    const id3 = dashboardId(workspaceOf(project3))
    started.push(id3)
    const res = await send(id3, '/_hydra/api/ping')
    expect(res.status).toBe(502)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(typeof (await json(res)).error).toBe('string')
  }, 40_000)

  test('paths outside /_hydra/api/<rest> and traversal are never forwarded', async () => {
    const encodedUp = await send(id, '/_hydra/api/%2e%2e%2Fping')
    expect(encodedUp.status).toBe(404)
    const slashUp = await send(id, '/_hydra/api/..%2Fping')
    expect(slashUp.status).toBe(404)
    const lookalike = await send(id, '/_hydra/apix/ping')
    expect(lookalike.status).toBe(404)
    expect(await lookalike.text()).not.toContain('"ok"')
    const sitePath = await send(id, '/api/ping')
    expect(sitePath.status).toBe(404)
    expect(await sitePath.text()).not.toContain('"ok"')
    const put = await send(id, '/_hydra/api/ping', { method: 'PUT' })
    expect(put.status).toBe(405)
  })

  test('the static site still answers next to the backend', async () => {
    const res = await send(id, '/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<p>app</p>')
  })
})
