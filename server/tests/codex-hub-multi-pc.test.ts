// server/tests/codex-hub-multi-pc.test.ts — PCs on one hub, through the daemon as a home server runs it.
//
// The other hub tests call the routes on the shared app. This one starts the daemon itself (codex-hub-daemon.ts: the
// real src/index.ts in a scratch HOME on a loopback port), so every request meets what stands in front of the routes
// there: the /api loopback guard, the body limit and Bun.serve's WebSocket upgrade. Each PC is paired through the
// hub's pairing page the way its tray pairs (codex-hub-tray/pair.go: a loopback listener the page's form posts a
// one-time code to, which the tray redeems with a token it made), pushes its own chat through pushCodexHubOnce from
// its own app-server (the recorded stand-in, tests/mocks), and keeps a relay socket open. The hub lists each chat
// under the PC it came from. A PC's token acts for that PC alone: a request naming another PC writes under its own,
// and a request without a token, with a wrong one, with one revoked or with the admin token is refused. The owner
// revokes and lists PCs with scripts/codex-hub-pcs.ts, run against the daemon as on the server. A hub restart keeps
// every PC token, a new admin token too; and the PCs that pushed with the one shared token of before move to tokens
// of their own while the migration window is open, and only then (src/core/codex-hub-pcs.ts).
//
// Not on Windows: the daemon starts its tray host there at boot, which a test must not do.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { type CodexHubPushConfig, pushCodexHubOnce } from '../src/core/codex-hub-push'
import { type CodexHubRelay, startCodexHubRelay } from '../src/core/codex-hub-relay-pc'
import { connectCodexRpc } from '../src/core/codex-rpc'
import { freePort, type HubDaemon, type HubSettings, startHub } from './codex-hub-daemon'
import { newPcToken } from './codex-hub-test-pc'

const ROOT = join(import.meta.dir, '..', '..')
const CLI = join(ROOT, 'scripts', 'codex-hub-pcs.ts')
const MOCK_AGENT = join(import.meta.dir, 'mocks', 'mock-agent.mjs')
const scratch = join(
  process.env.AGENTHYDRA_HOME!,
  `hub-multi-pc-${crypto.randomUUID().slice(0, 6)}`,
)
const HUB_HOME = join(scratch, 'hub-home')
/** The hub's copies and its store, under the scratch HOME's config dir (codex-hub.ts CODEX_HUB_DIR). */
const HUB_DIR = join(HUB_HOME, '.agenthydra', 'codex-hub')
// A daemon's boot and a pusher's app-server are real processes: a cold CI runner is far slower than a desktop.
const SLOW_MS = 60_000
/** What a pusher says when the hub refuses a token that is not a PC token, whatever it is (codex-hub-push.ts). */
const SHARED_REFUSED =
  /^the hub no longer takes the shared token: pair this PC with the Codex Hub app/
/** What it says for a token the hub no longer has: replaced at a re-pair, or forgotten. */
const UNKNOWN_TOKEN =
  "the hub does not know this PC's token (it was paired again elsewhere, or forgotten); pair it again"

const secret = () => randomBytes(24).toString('base64url')
const savedRecording = process.env.AGENTHYDRA_MOCK_RECORDING
const savedNoDelay = process.env.AGENTHYDRA_MOCK_NO_DELAY
/** Every secret the test handed out or was handed: none may appear in the hub's logs. */
const secrets = new Set<string>()

// --- the hub ------------------------------------------------------------------------------------

let hub: HubDaemon | null = null
let port = 0

async function restart(settings: HubSettings): Promise<void> {
  await hub?.stop()
  hub = await startHub(HUB_HOME, settings, port)
}

const hubUrl = () => hub!.url
const getJson = async <T>(path: string): Promise<T> =>
  (await (await fetch(`${hubUrl()}${path}`)).json()) as T

/** scripts/codex-hub-pcs.ts as the owner runs it on the server, with `admin` in its environment. */
const cli = (admin: string, ...args: string[]) => cliAt(hubUrl(), admin, ...args)

