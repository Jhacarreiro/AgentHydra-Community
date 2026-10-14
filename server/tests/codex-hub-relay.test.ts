// server/tests/codex-hub-relay.test.ts — continuing another PC's Codex chat through the hub's relay.
//
// The PC keeps a socket open to the hub (core/codex-hub-relay-pc.ts); Desk opens an app-server "on" that PC through
// /api/codex-relay/<pc>/app-server and the hub carries the JSON-RPC lines between them (core/codex-hub-relay.ts).
// Here the PC's `codex app-server` is a stand-in that answers in memory, and Desk is a bare WebSocket.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import type { CodexHubPushConfig } from '../src/core/codex-hub-push'
import { relayPcs } from '../src/core/codex-hub-relay'
import {
  type AppServerProcess,
  type CodexHubRelay,
  startCodexHubRelay,
} from '../src/core/codex-hub-relay-pc'
import { app } from '../src/http-app'
import '../src/routes/codex-hub'

const TOKEN = 'test-relay-token'
const previousToken = process.env.AGENTHYDRA_CODEX_HUB_TOKEN
process.env.AGENTHYDRA_CODEX_HUB_TOKEN = TOKEN
const PC = `Relay-PC-${crypto.randomUUID().slice(0, 6)}`
const KEY = PC.toLowerCase()

// A copy with its own router: a request through the shared app would build its matcher and stop every later test
// file from registering routes.
const http = new Hono().route('/', app)
let server: ReturnType<typeof Bun.serve>
let relay: CodexHubRelay
/** Every line the stand-in app-server was sent, parsed. */
const codexGot: Record<string, unknown>[] = []
let turnsDone = 0

/** A `codex app-server` that answers initialize, thread/resume and thread/list, and asks for one approval on turn/start. */
async function fakeAppServer(): Promise<AppServerProcess> {
  let onLine: (line: string) => void = () => {}
  const emit = (msg: unknown) => queueMicrotask(() => onLine(JSON.stringify(msg)))
  return {
    write(line) {
      const msg = JSON.parse(line) as {
        id?: unknown
        method?: string
        params?: Record<string, unknown>
        result?: unknown
      }
      codexGot.push(msg)
      if (msg.method === 'initialize') emit({ id: msg.id, result: { userAgent: 'fake' } })
      else if (msg.method === 'thread/resume')
        emit({ id: msg.id, result: { thread: { id: msg.params?.threadId } } })
      else if (msg.method === 'thread/list')
        emit({ id: msg.id, result: { data: [{ id: 'listed' }], nextCursor: null } })
      else if (msg.method === 'turn/start') {
        emit({ id: msg.id, result: { turn: { id: 'turn-1' } } })
        emit({
          id: 900,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: msg.params?.threadId, command: 'ls' },
        })
      } else if (msg.id === 900 && 'result' in msg)
        emit({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        })
    },
    onLine: (f) => {
      onLine = f
    },
    onExit: () => {},
    end: () => {},
  }
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req, srv) => http.fetch(req, srv),
    websocket,
  })
  const cfg: CodexHubPushConfig = {
    url: `http://127.0.0.1:${server.port}`,
    token: TOKEN,
    pc: PC,
    headers: {},
    intervalMs: 60_000,
  }
  relay = startCodexHubRelay(cfg, {
    spawnAppServer: fakeAppServer,
    codexHome: '/nowhere',
    mode: 'ask',
    onTurnDone: () => turnsDone++,
  })!
  await until(() => relayPcs().has(KEY))
})

afterAll(() => {
  relay?.stop()
  server?.stop(true)
  if (previousToken === undefined) delete process.env.AGENTHYDRA_CODEX_HUB_TOKEN
  else process.env.AGENTHYDRA_CODEX_HUB_TOKEN = previousToken
})

async function until(ok: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(20)
  }
}

