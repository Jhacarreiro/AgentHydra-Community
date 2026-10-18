// Desk's stop route for a Claude Desktop chat: it forwards to the daemon's native stop, answers 200 { ok: true }
// only on a verified stop, and otherwise a non-2xx with the reason. The daemon is a stub; nothing is typed or retried.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer, type DeskServer } from '../../src/index'
import { deadUrl } from '../bridge/fake-hydra'

const PLUGIN = join(import.meta.dir, '..', '..', 'src', 'plugins', '10-bridge.ts')
const CHAT = '0b6f2b0e-1111-4c4c-9a9a-123456789abc'
const temps: string[] = []
const servers: DeskServer[] = []
const stubs: { stop: (force: boolean) => void }[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const s of stubs.splice(0)) s.stop(true)
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A stand-in daemon: each stop it is asked answers `answer`, and every request it gets is recorded. */
function stubDaemon(answer: () => { status: number; body: unknown }) {
  const seen: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      seen.push(`${req.method} ${path}`)
      if (req.method !== 'POST') return Response.json({ error: 'not here' }, { status: 404 })
      const a = answer()
      return Response.json(a.body, { status: a.status })
    },
  })
  stubs.push(server)
  return { url: `http://127.0.0.1:${server.port}`, seen }
}

/** A desk server whose only plugin is the bridge, pointed at hydraUrl. */
async function boot(hydraUrl: string): Promise<DeskServer> {
  const home = mkdtempSync(join(tmpdir(), 'desk-stop-home-'))
  const plugins = mkdtempSync(join(tmpdir(), 'desk-stop-plugins-'))
  temps.push(home, plugins)
  writeFileSync(join(plugins, '10-bridge.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  process.env.HYDRA_DESK_HOME = home
  const desk = await createServer({ port: 0, home, pluginsDir: plugins, deps: { hydraUrl, bridgePollMs: 50 } })
  servers.push(desk)
  return desk
}

const stopOf = (desk: DeskServer, id = CHAT) => fetch(`${desk.url}/api/external/sessions/${id}/stop`, { method: 'POST' })

test('a verified stop answers 200 { ok: true }, and the daemon is asked once for that chat', async () => {
  const daemon = stubDaemon(() => ({ status: 200, body: { ok: true, route: 'native', verified: true } }))
  const desk = await boot(daemon.url)
  const res = await stopOf(desk)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(daemon.seen.filter((s) => s.includes('/stop'))).toEqual([`POST /api/sessions/${CHAT}/stop`])
})

test('a stop the daemon refuses answers its status with the plain reason', async () => {
  const daemon = stubDaemon(() => ({ status: 409, body: { ok: false, error: 'the chat has no running turn to stop' } }))
  const desk = await boot(daemon.url)
  const res = await stopOf(desk)
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ error: 'the chat has no running turn to stop' })
  expect(daemon.seen.filter((s) => s.includes('/stop'))).toHaveLength(1)
})

test('a stop the app does not confirm is never a 200, and an unreachable daemon says so plainly', async () => {
  const unconfirmed = stubDaemon(() => ({ status: 200, body: { ok: true, verified: false } }))
  const desk = await boot(unconfirmed.url)
  const res = await stopOf(desk)
  expect(res.status).toBe(422)
  expect(await res.json()).toEqual({ error: `AgentHydra did not stop ${CHAT}` })

  const down = await boot(deadUrl())
  const gone = await stopOf(down)
  expect(gone.status).toBe(503)
  expect(String((await gone.json()).error)).toContain('AgentHydra is not running')
})