/** The same, against the hub at `hub`. */
async function cliAt(hub: string, admin: string, ...args: string[]) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !/^(AGENTHYDRA_|CCMANAGERUI_)CODEX_HUB_/.test(k)) env[k] = v
  const proc = Bun.spawn([process.execPath, CLI, ...args, '--hub', hub], {
    cwd: ROOT,
    env: { ...env, AGENTHYDRA_CODEX_HUB_TOKEN: admin },
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

// --- the PCs ------------------------------------------------------------------------------------

interface Pc {
  name: string
  key: string
  install: string
  /** Its CODEX_HOME. */
  home: string
  /** What its app-server answers (tests/mocks/mock-agent.mjs). */
  recording: string
  chat: { id: string; title: string }
}

/** A PC with one chat: its rollout in its own Codex home, and an app-server that lists it as its Codex app does. */
function pcWith(name: string, title: string, source: 'vscode' | 'cli'): Pc {
  const id = crypto.randomUUID()
  const home = join(scratch, name)
  const rollout = join(home, ...rolloutPath(id))
  mkdirSync(join(rollout, '..'), { recursive: true })
  writeFileSync(
    rollout,
    `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: `/work/${name}` } })}\n`,
  )
  const recording = join(scratch, `${name}.json`)
  writeFileSync(
    recording,
    JSON.stringify({
      agent: 'codex',
      mode: 'app-server',
      responses: {
        initialize: [{ result: { userAgent: 'codex_cli_rs/0.0.0-mock' } }],
        'thread/list': [
          {
            result: {
              data: [
                {
                  id,
                  name: title,
                  preview: title,
                  cwd: `/work/${name}`,
                  path: rollout,
                  updatedAt: 1_792_310_400,
                  source,
                },
              ],
              nextCursor: null,
            },
          },
        ],
      },
    }),
  )
  return {
    name,
    key: name.toLowerCase(),
    install: `install-${name.toLowerCase()}-0001`,
    home,
    recording,
    chat: { id, title },
  }
}

const rolloutPath = (id: string) => [
  'sessions',
  '2026',
  '10',
  '18',
  `rollout-2026-10-18T09-00-00-${id}.jsonl`,
]

const cfgOf = (
  pc: Pc,
  token: string,
  over: Partial<CodexHubPushConfig> = {},
): CodexHubPushConfig => ({
  url: hubUrl(),
  token,
  pc: pc.name,
  install: pc.install,
  headers: {},
  intervalMs: 120_000,
  ...over,
})

/** One push round from the PC, its chat list read from its own app-server process. */
function push(pc: Pc, token: string, over: Partial<CodexHubPushConfig> = {}) {
  return pushCodexHubOnce(cfgOf(pc, token, over), {
    codexHome: pc.home,
    connect: (home) => {
      // The stand-in reads which recording to play from its environment, which the spawn copies now.
      process.env.AGENTHYDRA_MOCK_RECORDING = pc.recording
      return connectCodexRpc(home, {
        command: [process.execPath, MOCK_AGENT, '--as', 'codex', 'app-server'],
        timeoutMs: 20_000,
      })
    },
  })
}

const fromHtml = (s: string) =>
  s.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
const fieldsOf = (form: string) => {
  const fields = new URLSearchParams()
  for (const m of form.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/g))
    fields.set(m[1]!, fromHtml(m[2]!))
  return fields
}
/** The page as the browser the tray opened gets it: a top-level navigation. */
const openPage = (query: URLSearchParams) =>
  fetch(`${hubUrl()}/codex-hub/pair?${query}`, {
    headers: {
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-dest': 'document',
    },
  })

/**
 * Pairs a PC as its tray does: a listener on a loopback port for the page's post, the hub's pairing page opened in
 * the browser with that port, a one-time state, the PC's name and the listener's end, and the page's form submitted
 * as a click on Connect submits it. A PC already on the hub is this PC set up again: `replace` takes the page's
 * second step, "replace its token", and then Connect and replace. The listener gets a code, never a token; the tray
 * makes its token and redeems the code with it from its install id. Answers the token the tray would save.
 */
async function pair(pc: Pc, opts: { replace?: boolean } = {}): Promise<string> {
  const state = randomBytes(16).toString('hex')
  const posted = Promise.withResolvers<URLSearchParams>()
  const tray = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/paired')
        return new Response('not here', { status: 404 })
      posted.resolve(new URLSearchParams(await req.text()))
      return new Response('This PC is connected.')
    },
  })
  try {
    const query = new URLSearchParams({
      port: String(tray.port),
      state,
      pc: pc.name,
      until: String(Math.floor(Date.now() / 1000) + 600),
    })
    let page = await openPage(query)
    expect(page.status).toBe(200)
    let html = await page.text()
    if (opts.replace) {
      expect(html).toContain(`${pc.name} is already on this hub`)
      const again = /<form method="get" action="">([\s\S]*?)<\/form>/.exec(html)?.[1]
      expect(again).toBeDefined()
      page = await openPage(fieldsOf(again!))
      expect(page.status).toBe(200)
      html = await page.text()
      expect(html).toContain(`<h1>Replace ${pc.name}&#39;s token</h1>`)
    }
    const form = /<form method="post" action="([^"]+)">([\s\S]*?)<\/form>/.exec(html)
    // The page posts to the tray's own port and nowhere else.
    expect(form?.[1]).toBe(`http://127.0.0.1:${tray.port}/paired`)
    expect(page.headers.get('content-security-policy')).toContain(
      `form-action 'self' ${form?.[1]};`,
    )
    expect(html).not.toContain('chp_')
    for (const s of secrets) expect(html).not.toContain(s)
    const sent = await fetch(form![1]!, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: hubUrl() },
      body: fieldsOf(form![2]!),
    })
    expect(sent.status).toBe(200)
    const got = await posted.promise
    expect(got.get('state')).toBe(state)
    expect(got.has('token')).toBe(false)
    const code = got.get('code') ?? ''
    expect(code).toMatch(/^[0-9a-f]{64}$/)
    secrets.add(code)

    const t = newPcToken()
    const res = await fetch(`${hubUrl()}/api/codex-hub/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-codex-hub-install': pc.install },
      body: JSON.stringify({ code, id: t.id, hash: t.hash }),
    })
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 200,
      body: { pc: pc.name, key: pc.key, id: t.id },
    })
    for (const s of [t.token, t.token.slice(21), t.hash]) secrets.add(s)
    return t.token
  } finally {
    tray.stop(true)
  }
}

const relays: CodexHubRelay[] = []
/** The PC's relay socket, as its pusher keeps it open; no app-server is started on it here. */
function relayOf(pc: Pc, token: string) {
  const closes: { code: number; reason: string }[] = []
  const relay = startCodexHubRelay(cfgOf(pc, token), {
    spawnAppServer: async () => {
      throw new Error('no app-server in this test')
    },
    codexHome: pc.home,
    mode: 'ask',
    retryMs: { min: 50, max: 60_000 },
    connect: (url, headers) => {
      const ws = new WebSocket(url, { headers } as unknown as string[])
      ws.addEventListener('close', (e) => closes.push({ code: e.code, reason: e.reason }))
      return ws
    },
  })!
  relays.push(relay)
  return { relay, closes }
}

/** Whether a WebSocket to path opens with these headers; one the hub refuses never does. */
function socketOpens(path: string, headers: Record<string, string>): Promise<boolean> {
  const ws = new WebSocket(`${hubUrl().replace(/^http/, 'ws')}${path}`, {
    headers,
  } as unknown as string[])
  return new Promise((resolve) => {
    ws.onopen = () => {
      ws.close()
      resolve(true)
    }
    ws.onerror = () => resolve(false)
    ws.onclose = () => resolve(false)
  })
}

const bearer = (token: string, install?: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  ...(install ? { 'x-codex-hub-install': install } : {}),
})
/** A build check, as a tray or a pusher makes it; the answer's status and code. */
async function buildCheck(token: string, install?: string) {
  const res = await fetch(`${hubUrl()}/api/codex-hub/pusher?platform=linux-x64`, {
    headers: bearer(token, install),
  })
  return { status: res.status, code: ((await res.json()) as { code?: string }).code }
}

interface RelayPc {
  id: string
  pc: string
  pushedAt: string
  chats: number
  relay: boolean
  state?: string
}
const relayPcs = () => getJson<RelayPc[]>('/api/codex-relay/pcs')
const relayOn = async (pc: string) => (await relayPcs()).find((p) => p.pc === pc)?.relay === true
const hubChats = async () =>
  (
    await getJson<{
      rows: { threadId: string; title: string; fromPc?: string; instanceId: string }[]
    }>('/api/codex-chats')
  ).rows
    .filter((r) => r.fromPc)
    .map((r) => ({ pc: r.fromPc, id: r.threadId, title: r.title, instance: r.instanceId }))
    .sort((a, b) => a.pc!.localeCompare(b.pc!))

async function until(ok: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

/** A folder of copies a PC pushed before PC tokens, put on the hub's disk while it is stopped. */
function seedFolder(key: string, m: { pc: string; install?: string; pushedAt: number }) {
  mkdirSync(join(HUB_DIR, key), { recursive: true })
  writeFileSync(
    join(HUB_DIR, key, 'manifest.json'),
    JSON.stringify({
      pc: m.pc,
      ...(m.install ? { install: m.install } : {}),
      pushedAt: new Date(m.pushedAt).toISOString(),
      threads: [],
      files: {},
    }),
  )
}

// --- the flow -----------------------------------------------------------------------------------

const office = pcWith('Office-PC', 'Fix the parser', 'vscode')
const laptop = pcWith('Laptop', 'Write the changelog', 'cli')
const firstAdmin = secret()
const secondAdmin = secret()
secrets.add(firstAdmin)
secrets.add(secondAdmin)
let officeToken = ''
let laptopToken = ''
let officeRelay: ReturnType<typeof relayOf> | null = null
let laptopRelay: ReturnType<typeof relayOf> | null = null

describe.skipIf(process.platform === 'win32')('a hub on a home server, with PCs of its own', () => {
  beforeAll(async () => {
    process.env.AGENTHYDRA_MOCK_NO_DELAY = '1'
    mkdirSync(HUB_HOME, { recursive: true })
    port = freePort()
    await restart({ admin: firstAdmin })
  }, SLOW_MS)

  afterAll(async () => {
    for (const relay of relays) relay.stop()
    await hub?.stop()
    rmSync(scratch, { recursive: true, force: true })
    for (const [k, v] of [
      ['AGENTHYDRA_MOCK_RECORDING', savedRecording],
      ['AGENTHYDRA_MOCK_NO_DELAY', savedNoDelay],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }, SLOW_MS)

  test(
    'the hub keeps its state, its pointer and its MCP entry in its own HOME, as an install on a server does',
    async () => {
      const config = join(HUB_HOME, '.agenthydra')
      const health = await getJson<{
        dataDir: string
        dbPath: string
        dataDirNotice: string | null
        sideRun: boolean
        pointerFile: string
      }>('/api/health')
      expect(health).toMatchObject({
        dataDir: join(config, 'data'),
        dbPath: join(config, 'data', 'agenthydra.db'),
        dataDirNotice: null,
        sideRun: false,
      })
      expect(health.pointerFile.startsWith(`${config}/`)).toBe(true)
      // Registered at boot, before it listened, and in the file the test named.
      const mcp = JSON.parse(readFileSync(join(HUB_HOME, '.claude.json'), 'utf8'))
      expect(mcp.mcpServers.agenthydra.url).toBe(`${hubUrl()}/api/mcp`)
    },
    SLOW_MS,
  )

  test(
    'two PCs paired through the pairing page get tokens of their own, push a chat each, and the hub lists each under its PC',
    async () => {
      officeToken = await pair(office)
      laptopToken = await pair(laptop)
      expect(officeToken).not.toBe(laptopToken)
      expect(officeToken).toMatch(/^chp_[0-9a-f]{16}_[0-9a-f]{64}$/)

      expect(await push(office, officeToken)).toEqual({ threads: 1, sent: 1, missing: 0 })
      expect(await push(laptop, laptopToken)).toEqual({ threads: 1, sent: 1, missing: 0 })
      expect(await hubChats()).toEqual([
        { pc: 'Laptop', id: laptop.chat.id, title: 'Write the changelog', instance: 'hub:laptop' },
        { pc: 'Office-PC', id: office.chat.id, title: 'Fix the parser', instance: 'hub:office-pc' },
      ])
      // Each PC's rollout is in its own copy, byte for byte.
      for (const pc of [office, laptop])
        expect(readFileSync(join(HUB_DIR, pc.key, ...rolloutPath(pc.chat.id)), 'utf8')).toBe(
          readFileSync(join(pc.home, ...rolloutPath(pc.chat.id)), 'utf8'),
        )
      // The store keeps each token's hash, never the token, at mode 600.
      const store = readFileSync(join(HUB_DIR, '.pcs.json'), 'utf8')
      for (const token of [officeToken, laptopToken]) expect(store).not.toContain(token)
      expect(statSync(join(HUB_DIR, '.pcs.json')).mode & 0o777).toBe(0o600)

      officeRelay = relayOf(office, officeToken)
      laptopRelay = relayOf(laptop, laptopToken)
      await until(async () => (await relayPcs()).every((p) => p.relay), 'both relays')
      expect(
        (await relayPcs()).map(({ pc, chats, relay, state }) => ({ pc, chats, relay, state })),
      ).toEqual([
        { pc: 'Laptop', chats: 1, relay: true, state: 'token' },
        { pc: 'Office-PC', chats: 1, relay: true, state: 'token' },
      ])
      // Desk's end of a PC's relay takes the admin token.
      expect(await socketOpens('/api/codex-relay/office-pc/app-server', bearer(firstAdmin))).toBe(
        true,
      )
    },
    SLOW_MS,
  )

  test(
    'a push, a relay or a build request without a token, with a wrong one, without Bearer or with the admin token is refused',
    async () => {
      const intruder = pcWith('Intruder', 'Not mine', 'cli')
      for (const authorization of [
        undefined,
        'Bearer not-a-token',
        `Bearer ${newPcToken().token}`,
        officeToken,
        `Basic ${officeToken}`,
        `Bearer ${firstAdmin}`,
      ]) {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-codex-hub-install': intruder.install,
        }
        if (authorization) headers.authorization = authorization
        const res = await fetch(`${hubUrl()}/api/codex-hub/push`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ pc: intruder.name, threads: [] }),
        })
        expect({ authorization, status: res.status }).toEqual({ authorization, status: 401 })
        for (const path of [
          '/api/codex-hub/pusher?platform=linux-x64',
          '/api/codex-hub/tray/download?platform=linux-x64',
          '/api/codex-hub/whoami',
        ])
          expect((await fetch(`${hubUrl()}${path}`, { headers })).status).toBe(401)
        const asHeaders: Record<string, string> = authorization ? { authorization } : {}
        expect(await socketOpens('/api/codex-hub/relay?pc=Intruder', asHeaders)).toBe(false)
      }
      // Through the real push code too: refused, and nothing of it is kept.
      await expect(push(intruder, 'not-a-token')).rejects.toThrow(SHARED_REFUSED)
      await expect(push(intruder, firstAdmin)).rejects.toThrow(SHARED_REFUSED)
      expect(existsSync(join(HUB_DIR, 'intruder'))).toBe(false)
      expect((await relayPcs()).map((p) => p.pc)).toEqual(['Laptop', 'Office-PC'])
      // With a PC token, a build request gets as far as the builds: none is handed out here.
      expect(await buildCheck(officeToken, office.install)).toEqual({
        status: 404,
        code: 'not-found',
      })
      // Desk's end takes the admin token and nothing else.
      for (const token of [officeToken, 'not-a-token'])
        expect(await socketOpens('/api/codex-relay/office-pc/app-server', bearer(token))).toBe(
          false,
        )
    },
    SLOW_MS,
  )

  test(
    'a request that names the hub by a network Host is refused before its token counts: a proxy forwards it as loopback',
    async () => {
      for (const host of ['hub.example.test', '192.0.2.10:7787']) {
        const res = await fetch(`${hubUrl()}/api/codex-hub/push`, {
          method: 'POST',
          headers: {
            host,
            'content-type': 'application/json',
            ...bearer(officeToken, office.install),
          },
          body: JSON.stringify({ pc: 'Office-PC', threads: [] }),
        })
        expect({ host, status: res.status }).toEqual({ host, status: 403 })
        const page = await fetch(
          `${hubUrl()}/codex-hub/pair?port=49152&state=${'a'.repeat(32)}&pc=Office-PC`,
          { headers: { host } },
        )
        expect(page.status).toBe(403)
        expect(await page.text()).not.toMatch(/[0-9a-f]{64}/)
      }
      // The office PC's chat is still the one it pushed.
      expect((await hubChats()).find((c) => c.pc === 'Office-PC')?.id).toBe(office.chat.id)
    },
    SLOW_MS,
  )

  test(
    "a PC's token acts for that PC alone: a push naming another PC writes under its own, and its relay with another PC's name opens as its own",
    async () => {
      // The laptop's token, with a body naming the office PC: written as the laptop's, and the office copy stays.
      const officeRollout = join(HUB_DIR, 'office-pc', ...rolloutPath(office.chat.id))
      const officeManifest = readFileSync(join(HUB_DIR, 'office-pc', 'manifest.json'), 'utf8')
      const res = await fetch(`${hubUrl()}/api/codex-hub/push`, {
        method: 'POST',
        headers: { ...bearer(laptopToken, laptop.install), 'content-type': 'application/json' },
        body: JSON.stringify({ pc: 'Office-PC', threads: [] }),
      })
      expect({ status: res.status, body: await res.json() }).toMatchObject({
        status: 200,
        body: { pc: 'Laptop' },
      })
      expect(existsSync(officeRollout)).toBe(true)
      expect(readFileSync(join(HUB_DIR, 'office-pc', 'manifest.json'), 'utf8')).toBe(officeManifest)
      expect((await hubChats()).map((c) => c.pc)).toEqual(['Office-PC'])
      expect(await push(laptop, laptopToken)).toEqual({ threads: 1, sent: 1, missing: 0 })

      // A relay with ?pc=office-pc and the laptop's token: it is the laptop's, and the office PC's never closes.
      laptopRelay!.relay.stop()
      await until(async () => !(await relayOn('Laptop')), "the laptop's relay gone")
      const officeCloses = officeRelay!.closes.length
      const hijack = new WebSocket(
        `${hubUrl().replace(/^http/, 'ws')}/api/codex-hub/relay?pc=office-pc`,
        {
          headers: bearer(laptopToken, laptop.install),
        } as unknown as string[],
      )
      const opened = await new Promise<boolean>((resolve) => {
        hijack.onopen = () => resolve(true)
        hijack.onclose = () => resolve(false)
      })
      expect(opened).toBe(true)
      await until(() => relayOn('Laptop'), 'the socket registered as the laptop')
      expect(await relayOn('Office-PC')).toBe(true)
      expect(officeRelay!.closes.length).toBe(officeCloses)
      hijack.close()
      await until(async () => !(await relayOn('Laptop')), 'the socket gone')
      expect(officeRelay!.closes.length).toBe(officeCloses)
      laptopRelay = relayOf(laptop, laptopToken)
      await until(() => relayOn('Laptop'), "the laptop's relay back")
    },
    SLOW_MS,
  )

  test(
    'the owner revokes the laptop with the command line: its relay closes, its push and build check are revoked, and pairing it again gives it a new token',
    async () => {
      const revoked = await cli(firstAdmin, 'revoke', 'Laptop')
      expect(revoked).toEqual({
        code: 0,
        stdout: 'Laptop revoked; its relay closed. Its copies stay until you forget it.\n',
        stderr: '',
      })
      await until(
        () => laptopRelay!.closes.some((c) => c.code === 4403),
        "the laptop's relay closed with 4403",
      )
      expect(laptopRelay!.closes.find((c) => c.code === 4403)?.reason).toBe(
        'This PC was revoked on the hub.',
      )
      await expect(push(laptop, laptopToken)).rejects.toThrow(
        "the hub revoked this PC's token; pair it again",
      )
      expect(await buildCheck(laptopToken)).toEqual({ status: 401, code: 'revoked' })
      expect((await relayPcs()).find((p) => p.pc === 'Laptop')).toMatchObject({
        relay: false,
        state: 'revoked',
        chats: 1,
      })
      // The office PC is untouched.
      expect(await push(office, officeToken)).toEqual({ threads: 1, sent: 0, missing: 0 })
      expect(await relayOn('Office-PC')).toBe(true)
      laptopRelay!.relay.stop()

      // Revoked, it is offered a plain Connect: the new token works, the revoked one is now unknown.
      const revokedToken = laptopToken
      laptopToken = await pair(laptop)
      // Its copies stayed through the revoke: there is nothing new to send.
      expect(await push(laptop, laptopToken)).toEqual({ threads: 1, sent: 0, missing: 0 })
      await expect(push(laptop, revokedToken)).rejects.toThrow(UNKNOWN_TOKEN)
      // In use, it is replaced only through the page's second step.
      const replacedToken = laptopToken
      laptopToken = await pair(laptop, { replace: true })
      expect(await push(laptop, laptopToken)).toEqual({ threads: 1, sent: 0, missing: 0 })
      await expect(push(laptop, replacedToken)).rejects.toThrow(UNKNOWN_TOKEN)

      // A PC without a desktop gets its token from the command line, bound by its first use; forget removes it.
      const added = await cli(firstAdmin, 'add', 'Spare-PC', '--json')
      expect(added.code).toBe(0)
      const spare = JSON.parse(added.stdout) as {
        token: string
        pc: string
        key: string
        id: string
      }
      secrets.add(spare.token)
      expect(spare).toMatchObject({ pc: 'Spare-PC', key: 'spare-pc' })
      expect(spare.token).toMatch(new RegExp(`^chp_${spare.id}_[0-9a-f]{64}$`))
      expect(added.stderr).toContain('tray.json')
      const whoami = await fetch(`${hubUrl()}/api/codex-hub/whoami`, {
        headers: bearer(spare.token, 'install-spare-pc-0001'),
      })
      expect(await whoami.json()).toEqual({
        pc: 'Spare-PC',
        key: 'spare-pc',
        id: spare.id,
        install: 'install-spare-pc-0001',
      })
      expect((await cli(firstAdmin, 'add', 'Spare-PC')).stderr).toContain('409 name-paired')
      expect((await cli(firstAdmin, 'forget', 'spare-pc')).code).toBe(0)
      // A key the cut at 63 characters leaves ending in a dash is taken as it is. It is also a name, of the PC whose
      // key it makes once that dash is trimmed: with both on the hub, the command line touches neither.
      const cut = `${'a'.repeat(62)}-`
      const long = JSON.parse((await cli(firstAdmin, 'add', `${cut}b`, '--json')).stdout)
      secrets.add(long.token)
      expect(long.key).toBe(cut)
      const short = JSON.parse((await cli(firstAdmin, 'add', 'a'.repeat(62), '--json')).stdout)
      secrets.add(short.token)
      const both = await cli(firstAdmin, 'revoke', cut)
      expect(both.code).toBe(1)
      expect(both.stderr).toContain(
        `${cut} is a PC's key on this hub and also the name of ${short.key}`,
      )
      const asks = async (token: string) =>
        (await fetch(`${hubUrl()}/api/codex-hub/whoami`, { headers: bearer(token) })).status
      expect([await asks(long.token), await asks(short.token)]).toEqual([200, 200])
      // As a name for add, that key would make the other's, and with --replace take its token: refused.
      const asName = await cli(firstAdmin, 'add', cut, '--replace')
      expect(asName.code).toBe(1)
      expect(asName.stderr).toContain(
        `${cut} is the key of a longer name, and is not a name of its own`,
      )
      expect(await asks(short.token)).toBe(200)
      expect((await cli(firstAdmin, 'forget', 'a'.repeat(62))).code).toBe(0)
      expect((await cli(firstAdmin, 'revoke', cut)).code).toBe(0)
      expect(await asks(long.token)).toBe(401)
      expect((await cli(firstAdmin, 'forget', cut)).code).toBe(0)
      expect(
        (await fetch(`${hubUrl()}/api/codex-hub/whoami`, { headers: bearer(spare.token) })).status,
      ).toBe(401)
      // The command line needs the admin token.
      expect(await cli('not-the-admin-token', 'list')).toMatchObject({
        code: 1,
        stderr: 'the hub refused the admin token: run this with --env-file pointing at hub.env\n',
      })
    },
    SLOW_MS,
  )

  test(
    "a restart with a new admin token keeps every PC's token; Desk's end takes the new admin token only, and the old one opens nothing",
    async () => {
      for (const relay of relays.splice(0)) relay.stop()
      await restart({ admin: secondAdmin })

      expect(await push(office, officeToken)).toEqual({ threads: 1, sent: 0, missing: 0 })
      expect(await push(laptop, laptopToken)).toEqual({ threads: 1, sent: 0, missing: 0 })
      officeRelay = relayOf(office, officeToken)
      laptopRelay = relayOf(laptop, laptopToken)
      await until(async () => (await relayPcs()).every((p) => p.relay), 'both relays')
      expect(await socketOpens('/api/codex-relay/laptop/app-server', bearer(firstAdmin))).toBe(
        false,
      )
      expect(await socketOpens('/api/codex-relay/laptop/app-server', bearer(secondAdmin))).toBe(
        true,
      )
      // The old admin token is what the PCs of before still hold: with …_LEGACY_TOKEN unset it is refused everywhere.
      await expect(push(office, firstAdmin)).rejects.toThrow(SHARED_REFUSED)
      expect(await buildCheck(firstAdmin)).toEqual({ status: 401, code: 'unauthorized' })
      expect(
        await socketOpens('/api/codex-hub/relay?pc=Office-PC', bearer(firstAdmin, office.install)),
      ).toBe(false)
      expect((await cli(firstAdmin, 'list')).code).toBe(1)
      expect(JSON.parse((await cli(secondAdmin, 'list', '--json')).stdout).legacy).toEqual({
        open: false,
        pending: 0,
      })
    },
    SLOW_MS,
  )

  test(
    "a PC token's push stays in its token's folder, for a record kept under a cut key whose name makes another",
    async () => {
      for (const relay of relays.splice(0)) relay.stop()
      await hub!.stop()
      // A store from before names were made to fit their keys: the record of 'aaa…a-' (a key the cut at 63 left
      // ending in a dash) is named by that key, which as a name makes 'aaa…a', another PC's folder.
      const cut = `${'a'.repeat(62)}-`
      const other = 'a'.repeat(62)
      const t = newPcToken()
      secrets.add(t.token)
      const install = `install-${crypto.randomUUID()}`
      const file = join(HUB_DIR, '.pcs.json')
      const store = JSON.parse(readFileSync(file, 'utf8'))
      store.pcs[cut] = {
        pc: cut,
        tokenId: t.id,
        tokenHash: t.hash,
        install,
        pairedAt: new Date().toISOString(),
        pairedBy: 'cli',
      }
      writeFileSync(file, JSON.stringify(store, null, 2))
      seedFolder(other, { pc: other, pushedAt: Date.now() })
      const before = readFileSync(join(HUB_DIR, other, 'manifest.json'), 'utf8')
      await restart({ admin: secondAdmin })
      try {
        const res = await fetch(`${hubUrl()}/api/codex-hub/push`, {
          method: 'POST',
          headers: { ...bearer(t.token, install), 'content-type': 'application/json' },
          body: JSON.stringify({ pc: 'Another-Name', threads: [] }),
        })
        expect({ status: res.status, body: await res.json() }).toMatchObject({
          status: 200,
          body: { pc: cut },
        })
        expect(JSON.parse(readFileSync(join(HUB_DIR, cut, 'manifest.json'), 'utf8')).pc).toBe(cut)
        expect(readFileSync(join(HUB_DIR, other, 'manifest.json'), 'utf8')).toBe(before)
      } finally {
        rmSync(join(HUB_DIR, other), { recursive: true, force: true })
        const gone = await fetch(`${hubUrl()}/api/codex-relay/admin/pcs/${cut}`, {
          method: 'DELETE',
          headers: bearer(secondAdmin),
        })
        expect(gone.status).toBe(200)
      }
    },
    SLOW_MS,
  )

  test(
    'migration: a PC that pushed with the shared token of before moves to a token of its own while the window is open, and only then',
    async () => {
      for (const relay of relays.splice(0)) relay.stop()
      await hub!.stop()
      const old = pcWith('Legacy-PC', 'An old chat', 'cli')
      const now = Date.now()
      seedFolder('legacy-pc', { pc: 'Legacy-PC', install: old.install, pushedAt: now })
      seedFolder('legacy-pc-lan', {
        pc: 'Legacy-PC-LAN',
        install: old.install,
        pushedAt: now - 3_600_000,
      })
      seedFolder('no-install-pc', { pc: 'No-Install-PC', pushedAt: now })
      await restart({ admin: secondAdmin, legacy: firstAdmin })
      const legacy = firstAdmin

      // An old pusher, with the shared token and the install id its manifest names: taken.
      expect(await push(old, legacy)).toEqual({ threads: 1, sent: 1, missing: 0 })
      const refused = SHARED_REFUSED
      await expect(push(old, legacy, { install: 'install-another-0001' })).rejects.toThrow(refused)
      await expect(push(old, legacy, { install: null })).rejects.toThrow(refused)
      await expect(push(office, legacy)).rejects.toThrow(refused)
      await expect(push(old, legacy, { pc: 'No-Install-PC' })).rejects.toThrow(refused)
      const oldRelay = relayOf(old, legacy)
      await until(() => relayOn('Legacy-PC'), 'the legacy relay')
      expect((await relayPcs()).find((p) => p.pc === 'Legacy-PC')?.state).toBe('pending')

      // Its new tray exchanges the shared token for one it made, from the same install id.
      const t = newPcToken()
      for (const s of [t.token, t.hash]) secrets.add(s)
      const exchanged = await fetch(`${hubUrl()}/api/codex-hub/exchange`, {
        method: 'POST',
        headers: { ...bearer(legacy, old.install), 'content-type': 'application/json' },
        body: JSON.stringify({ id: t.id, hash: t.hash }),
      })
      expect({ status: exchanged.status, body: await exchanged.json() }).toEqual({
        status: 200,
        body: { pc: 'Legacy-PC', key: 'legacy-pc', id: t.id },
      })
      await until(() => oldRelay.closes.some((c) => c.code === 4403), 'the legacy relay closed')
      expect(oldRelay.closes.find((c) => c.code === 4403)?.reason).toBe(
        'This PC moved to a token of its own.',
      )
      oldRelay.relay.stop()
      await expect(push(old, legacy)).rejects.toThrow(refused)
      expect(await push(old, t.token)).toEqual({ threads: 1, sent: 0, missing: 0 })

      const list = await cli(secondAdmin, 'list', '--json')
      expect(list.code).toBe(0)
      const { legacy: window, pcs } = JSON.parse(list.stdout) as {
        legacy: { open: boolean; pending: number }
        pcs: { key: string; state: string; why?: string; pairedBy?: string }[]
      }
      expect(window).toMatchObject({ open: true, pending: 0 })
      expect(pcs.map(({ key, state, why, pairedBy }) => ({ key, state, why, pairedBy }))).toEqual([
        { key: 'laptop', state: 'token', why: undefined, pairedBy: 'page' },
        { key: 'legacy-pc', state: 'token', why: undefined, pairedBy: 'exchange' },
        { key: 'legacy-pc-lan', state: 'unpaired', why: 'claimed', pairedBy: undefined },
        { key: 'no-install-pc', state: 'unpaired', why: 'no-install', pairedBy: undefined },
        { key: 'office-pc', state: 'token', why: undefined, pairedBy: 'page' },
      ])
      const text = await cli(secondAdmin, 'list')
      expect(text.stdout).toMatch(
        /^legacy window: open until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, 0 pending\n/,
      )
      expect(text.stdout).toContain(`Legacy-PC  token  chp_${t.id}  paired `)
      expect(text.stdout).toContain('No-Install-PC  unpaired (no-install)  -  not paired')
      // Nothing is pending now: the shared token gets no build either.
      expect(await buildCheck(legacy)).toEqual({ status: 401, code: 'unauthorized' })
      const hubLog = readFileSync(hub!.logs.stdout, 'utf8')
      expect(hubLog).toContain(
        '[codex-hub] Legacy-PC moved to a token of its own (chp_' +
          `${t.id}); every pending PC has a token of its own; remove AGENTHYDRA_CODEX_HUB_LEGACY_TOKEN and restart the hub`,
      )

      // Past …_LEGACY_UNTIL, the shared token opens nothing, for a PC that has not moved too.
      const late = pcWith('Late-PC', 'A late chat', 'cli')
      seedFolder('late-pc', { pc: 'Late-PC', install: late.install, pushedAt: Date.now() })
      await restart({
        admin: secondAdmin,
        legacy,
        until: new Date(Date.now() - 86_400_000).toISOString(),
      })
      expect(readFileSync(hub!.logs.stdout, 'utf8')).toContain(
        '[codex-hub] the legacy window closed on ',
      )
      await expect(push(late, legacy)).rejects.toThrow(refused)
      expect(await buildCheck(legacy, late.install)).toEqual({ status: 401, code: 'unauthorized' })
      expect(
        await socketOpens('/api/codex-hub/relay?pc=Late-PC', bearer(legacy, late.install)),
      ).toBe(false)
      const t2 = newPcToken()
      const lateExchange = await fetch(`${hubUrl()}/api/codex-hub/exchange`, {
        method: 'POST',
        headers: { ...bearer(legacy, late.install), 'content-type': 'application/json' },
        body: JSON.stringify({ id: t2.id, hash: t2.hash }),
      })
      expect(lateExchange.status).toBe(401)

      // A legacy token equal to the admin token is ignored, and the log says why.
      await restart({ admin: secondAdmin, legacy: secondAdmin })
      expect(readFileSync(hub!.logs.stderr, 'utf8')).toContain(
        '[codex-hub] AGENTHYDRA_CODEX_HUB_LEGACY_TOKEN is the admin token; it is ignored. Give ' +
          'AGENTHYDRA_CODEX_HUB_TOKEN a new value',
      )
      await expect(push(late, secondAdmin)).rejects.toThrow(refused)
      expect(await buildCheck(secondAdmin, late.install)).toEqual({
        status: 401,
        code: 'unauthorized',
      })
      // Every PC token still works.
      expect(await push(office, officeToken)).toEqual({ threads: 1, sent: 0, missing: 0 })
    },
    SLOW_MS,
  )

  test(
    "the hub's logs hold no token, no code and no hash",
    async () => {
      await hub!.stop()
      const logs = readdirSync(HUB_HOME).filter((f) => /^hub-.*\.log$/.test(f))
      expect(logs.length).toBeGreaterThanOrEqual(10)
      const all = logs.map((f) => readFileSync(join(HUB_HOME, f), 'utf8')).join('\n')
      expect(all).toContain('[codex-hub] Office-PC paired through the page (chp_')
      expect(all).not.toMatch(/chp_[0-9a-f]{16}_[0-9a-f]{64}/)
      expect(all).not.toMatch(/[0-9a-f]{64}/)
      for (const s of secrets) expect(all).not.toContain(s)
      hub = null
    },
    SLOW_MS,
  )
})