/** Desk's end: a socket to the PC's app-server, and every message it received. */
async function desk(
  token = TOKEN,
): Promise<{ ws: WebSocket; got: Record<string, unknown>[]; closed: Promise<string> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/codex-relay/${KEY}/app-server`, {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as string[])
  const got: Record<string, unknown>[] = []
  ws.addEventListener('message', (e) => got.push(JSON.parse(String(e.data))))
  const closed = new Promise<string>((resolve) =>
    ws.addEventListener('close', (e) => resolve(e.reason)),
  )
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('could not connect')))
  })
  return { ws, got, closed }
}

test('Desk drives the PC app-server through the hub: a turn, its approval asked and answered, and the push it triggers', async () => {
  const d = await desk()
  d.ws.send(
    JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'hydra_desk' } } }),
  )
  await until(() => d.got.some((m) => m.id === 1))
  d.ws.send(JSON.stringify({ method: 'initialized' }))
  d.ws.send(
    JSON.stringify({
      id: 2,
      method: 'thread/resume',
      params: { threadId: 'thread-1', approvalPolicy: 'on-request' },
    }),
  )
  d.ws.send(
    JSON.stringify({
      id: 3,
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [],
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'workspaceWrite' },
      },
    }),
  )
  await until(() => d.got.some((m) => m.method === 'item/commandExecution/requestApproval'))
  expect(d.got.find((m) => m.id === 2)).toMatchObject({ result: { thread: { id: 'thread-1' } } })
  expect(d.got.find((m) => m.id === 3)).toMatchObject({ result: { turn: { id: 'turn-1' } } })

  d.ws.send(JSON.stringify({ id: 900, result: { decision: 'accept' } }))
  await until(() => d.got.some((m) => m.method === 'turn/completed'))
  expect(codexGot.find((m) => m.id === 900)).toEqual({ id: 900, result: { decision: 'accept' } })
  expect(turnsDone).toBe(1)

  // The pusher lists chats through the app-server Desk holds; the answer never reaches Desk.
  const before = d.got.length
  const listed = await relay.localRpc()!.call<{ data: { id: string }[] }>('thread/list', {})
  expect(listed.data).toEqual([{ id: 'listed' }])
  await Bun.sleep(50)
  expect(d.got.length).toBe(before)
  d.ws.close()
})

test('the PC refuses what continuing a chat does not need, and a turn without approvals, before Codex sees it', async () => {
  const d = await desk()
  d.ws.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }))
  await until(() => d.got.some((m) => m.id === 1))
  d.ws.send(JSON.stringify({ method: 'initialized' }))
  const seen = codexGot.length
  d.ws.send(JSON.stringify({ id: 2, method: 'thread/start', params: {} }))
  d.ws.send(
    JSON.stringify({
      id: 3,
      method: 'turn/start',
      params: {
        threadId: 't',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    }),
  )
  d.ws.send(JSON.stringify({ id: 4, method: 'config/value/write', params: {} }))
  await until(() => [2, 3, 4].every((id) => d.got.some((m) => m.id === id)))
  expect((d.got.find((m) => m.id === 2)!.error as { message: string }).message).toMatch(
    /thread\/start/,
  )
  expect((d.got.find((m) => m.id === 3)!.error as { message: string }).message).toMatch(/approvals/)
  expect(codexGot.slice(seen).map((m) => m.method)).toEqual(['initialized'])
  d.ws.close()
})

test('Desk needs the hub token, and a PC that is not connected closes the socket with why', async () => {
  const refused = await fetch(`http://127.0.0.1:${server.port}/api/codex-relay/${KEY}/app-server`, {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    },
  })
  expect(refused.status).toBe(401)

  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/codex-relay/nobody/app-server`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  } as unknown as string[])
  const why = await new Promise<string>((resolve) =>
    ws.addEventListener('close', (e) => resolve(e.reason)),
  )
  expect(why).toMatch(/not connected/)
})

test('a session ends on both sides when the PC goes away', async () => {
  const d = await desk()
  d.ws.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }))
  await until(() => d.got.some((m) => m.id === 1))
  relay.stop()
  expect(await d.closed).toMatch(/offline|stopped|closed/i)
  await until(() => !relayPcs().has(KEY))
})
