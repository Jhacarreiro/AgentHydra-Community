// server/tests/codex-hub-names.test.ts — two PCs that send the Codex hub one name.
//
// The hub keeps a PC by the name it sends, and two can send one: WSL beside the Windows PC it runs on, two Linux
// boxes called `ubuntu`, the daemon's pusher beside a standalone one. Each pusher sends an install id it made once,
// and the hub keeps the name for the install that holds it: another one's push is refused with 409 and its relay
// socket closed with 4409, instead of the two replacing each other's relay socket and rollouts.
import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import {
  acceptCodexHubPush,
  CODEX_HUB_DIR,
  hubPcKey,
  readCodexHubManifest,
} from '../src/core/codex-hub'
import {
  type CodexHubPushConfig,
  codexHubPushConfig,
  pushCodexHubOnce,
  pusherInstallId,
} from '../src/core/codex-hub-push'
import { relayPcInstall, relayPcs } from '../src/core/codex-hub-relay'
import { type CodexHubRelay, startCodexHubRelay } from '../src/core/codex-hub-relay-pc'
import type { CodexRpc } from '../src/core/codex-rpc'
import { app } from '../src/http-app'
import '../src/routes/codex-hub'

// A copy with its own router: a request through the shared app would build its matcher and stop
// every later test file from registering routes.
const http = new Hono().route('/', app)

const TOKEN = 'test-names-token'
const previousToken = process.env.AGENTHYDRA_CODEX_HUB_TOKEN
process.env.AGENTHYDRA_CODEX_HUB_TOKEN = TOKEN
const scratch = join(process.env.AGENTHYDRA_HOME!, `hub-names-${crypto.randomUUID().slice(0, 6)}`)
let server: ReturnType<typeof Bun.serve>
const relays: CodexHubRelay[] = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req, srv) => http.fetch(req, srv),
    websocket,
  })
})

afterAll(() => {
  for (const relay of relays) relay.stop()
  server?.stop(true)
  rmSync(scratch, { recursive: true, force: true })
  if (previousToken === undefined) delete process.env.AGENTHYDRA_CODEX_HUB_TOKEN
  else process.env.AGENTHYDRA_CODEX_HUB_TOKEN = previousToken
})

async function until(ok: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(20)
  }
}

const A = 'install-a-0123456789'
const B = 'install-b-0123456789'
const rolloutPath = (id: string) => `sessions/2026/10/14/rollout-2026-10-14T10-00-00-${id}.jsonl`
const gz = (data: string) => Buffer.from(Bun.gzipSync(data)).toString('base64')
/** One PC's push of one chat, with its rollout. */
const pushOf = (pc: string, chat: string) => ({
  pc,
  threads: [{ id: chat, name: chat, updatedAt: 1_791_900_000, path: rolloutPath(chat) }],
  files: [{ path: rolloutPath(chat), updatedAt: 1_791_900_000, gz: gz(`{"${chat}":1}\n`) }],
})
const hubRoot = () => join(scratch, `root-${crypto.randomUUID().slice(0, 6)}`)

test('each pusher makes its install id once and keeps it; the daemon and a standalone pusher keep two', () => {
  const file = join(scratch, 'pc', 'codex-hub-install')
  const id = pusherInstallId(file)
  expect(id).toMatch(/^[0-9a-f-]{36}$/)
  expect(pusherInstallId(file)).toBe(id)
  expect(readFileSync(file, 'utf8').trim()).toBe(id!)
  expect(pusherInstallId(join(scratch, 'other-pc', 'codex-hub-install'))).not.toBe(id)
  // A file that cannot be made: no id, which the hub takes as it took the first pushers.
  writeFileSync(join(scratch, 'a-file'), '')
  expect(pusherInstallId(join(scratch, 'a-file', 'codex-hub-install'))).toBeNull()

  const saved = process.env.AGENTHYDRA_CODEX_HUB_URL
  try {
    process.env.AGENTHYDRA_CODEX_HUB_URL = 'https://hub.example.test'
    const daemon = codexHubPushConfig()?.install
    const standalone = codexHubPushConfig('standalone')?.install
    expect(daemon).toBeTruthy()
    expect(standalone).toBeTruthy()
    expect(standalone).not.toBe(daemon)
    expect(codexHubPushConfig()?.install).toBe(daemon)
  } finally {
    if (saved === undefined) delete process.env.AGENTHYDRA_CODEX_HUB_URL
    else process.env.AGENTHYDRA_CODEX_HUB_URL = saved
  }
})

