// ReDesign is a third-party app: while the person has not turned it on, Desk's ReDesign routes (plugins/66-redesign.ts,
// the keys copy, and /mcp/redesign in plugins/68-mcp.ts) answer that it is off and call nothing. A fake def stands in
// for ReDesign; the data home is a temp folder.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConnectorDef } from '../../src/connectors/types'
import { createServer, type DeskServer } from '../../src/index'

const PLUGINS = ['57-connectors.ts', '66-redesign.ts', '68-mcp.ts']
const temps: string[] = []
const stops: (() => unknown)[] = []
const KEYS = ['HYDRA_DESK_HOME', 'REDESIGN_HOME', 'REDESIGN_URL', 'PORT'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

const temp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p))
  temps.push(d)
  return d
}

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

async function desk(): Promise<DeskServer> {
  const home = temp('rd-off-home-')
  process.env.HYDRA_DESK_HOME = home
  // Nothing on this machine may answer as ReDesign: no runtime file, and the fallback port is one nothing listens on.
  process.env.REDESIGN_HOME = temp('rd-off-state-')
  process.env.REDESIGN_URL = 'http://127.0.0.1:1'
  process.env.PORT = '1'
  const plugins = temp('rd-off-plugins-')
  for (const name of PLUGINS) {
    const file = join(import.meta.dir, '..', '..', 'src', 'plugins', name)
    writeFileSync(join(plugins, name), `export { default } from ${JSON.stringify(pathToFileURL(file).href)}\n`)
  }
  const def: ConnectorDef = {
    info: { id: 'redesign', name: 'ReDesign', blurb: 'x', homepage: 'https://example.com', installable: false, pane: true, thirdParty: true },
    detect: async () => ({ state: 'running', url: 'http://127.0.0.1:1', version: '1.0.0' })
  }
  const server = await createServer({ port: 0, home, pluginsDir: plugins, deps: { connectors: [def] } })
  stops.push(() => server.stop())
  return server
}

const keys = (server: DeskServer) => fetch(`http://127.0.0.1:${server.port}/api/redesign/keys/hswarm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
const mcp = (server: DeskServer) =>
  fetch(`http://127.0.0.1:${server.port}/mcp/redesign?url=${encodeURIComponent('http://127.0.0.1:1')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  })

test('while it is off, no key is copied to it and its MCP route answers nothing', async () => {
  const server = await desk()
  const k = await keys(server)
  expect(k.status).toBe(409)
  expect(((await k.json()) as { error: string }).error).toBe('ReDesign is off in Settings → Connectors')
  const m = await mcp(server)
  expect(m.status).toBe(409)
  expect(((await m.json()) as { error: string }).error).toContain('off in Settings')
})

test('once the person turns it on, the routes go on to look for it', async () => {
  const server = await desk()
  const on = await fetch(`http://127.0.0.1:${server.port}/api/connectors/redesign/enable`, { method: 'POST' })
  expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true)
  const k = await keys(server)
  expect(k.status).toBe(409)
  expect(((await k.json()) as { error: string }).error).toBe('ReDesign is not running')
  expect((await mcp(server)).status).not.toBe(409)
})
