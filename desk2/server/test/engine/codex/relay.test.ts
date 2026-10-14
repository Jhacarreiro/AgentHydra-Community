// Another PC's Codex, reached through AgentHydra's Codex hub: its app-server is a WebSocket to the daemon's
// /api/codex-relay/<pc>/app-server, carrying the same JSON-RPC lines a local `codex app-server` reads and writes. It
// continues that PC's own chats only: a new thread never starts on it. A stand-in daemon answers here.

import { afterAll, expect, test } from 'bun:test'
import type { AhCodexInstance } from '../../../src/bridge/client'
import { type CodexDirectory, codexDirectory, pickCodexAccount } from '../../../src/engine/codex/accounts'
import { openAppServer, relayHome } from '../../../src/engine/codex/app-server'

const seen: { path: string; auth: string | null }[] = []
const daemon = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    seen.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization') })
    return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
  },
  websocket: {
    message(ws, raw) {
      const msg = JSON.parse(String(raw)) as { id?: number; method?: string; params?: Record<string, unknown> }
      if (msg.method === 'thread/resume') return ws.close(4000, 'Codex stopped on the PC.')
      if (msg.id !== undefined) ws.send(JSON.stringify({ id: msg.id, result: { method: msg.method, params: msg.params ?? null } }))
    },
  },
})
const env = { url: process.env.HYDRA_URL, token: process.env.AGENTHYDRA_CODEX_HUB_TOKEN }
process.env.HYDRA_URL = `http://127.0.0.1:${daemon.port}`
process.env.AGENTHYDRA_CODEX_HUB_TOKEN = 'relay-token'
afterAll(() => {
  daemon.stop(true)
  for (const [k, v] of [
    ['HYDRA_URL', env.url],
    ['AGENTHYDRA_CODEX_HUB_TOKEN', env.token],
  ] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

test("a relay app-server talks to the daemon's relay for that PC with the hub token, and a closed relay says why", async () => {
  const server = await openAppServer(relayHome('hub:desk-pc'))
  expect(seen.at(-1)).toEqual({ path: '/api/codex-relay/desk-pc/app-server', auth: 'Bearer relay-token' })
  expect(await server.call<{ method: string; params: unknown }>('thread/read', { threadId: 't' })).toEqual({ method: 'thread/read', params: { threadId: 't' } })

  const exited = Promise.withResolvers<string>()
  server.listen('t', { notify: () => {}, request: async () => null, exited: exited.resolve })
  await expect(server.call('thread/resume', { threadId: 't' })).rejects.toThrow(/Codex stopped on the PC/)
  expect(await exited.promise).toMatch(/Codex stopped on the PC/)
  server.release()
})

test("another PC's Codex is listed for its own chats, and a new thread never starts there", async () => {
  const own: AhCodexInstance[] = [{ id: 'codex-1', name: 'here', codexHome: '/h', loggedIn: true }]
  const dir: CodexDirectory = codexDirectory({
    codexInstances: async () => own,
    codexUsage: async () => ({ snapshot: { session: { pct: 100, resetsAt: new Date(Date.now() + 3_600_000).toISOString() } } }),
    codexRelayPcs: async () => [{ id: 'hub:desk-pc', pc: 'Desk-PC', pushedAt: '', chats: 3, relay: true }],
  })
  const listed = await dir.instances()
  expect(listed.find((i) => i.id === 'hub:desk-pc')).toMatchObject({ name: 'Desk-PC', loggedIn: true, relay: true, codexHome: relayHome('hub:desk-pc') })
  // The only account a new thread could take is full: the PC is still not picked.
  const pick = await pickCodexAccount(dir, new Set(), new Map(), Date.now())
  expect(pick).toEqual({ why: expect.stringMatching(/usage limit/) })
})
