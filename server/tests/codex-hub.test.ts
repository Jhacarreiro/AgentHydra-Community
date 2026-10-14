// server/tests/codex-hub.test.ts — another PC's Codex chats, pushed through POST /api/codex-hub/push.
//
// A PC's chats exist only on that PC. The PC side lists them through its app-server (stood in for here
// by an rpc that answers thread/list) and pushes the list plus each rollout the hub asks for; the hub
// keeps a Codex home per PC that the chat list and transcript index read like a local one.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { listCodexChats } from '../src/core/codex-chat-list'
import { acceptCodexHubPush, CODEX_HUB_DIR, hubPcKey } from '../src/core/codex-hub'
import { type CodexHubPushConfig, pushCodexHubOnce } from '../src/core/codex-hub-push'
import type { CodexRpc } from '../src/core/codex-rpc'
import { app } from '../src/http-app'
import '../src/routes/codex-hub'

// A copy with its own router: a request through the shared app would build its matcher and stop
// every later test file from registering routes.
const http = new Hono().route('/', app)

const TOKEN = 'test-hub-token'
process.env.AGENTHYDRA_CODEX_HUB_TOKEN = TOKEN
const PC = `Desk-PC-${crypto.randomUUID().slice(0, 6)}`
const PC_DIR = join(CODEX_HUB_DIR, hubPcKey(PC)!)
const PC_HOME = join(process.env.AGENTHYDRA_HOME!, `pc-codex-${crypto.randomUUID().slice(0, 6)}`)

afterAll(() => {
  rmSync(PC_DIR, { recursive: true, force: true })
  rmSync(PC_HOME, { recursive: true, force: true })
})

/** A rollout on the "PC", at the path a Windows app-server would report for it. */
function rollout(id: string, text: string): string {
  const rel = `sessions/2026/10/14/rollout-2026-10-14T10-00-00-${id}.jsonl`
  const file = join(PC_HOME, ...rel.split('/'))
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
  return `C:\\Users\\me\\.codex\\${rel.replaceAll('/', '\\')}`
}

const named = crypto.randomUUID()
const untitled = crypto.randomUUID()
const exec = crypto.randomUUID()
let listed: Record<string, unknown>[] = [
  {
    id: named,
    name: 'Fix the build',
    preview: 'first message',
    cwd: 'C:/Users/me/app',
    path: rollout(named, '{"a":1}\n'),
    updatedAt: 1_791_900_000,
    source: 'vscode',
  },
  {
    id: untitled,
    name: null,
    preview: 'Second chat\nmore',
    cwd: 'C:/Users/me/app',
    path: rollout(untitled, '{"b":2}\n'),
    updatedAt: 1_791_800_000,
    source: 'cli',
  },
  {
    id: exec,
    name: null,
    preview: 'scripted',
    cwd: 'C:/Users/me/app',
    path: rollout(exec, '{"c":3}\n'),
    updatedAt: 1_791_700_000,
    source: 'exec',
  },
]

const fakeRpc = async (): Promise<CodexRpc> => ({
  call: async <T>(method: string) => {
    if (method !== 'thread/list') throw new Error(`unexpected ${method}`)
    return { data: listed, nextCursor: null } as T
  },
  close: () => undefined,
})
const toHub: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) =>
  http.fetch(new Request(String(input), init))) as typeof fetch
const cfg: CodexHubPushConfig = {
  url: 'http://127.0.0.1',
  token: TOKEN,
  pc: PC,
  headers: {},
  intervalMs: 60_000,
}
const push = () => pushCodexHubOnce(cfg, { connect: fakeRpc, fetch: toHub, codexHome: PC_HOME })
const hubChats = () => listCodexChats().filter((c) => c.fromPc === PC)

test('a PC pushes its chats; the hub lists them under the PC with the titles its Codex app shows', async () => {
  const outcome = await push()
  expect(outcome).toEqual({ threads: 3, sent: 3, missing: 0 })

  const chats = hubChats()
  expect(chats.map((c) => [c.threadId, c.title])).toEqual([
    [named, 'Fix the build'],
    [untitled, 'Second chat'],
  ])
  expect(chats[0]!.instance).toBe(PC)
  expect(chats[0]!.instanceId).toBe(`hub:${hubPcKey(PC)}`)

  const copy = join(
    PC_DIR,
    'sessions',
    '2026',
    '10',
    '14',
    `rollout-2026-10-14T10-00-00-${named}.jsonl`,
  )
  expect(readFileSync(copy, 'utf8')).toBe('{"a":1}\n')
  expect(readFileSync(join(PC_DIR, 'session_index.jsonl'), 'utf8')).toContain(
    '"thread_name":"Fix the build"',
  )
})

test('the next round sends only what changed, and a chat gone from the PC leaves the hub', async () => {
  listed = listed
    .filter((t) => t.id !== untitled)
    .map((t) =>
      t.id === named ? { ...t, updatedAt: 1_792_000_000, path: rollout(named, '{"a":2}\n') } : t,
    )
  const outcome = await push()
  expect(outcome).toEqual({ threads: 2, sent: 1, missing: 0 })

  expect(hubChats().map((c) => c.threadId)).toEqual([named])
  expect(
    existsSync(
      join(PC_DIR, 'sessions', '2026', '10', '14', `rollout-2026-10-14T10-00-00-${untitled}.jsonl`),
    ),
  ).toBe(false)
  const copy = join(
    PC_DIR,
    'sessions',
    '2026',
    '10',
    '14',
    `rollout-2026-10-14T10-00-00-${named}.jsonl`,
  )
  expect(readFileSync(copy, 'utf8')).toBe('{"a":2}\n')
})

test('a push without the hub token is refused', async () => {
  const res = await http.fetch(
    new Request('http://127.0.0.1/api/codex-hub/push', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ pc: PC, threads: [] }),
    }),
  )
  expect(res.status).toBe(401)
})

test('a file path that leaves sessions/ is never written', () => {
  const root = join(process.env.AGENTHYDRA_HOME!, `hub-${crypto.randomUUID().slice(0, 6)}`)
  const gz = Buffer.from(Bun.gzipSync(new TextEncoder().encode('x'))).toString('base64')
  const result = acceptCodexHubPush(
    {
      pc: 'evil',
      threads: [],
      files: [
        { path: 'sessions/../../outside.jsonl', updatedAt: 1, gz },
        { path: '/etc/sessions/x.txt', updatedAt: 1, gz },
      ],
    },
    root,
  )
  expect(result).toMatchObject({ ok: true, stored: 0 })
  expect(existsSync(join(root, 'outside.jsonl'))).toBe(false)
  expect(existsSync(join(root, '..', 'outside.jsonl'))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})