test("another install's push under a name that is held is refused with 409, and the first PC's copy is left alone", () => {
  const root = hubRoot()
  const dir = join(root, 'same-pc')
  expect(acceptCodexHubPush(pushOf('Same-PC', 'first'), root, undefined, A)).toMatchObject({
    ok: true,
  })
  const manifest = readFileSync(join(dir, 'manifest.json'), 'utf8')
  expect(JSON.parse(manifest).install).toBe(A)

  // Its name normalizes to the same folder, as `ubuntu` and `Ubuntu.local` would.
  const refused = acceptCodexHubPush(pushOf('same pc', 'second'), root, undefined, B)
  // A name of its own is for another machine: two pushers on one PC push the same chats, and one is to stop.
  expect(refused).toEqual({
    ok: false,
    status: 409,
    error: expect.stringMatching(
      /^another PC already pushes as same pc; set AGENTHYDRA_CODEX_HUB_PC .+; if both pushers run on this PC, stop one/,
    ),
  })
  expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe(manifest)
  expect(existsSync(join(dir, ...rolloutPath('first').split('/')))).toBe(true)
  expect(existsSync(join(dir, ...rolloutPath('second').split('/')))).toBe(false)

  // The install that holds it goes on pushing.
  expect(acceptCodexHubPush(pushOf('Same-PC', 'first'), root, undefined, A)).toMatchObject({
    ok: true,
  })
})

test('an install that stopped pushing leaves its name to the next after ten minutes', () => {
  const root = hubRoot()
  const file = join(root, 'same-pc', 'manifest.json')
  acceptCodexHubPush(pushOf('Same-PC', 'old'), root, undefined, A)
  expect(acceptCodexHubPush(pushOf('Same-PC', 'new'), root, undefined, B)).toMatchObject({
    status: 409,
  })
  // Its last push, eleven minutes ago: a PC set up again, with a new id.
  const old = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(
    file,
    JSON.stringify({ ...old, pushedAt: new Date(Date.now() - 11 * 60_000).toISOString() }),
  )
  expect(acceptCodexHubPush(pushOf('Same-PC', 'new'), root, undefined, B)).toMatchObject({
    ok: true,
  })
  expect(JSON.parse(readFileSync(file, 'utf8')).install).toBe(B)
  expect(acceptCodexHubPush(pushOf('Same-PC', 'old'), root, undefined, A)).toMatchObject({
    status: 409,
  })
})

test('a pusher that pushes every half hour with its relay off keeps its name between pushes', () => {
  const root = hubRoot()
  const dir = join(root, 'same-pc')
  const every = 30 * 60_000
  const start = Date.now()
  const at = (min: number) => setSystemTime(new Date(start + min * 60_000))
  const push = (chat: string, install: string) =>
    acceptCodexHubPush({ ...pushOf('Same-PC', chat), intervalMs: every }, root, undefined, install)
  try {
    // The other PC starts eleven minutes later, on the same cadence, and is refused at each push of its own.
    for (const min of [0, 30, 60]) {
      at(min)
      expect(push('a', A)).toMatchObject({ ok: true })
      at(min + 11)
      expect(push('b', B)).toMatchObject({ status: 409 })
    }
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))).toMatchObject({
      install: A,
      intervalMs: every,
    })
    expect(existsSync(join(dir, ...rolloutPath('a').split('/')))).toBe(true)

    // The first stops: its name is held for three of its intervals after its last push, then passes on.
    at(60 + 89)
    expect(push('b', B)).toMatchObject({ status: 409 })
    at(60 + 91)
    expect(push('b', B)).toMatchObject({ ok: true })
  } finally {
    setSystemTime()
  }
})

test('the hold follows a sane interval only: a pusher waits at most eight hours, the hub holds at most a day', () => {
  const root = hubRoot()
  const start = Date.now()
  const saved = {
    url: process.env.AGENTHYDRA_CODEX_HUB_URL,
    min: process.env.AGENTHYDRA_CODEX_HUB_INTERVAL_MIN,
  }
  const push = (pc: string, chat: string, install: string, intervalMs?: unknown) =>
    acceptCodexHubPush({ ...pushOf(pc, chat), intervalMs }, root, undefined, install)
  try {
    process.env.AGENTHYDRA_CODEX_HUB_URL = 'https://hub.example.test'
    process.env.AGENTHYDRA_CODEX_HUB_INTERVAL_MIN = String(7 * 24 * 60)
    expect(codexHubPushConfig()?.intervalMs).toBe(8 * 60 * 60_000)

    // A push that claims a week is held for a day; one whose interval is not a number, as one that sent none.
    push('Week-PC', 'a', A, 7 * 24 * 60 * 60_000)
    push('Odd-PC', 'a', A, 'often')
    expect(
      JSON.parse(readFileSync(join(root, 'odd-pc', 'manifest.json'), 'utf8')).intervalMs,
    ).toBeUndefined()
    setSystemTime(new Date(start + 11 * 60_000))
    expect(push('Odd-PC', 'b', B)).toMatchObject({ ok: true })
    setSystemTime(new Date(start + 23 * 60 * 60_000))
    expect(push('Week-PC', 'b', B)).toMatchObject({ status: 409 })
    setSystemTime(new Date(start + 25 * 60 * 60_000))
    expect(push('Week-PC', 'b', B)).toMatchObject({ ok: true })
  } finally {
    setSystemTime()
    for (const [name, value] of [
      ['AGENTHYDRA_CODEX_HUB_URL', saved.url],
      ['AGENTHYDRA_CODEX_HUB_INTERVAL_MIN', saved.min],
    ] as const)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
  }
})

