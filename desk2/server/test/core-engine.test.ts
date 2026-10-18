// plugins/19-core.ts at its boundary: a Desk with a stand-in engine and a fake core. With Settings > New core on, a new
// chat is the core's and its routes and events go there; the list and the hello hold both engines' chats; a route the
// core lacks says so plainly. Off, a new chat is the engine's (owner, 2026-10-14: the switch, with the old engine kept).

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ServerEvent } from '@shared/protocol'
import { createServer, type DeskServer } from '../src/index'

const PLUGIN = resolve(import.meta.dir, '../src/plugins/19-core.ts').replaceAll('\\', '/')
const ENGINE = `export default function (app, ctx) {
  const mine = [{ id: 'desk-1', title: 'On the engine', cwd: 'C:/Users/me/a' }]
  app.get('/api/chats', (c) => c.json(mine))
  app.post('/api/chats', (c) => c.json({ id: 'desk-2', engine: 'desk' }, 201))
  app.get('/api/chats/:id', (c) => c.json({ id: c.req.param('id'), engine: 'desk' }))
  ctx.registerHello(() => ({ type: 'hello', version: ctx.version, settings: ctx.settings(), chats: mine }))
}`

const temps: string[] = []
const stops: (() => unknown)[] = []
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s()
  for (const d of temps.splice(0)) if (d) rmSync(d, { recursive: true, force: true })
})
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

/** The core's side: its health name, a chat list, made chats, one chat route and its event socket. */
function fakeCore() {
  const made: string[] = []
  const chats: { id: string; title: string; cwd: string; sessionId?: string }[] = [
    { id: 'core-1', title: 'On the core', cwd: 'C:/Users/me/b', sessionId: 'sess-core-1' },
  ]
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      const { pathname } = new URL(req.url)
      if (pathname === '/ws') return srv.upgrade(req, { data: undefined }) ? undefined : new Response('no', { status: 400 })
      if (pathname === '/api/health') return Response.json({ ok: true, name: 'agenthydra-core' })
      if (pathname === '/api/chats' && req.method === 'GET') return Response.json(chats)
      if (pathname === '/api/chats' && req.method === 'POST') {
        const chat = { id: `core-${chats.length + 1}`, title: 'Made on the core', cwd: 'C:/Users/me/b' }
        chats.push(chat)
        made.push(chat.id)
        return Response.json(chat, { status: 201 })
      }
      const one = /^\/api\/chats\/([^/]+)$/.exec(pathname)
      if (one && req.method === 'GET') return Response.json({ id: one[1], engine: 'core' })
      return Response.json({ error: 'not found' }, { status: 404 })
    },
    websocket: {
      open: (ws) => {
        ws.subscribe('events')
      },
      message() {},
    },
  })
  stops.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, server, made }
}

async function boot(coreUrl: string): Promise<DeskServer> {
  const plugins = tempDir('desk-plugins-')
  writeFileSync(join(plugins, '19-core.ts'), `export { default } from '${PLUGIN}'`)
  writeFileSync(join(plugins, '20-engine.ts'), ENGINE)
  const desk = await createServer({ port: 0, home: tempDir('desk-home-'), pluginsDir: plugins, deps: { coreUrl, launchCore: () => {} } })
  stops.push(() => desk.stop())
  return desk
}

async function until(ok: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await ok()) return
    await Bun.sleep(25)
  }
  throw new Error('timed out')
}

const turnOn = (desk: DeskServer) =>
  fetch(`${desk.url}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ coreEngine: true }) })
const post = (desk: DeskServer) =>
  fetch(`${desk.url}/api/chats`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: 'C:/Users/me/b' }) })
const ids = async (res: Response) => ((await res.json()) as { id: string }[]).map((c) => c.id)

describe('the new core behind the window', () => {
  test('off, a new chat is the engine\'s; on, it is the core\'s, and its routes go there', async () => {
    const core = fakeCore()
    const desk = await boot(core.url)
    await until(async () => (await ids(await fetch(`${desk.url}/api/chats`))).includes('core-1'))

    expect(((await (await post(desk)).json()) as { engine?: string }).engine).toBe('desk')
    expect((await turnOn(desk)).status).toBe(200)
    const made = (await (await post(desk)).json()) as { id: string }
    expect(core.made).toEqual([made.id])

    expect(await ids(await fetch(`${desk.url}/api/chats`))).toEqual(['desk-1', 'core-1', made.id])
    expect(await (await fetch(`${desk.url}/api/chats/${made.id}`)).json()).toEqual({ id: made.id, engine: 'core' })
    expect(await (await fetch(`${desk.url}/api/chats/desk-1`)).json()).toEqual({ id: 'desk-1', engine: 'desk' })
    const lacking = await fetch(`${desk.url}/api/chats/${made.id}/fork`, { method: 'POST' })
    expect([lacking.status, ((await lacking.json()) as { error: string }).error]).toEqual([501, 'This chat runs on the new core, which does not do that yet.'])
    expect(await (await fetch(`${desk.url}/api/chats/${made.id}/commands`)).json()).toEqual([])
  })

  test("the window's hello holds both engines' chats, and the core's events reach it", async () => {
    const core = fakeCore()
    const desk = await boot(core.url)
    await until(() => core.server.subscriberCount('events') > 0)
    await until(async () => (await ids(await fetch(`${desk.url}/api/chats`))).includes('core-1'))

    const got: ServerEvent[] = []
    const ws = new WebSocket(`${desk.url.replace(/^http/, 'ws')}/ws`)
    stops.push(() => ws.close())
    ws.onmessage = (m) => got.push(JSON.parse(String(m.data)) as ServerEvent)
    await until(() => got.some((e) => e.type === 'hello'))
    const hello = got.find((e) => e.type === 'hello') as Extract<ServerEvent, { type: 'hello' }>
    expect(hello.chats?.map((c) => c.id)).toEqual(['desk-1', 'core-1'])

    // Sent first: the socket keeps order, so by the time chat.removed is here, a relayed external.update would be too.
    core.server.publish('events', JSON.stringify({ type: 'external.update', sessions: [] }))
    core.server.publish('events', JSON.stringify({ type: 'chat.removed', chatId: 'core-1' }))
    await until(() => got.some((e) => e.type === 'chat.removed'))
    expect(got.some((e) => e.type === 'external.update')).toBe(false)
    expect(await ids(await fetch(`${desk.url}/api/chats`))).toEqual(['desk-1'])
  })
})