test(
  'the command line prints a control character in a name or a reason escaped, a C1 one included, and the key beside a name that is not plain ASCII',
  async () => {
    const fake = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) =>
        req.method === 'POST'
          ? Response.json({ pc: 'Lap\u200btop', key: 'lap-top', id: '0123456789abcdef' })
          : Response.json({
              legacy: { open: false, pending: 0 },
              pcs: [
                {
                  key: 'office-pc',
                  pc: 'Office\u009b\u0085\u001b[2K\u007fPC',
                  state: 'revoked',
                  revokedAt: '2026-10-18T09:00:00.000Z',
                  revokedWhy: 'renamed to x\ny',
                },
                // Its name makes its key, but is printed escaped: the key is shown too.
                { key: 'desk-pc', pc: 'Desk\u009bPC', state: 'unpaired', why: 'no-install' },
                // One that reads as Laptop, with a zero-width space and a bidi override, makes lap-top.
                { key: 'lap-top', pc: 'Lap\u200btop\u202e', state: 'unpaired', why: 'no-install' },
                // One that reads as Desktop with a variation selector, which is no format character, makes desk-top.
                { key: 'desk-top', pc: 'Desk\ufe0ftop', state: 'unpaired', why: 'no-install' },
                // One with a Cyrillic a, which a terminal draws as it is, makes l-ptop: the key is shown beside it.
                { key: 'l-ptop', pc: 'L\u0430ptop', state: 'unpaired', why: 'no-install' },
                // A name of printable ASCII that makes its key is printed alone.
                { key: 'laptop', pc: 'Laptop', state: 'unpaired', why: 'no-install' },
              ],
            }),
    })
    try {
      const r = await cliAt(`http://127.0.0.1:${fake.port}`, 'admin-x', 'list')
      expect(r.code).toBe(0)
      expect(r.stdout.replaceAll('\n', '')).not.toMatch(/\p{Cc}/u)
      expect(r.stdout).toContain('Office\\u009b\\u0085\\u001b[2K\\u007fPC (key office-pc)')
      expect(r.stdout).toContain('renamed to x\\u000ay')
      expect(r.stdout).toContain('Desk\\u009bPC (key desk-pc)')
      expect(r.stdout).toContain('Lap\\u200btop\\u202e (key lap-top)')
      expect(r.stdout).toContain('Desk\\ufe0ftop (key desk-top)')
      expect(r.stdout).toContain('L\u0430ptop (key l-ptop)')
      expect(r.stdout).toContain('\nLaptop  unpaired')
      expect(r.stdout).not.toMatch(/[\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u)
      // As JSON too: the same values, with DEL and C1 escaped as C0 is.
      const j = await cliAt(`http://127.0.0.1:${fake.port}`, 'admin-x', 'list', '--json')
      expect(j.code).toBe(0)
      expect(j.stdout.replaceAll('\n', '')).not.toMatch(
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u,
      )
      expect(JSON.parse(j.stdout).pcs.map((p: { pc: string }) => p.pc)).toEqual([
        'Office\u009b\u0085\u001b[2K\u007fPC',
        'Desk\u009bPC',
        'Lap\u200btop\u202e',
        'Desk\ufe0ftop',
        'L\u0430ptop',
        'Laptop',
      ])
      // add's line on stderr, which names the PC the hub registered.
      const a = await cliAt(`http://127.0.0.1:${fake.port}`, 'admin-x', 'add', 'Lap\u200btop')
      expect(a.code).toBe(0)
      expect(a.stderr).toContain(
        'Lap\\u200btop has a token of its own on the hub (chp_0123456789abcdef)',
      )
      expect(a.stderr).not.toMatch(/\p{Cf}/u)
    } finally {
      fake.stop(true)
    }
  },
  SLOW_MS,
)