test('a pusher that sends no id is taken as before, and holds its name against no one', () => {
  const root = hubRoot()
  acceptCodexHubPush(pushOf('Same-PC', 'first'), root, undefined, A)
  expect(acceptCodexHubPush(pushOf('Same-PC', 'older'), root)).toMatchObject({ ok: true })
  expect(JSON.parse(readFileSync(join(root, 'same-pc', 'manifest.json'), 'utf8')).install).toBe(
    undefined,
  )
  expect(acceptCodexHubPush(pushOf('Same-PC', 'second'), root, undefined, B)).toMatchObject({
    ok: true,
  })
})

test('the relay keeps the PC that holds a name; the other is closed with 4409, says why and waits', async () => {
  const pc = `Twin-PC-${crypto.randomUUID().slice(0, 6)}`
  const key = hubPcKey(pc)!
  const cfg = (install: string | null): CodexHubPushConfig => ({
    url: `http://127.0.0.1:${server.port}`,
    token: TOKEN,
    pc,
    install,
    headers: {},
    intervalMs: 60_000,
  })
  /** One PC's relay, counting its connects and how each closed. */
  const relayOf = (install: string | null) => {
    const seen = { dials: 0, closes: [] as number[] }
    const relay = startCodexHubRelay(cfg(install), {
      spawnAppServer: async () => {
        throw new Error('no app-server in this test')
      },
      codexHome: '/nowhere',
      mode: 'ask',
      retryMs: { min: 20, max: 60_000 },
      connect: (url, headers) => {
        seen.dials++
        const ws = new WebSocket(url, { headers } as unknown as string[])
        ws.addEventListener('close', (e) => seen.closes.push(e.code))
        return ws
      },
    })!
    relays.push(relay)
    return Object.assign(seen, { stop: () => relay.stop() })
  }
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const first = relayOf(A)
    await until(() => relayPcInstall(key) === A)

    const second = relayOf(B)
    await until(() => second.closes.length === 1)
    expect(second.closes).toEqual([4409])
    expect(errors.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(
      `another PC already pushes as ${pc}; set AGENTHYDRA_CODEX_HUB_PC`,
    )
    // It tries again only after the longest wait, not 20 ms on, when it would replace the first again.
    await Bun.sleep(300)
    expect(second.dials).toBe(1)
    expect([first.dials, first.closes]).toEqual([1, []])
    expect(relayPcInstall(key)).toBe(A)

    // Its push is refused too, while the first PC's relay is open, before it has pushed at all.
    const rpc = async (): Promise<CodexRpc> => ({
      call: async <T>() => ({ data: [], nextCursor: null }) as T,
      close: () => undefined,
    })
    const toHub: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      http.fetch(new Request(String(input), init))) as typeof fetch
    await expect(
      pushCodexHubOnce(cfg(B), { connect: rpc, fetch: toHub, codexHome: scratch }),
    ).rejects.toThrow(`another PC already pushes as ${pc}; set AGENTHYDRA_CODEX_HUB_PC`)
    expect(
      await pushCodexHubOnce(cfg(A), { connect: rpc, fetch: toHub, codexHome: scratch }),
    ).toEqual({ threads: 0, sent: 0, missing: 0 })
    // It sends its interval, which the hub's hold on its name follows.
    expect(readCodexHubManifest(join(CODEX_HUB_DIR, key))).toMatchObject({
      install: A,
      intervalMs: 60_000,
    })

    // A pusher from before install ids is let in as before, though the first PC's push holds the name.
    first.stop()
    await until(() => !relayPcs().has(key))
    const older = relayOf(null)
    await until(() => relayPcs().has(key) && relayPcInstall(key) === null)
    expect(older.closes).toEqual([])
  } finally {
    errors.mockRestore()
    rmSync(join(CODEX_HUB_DIR, key), { recursive: true, force: true })
  }
})
