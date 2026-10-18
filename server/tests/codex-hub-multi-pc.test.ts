// server/tests/codex-hub-multi-pc.test.ts — two PCs on one hub, through the daemon as a home server runs it.
//
// The other hub tests call the routes on the shared app. This one starts the daemon itself (src/index.ts) in a
// scratch HOME on a loopback port, so every request meets what stands in front of the routes there: the /api
// loopback guard, the body limit and Bun.serve's WebSocket upgrade. Each PC is paired through the hub's pairing page
// the way the tray pairs (codex-hub-tray/pair.go: a loopback listener that the page's form posts the token to),
// pushes its own chat through pushCodexHubOnce from its own app-server (the recorded stand-in, tests/mocks), and
// keeps a relay socket open. The hub then lists each chat under the PC it came from. A push, a relay or a build
// request without the token, with a wrong one, or with one the hub no longer has is refused and writes nothing. With
// the token, a request that sends no install id pushes and relays under any PC's name, a connected one's too: the
// token is what keeps a PC's copy and relay, not the hub's hold on its name (docs/CODEX-HUB.md, step 7).
//
// Not on Windows: the daemon starts its tray host there at boot, which a test must not do.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import { type CodexHubPushConfig, pushCodexHubOnce } from '../src/core/codex-hub-push'
import { type CodexHubRelay, startCodexHubRelay } from '../src/core/codex-hub-relay-pc'
import { connectCodexRpc } from '../src/core/codex-rpc'

const SERVER = join(import.meta.dir, '..')
const MOCK_AGENT = join(import.meta.dir, 'mocks', 'mock-agent.mjs')
const scratch = join(
  process.env.AGENTHYDRA_HOME!,
  `hub-multi-pc-${crypto.randomUUID().slice(0, 6)}`,
)
const HUB_HOME = join(scratch, 'hub-home')
/** The hub's copies, under the scratch HOME's config dir (codex-hub.ts CODEX_HUB_DIR). */
const HUB_DIR = join(HUB_HOME, '.agenthydra', 'codex-hub')
// A daemon's boot and a pusher's app-server are real processes: a cold CI runner is far slower than a desktop.
const SLOW_MS = 60_000

const token = () => randomBytes(24).toString('base64url')
const savedRecording = process.env.AGENTHYDRA_MOCK_RECORDING
const savedNoDelay = process.env.AGENTHYDRA_MOCK_NO_DELAY

// --- the hub ------------------------------------------------------------------------------------

let hub: { url: string; port: number; proc: Subprocess } | null = null

function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const { port } = probe
  probe.stop(true)
  return port
}

/**
 * The daemon's environment: the suite's own, isolation and all, with every state root it can write to moved into the
 * scratch HOME. The daemon is a child without the test preload, so nothing guards its writes but this. Each root is
 * named outright rather than left to HOME: config.ts moves a checkout's server/data into the data dir when none is
 * named (a developer's legacy state, deleted with the scratch), and an inherited CLAUDE_CONFIG_DIR would have the
 * daemon register its MCP entries in that account's real config, pointing its next sessions at a port that is gone.
 * Only what this hub must differ in is dropped: the port and bind host, and any Codex hub setting of the developer's.
 */
function hubEnv(hubToken: string, port: number): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !/^(AGENTHYDRA_|CCMANAGERUI_)(CODEX_HUB_|PORT_FIXED$|MOCK_)/.test(k) &&
      !['PORT', 'HOST', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].includes(k)
    )
      env[k] = v
  const config = join(HUB_HOME, '.agenthydra')
  return Object.assign(env, {
    HOME: HUB_HOME,
    PORT: String(port),
    AGENTHYDRA_PORT_FIXED: '1',
    AGENTHYDRA_CODEX_HUB_TOKEN: hubToken,
    AGENTHYDRA_HOME: config,
    AGENTHYDRA_DATA_DIR: join(config, 'data'),
    AGENTHYDRA_DB: join(config, 'data', 'agenthydra.db'),
    AGENTHYDRA_RUN_LOG_DIR: join(config, 'data', 'run-logs'),
    AGENTHYDRA_CORE_DIR: join(config, 'core'),
    AGENTHYDRA_INSTANCES_ROOT: join(HUB_HOME, '.claude-instances'),
    AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(HUB_HOME, '.claude', 'projects'),
    AGENTHYDRA_CODEX_HOME: join(HUB_HOME, '.codex'),
    AGENTHYDRA_MCP_CONFIG: join(HUB_HOME, '.claude.json'),
    AGENTHYDRA_HOOKS_CONFIG: join(HUB_HOME, '.claude', 'settings.json'),
    AGENTHYDRA_CLAUDE_GUARD: '0',
    AGENTHYDRA_HSWARM_ENABLED: '0',
    HSWARM_HOME: join(HUB_HOME, '.hswarm'),
    HYDRA_FAMILY_DIR: join(HUB_HOME, '.hydra-family'),
  })
}

/** The daemon, as `bun server/src/index.ts` with the hub token set, in the scratch HOME; answers once it is up. */
async function startHub(hubToken: string, port: number): Promise<void> {
  const env = hubEnv(hubToken, port)
  const proc = Bun.spawn([process.execPath, join(SERVER, 'src', 'index.ts')], {
    cwd: SERVER,
    env,
    stdout: Bun.file(join(scratch, `hub-${port}-${Date.now()}.log`)),
    stderr: 'inherit',
    windowsHide: true,
  })
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + SLOW_MS / 2
  while (Date.now() < deadline) {
    if (proc.exitCode !== null)
      throw new Error(`the hub exited with ${proc.exitCode} before it answered`)
    const up = await fetch(`${url}/api/health`).then(
      (r) => r.ok,
      () => false,
    )
    if (up) {
      hub = { url, port, proc }
      return
    }
    await Bun.sleep(100)
  }
  proc.kill('SIGKILL')
  throw new Error('the hub did not answer /api/health in time')
}

async function stopHub(): Promise<void> {
  if (!hub) return
  const { proc } = hub
  hub = null
  proc.kill('SIGTERM')
  const ended = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(10_000).then(() => false),
  ])
  if (!ended) proc.kill('SIGKILL')
  await proc.exited
}

const hubUrl = () => hub!.url
const getJson = async <T>(path: string): Promise<T> =>
  (await (await fetch(`${hubUrl()}${path}`)).json()) as T

// --- the PCs ------------------------------------------------------------------------------------

interface Pc {
  name: string
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
  const rollout = join(
    home,
    'sessions',
    '2026',
    '10',
    '18',
    `rollout-2026-10-18T09-00-00-${id}.jsonl`,
  )
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
    install: `install-${name.toLowerCase()}-0001`,
    home,
    recording,
    chat: { id, title },
  }
}

const cfgOf = (pc: Pc, pcToken: string): CodexHubPushConfig => ({
  url: hubUrl(),
  token: pcToken,
  pc: pc.name,
  install: pc.install,
  headers: {},
  intervalMs: 120_000,
})

/** One push round from the PC, its chat list read from its own app-server process. */
function push(pc: Pc, pcToken: string) {
  return pushCodexHubOnce(cfgOf(pc, pcToken), {
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

/**
 * Pairs a PC as its tray does: a listener on a loopback port for the page's post, the hub's pairing page opened in
 * the browser with that port and a one-time state, and the page's form submitted as a click on Connect submits it.
 * Answers the token the tray would save.
 */
async function pair(pc: Pc): Promise<string> {
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
    const q = new URLSearchParams({ port: String(tray.port), state, pc: pc.name })
    const page = await fetch(`${hubUrl()}/codex-hub/pair?${q}`, {
      headers: {
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-dest': 'document',
      },
    })
    expect(page.status).toBe(200)
    const html = await page.text()
    const action = /<form method="post" action="([^"]+)">/.exec(html)?.[1]
    // The page posts to the tray's own port and nowhere else.
    expect(action).toBe(`http://127.0.0.1:${tray.port}/paired`)
    expect(page.headers.get('content-security-policy')).toContain(`form-action ${action};`)
    const form = new URLSearchParams()
    for (const m of html.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/g))
      form.set(m[1]!, fromHtml(m[2]!))
    const sent = await fetch(action!, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: hubUrl() },
      body: form,
    })
    expect(sent.status).toBe(200)
    const got = await posted.promise
    expect(got.get('state')).toBe(state)
    return got.get('token') ?? ''
  } finally {
    tray.stop(true)
  }
}

const relays: CodexHubRelay[] = []
/** The PC's relay socket, as its pusher keeps it open; no app-server is started on it here. */
function relayOf(pc: Pc, pcToken: string) {
  const closes: number[] = []
  const relay = startCodexHubRelay(cfgOf(pc, pcToken), {
    spawnAppServer: async () => {
      throw new Error('no app-server in this test')
    },
    codexHome: pc.home,
    mode: 'ask',
    retryMs: { min: 50, max: 60_000 },
    connect: (url, headers) => {
      const ws = new WebSocket(url, { headers } as unknown as string[])
      ws.addEventListener('close', (e) => closes.push(e.code))
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

interface RelayPc {
  id: string
  pc: string
  pushedAt: string
  chats: number
  relay: boolean
}
const relayPcs = () => getJson<RelayPc[]>('/api/codex-relay/pcs')
const hubChats = async () =>
  (
    await getJson<{
      rows: { threadId: string; title: string; fromPc?: string; instanceId: string }[]
    }>('/api/codex-chats')
  ).rows
    .filter((r) => r.fromPc)
    .map((r) => ({ pc: r.fromPc, id: r.threadId, title: r.title, instance: r.instanceId }))
    .sort((a, b) => a.pc!.localeCompare(b.pc!))

async function until(ok: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

// --- the flow -----------------------------------------------------------------------------------

const office = pcWith('Office-PC', 'Fix the parser', 'vscode')
const laptop = pcWith('Laptop', 'Write the changelog', 'cli')
const firstToken = token()
let port = 0
let officeToken = ''
let laptopToken = ''
let officeRelay: ReturnType<typeof relayOf> | null = null

describe.skipIf(process.platform === 'win32')('a hub on a home server, with two PCs', () => {
  beforeAll(async () => {
    process.env.AGENTHYDRA_MOCK_NO_DELAY = '1'
    mkdirSync(HUB_HOME, { recursive: true })
    port = freePort()
    await startHub(firstToken, port)
  }, SLOW_MS)

  afterAll(async () => {
    for (const relay of relays) relay.stop()
    await stopHub()
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
    'two PCs paired through the pairing page push a chat each, and the hub lists each under its PC',
    async () => {
      officeToken = await pair(office)
      laptopToken = await pair(laptop)
      // One hub token: every PC is handed the same one.
      expect(officeToken).toBe(firstToken)
      expect(laptopToken).toBe(firstToken)

      expect(await push(office, officeToken)).toEqual({ threads: 1, sent: 1, missing: 0 })
      expect(await push(laptop, laptopToken)).toEqual({ threads: 1, sent: 1, missing: 0 })
      expect(await hubChats()).toEqual([
        { pc: 'Laptop', id: laptop.chat.id, title: 'Write the changelog', instance: 'hub:laptop' },
        { pc: 'Office-PC', id: office.chat.id, title: 'Fix the parser', instance: 'hub:office-pc' },
      ])
      // Each PC's rollout is in its own copy, byte for byte.
      for (const [pc, key] of [
        [office, 'office-pc'],
        [laptop, 'laptop'],
      ] as const) {
        const rel = [
          'sessions',
          '2026',
          '10',
          '18',
          `rollout-2026-10-18T09-00-00-${pc.chat.id}.jsonl`,
        ]
        expect(readFileSync(join(HUB_DIR, key, ...rel), 'utf8')).toBe(
          readFileSync(join(pc.home, ...rel), 'utf8'),
        )
      }

      officeRelay = relayOf(office, officeToken)
      relayOf(laptop, laptopToken)
      await until(async () => (await relayPcs()).every((p) => p.relay), 'both relays')
      expect((await relayPcs()).map(({ pc, chats, relay }) => ({ pc, chats, relay }))).toEqual([
        { pc: 'Laptop', chats: 1, relay: true },
        { pc: 'Office-PC', chats: 1, relay: true },
      ])
      // Desk's end of a PC's relay takes the same token.
      expect(
        await socketOpens('/api/codex-relay/office-pc/app-server', {
          authorization: `Bearer ${firstToken}`,
        }),
      ).toBe(true)
    },
    SLOW_MS,
  )

  test(
    'a push, a relay or a build request without the token, with a wrong one, or without Bearer is refused',
    async () => {
      const intruder = pcWith('Intruder', 'Not mine', 'cli')
      for (const authorization of [
        undefined,
        'Bearer not-the-token',
        firstToken,
        `Basic ${firstToken}`,
      ]) {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
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
        ])
          expect((await fetch(`${hubUrl()}${path}`, { headers })).status).toBe(401)
        const asHeaders: Record<string, string> = authorization ? { authorization } : {}
        expect(await socketOpens('/api/codex-hub/relay?pc=Intruder', asHeaders)).toBe(false)
        expect(await socketOpens('/api/codex-relay/office-pc/app-server', asHeaders)).toBe(false)
      }
      // Through the real push code too: refused, and nothing of it is kept.
      await expect(push(intruder, 'not-the-token')).rejects.toThrow(/Codex hub answered 401/)
      expect(existsSync(join(HUB_DIR, 'intruder'))).toBe(false)
      expect((await relayPcs()).map((p) => p.pc)).toEqual(['Laptop', 'Office-PC'])
      // With the token, a build request gets as far as the builds: none is handed out here.
      expect(
        (
          await fetch(`${hubUrl()}/api/codex-hub/pusher?platform=linux-x64`, {
            headers: { authorization: `Bearer ${firstToken}` },
          })
        ).status,
      ).toBe(404)
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
            authorization: `Bearer ${firstToken}`,
          },
          body: JSON.stringify({ pc: 'Office-PC', threads: [] }),
        })
        expect({ host, status: res.status }).toEqual({ host, status: 403 })
        const page = await fetch(`${hubUrl()}/codex-hub/pair?port=49152&state=${'a'.repeat(32)}`, {
          headers: { host },
        })
        expect(page.status).toBe(403)
        expect(await page.text()).not.toContain(firstToken)
      }
      // The office PC's chat is still the one it pushed.
      expect((await hubChats()).find((c) => c.pc === 'Office-PC')?.id).toBe(office.chat.id)
    },
    SLOW_MS,
  )

  test(
    "the token, not a PC's hold on its name, is what keeps its copy and relay: one sent without an install id takes both",
    async () => {
      const bearer = { authorization: `Bearer ${firstToken}` }
      // A push under the office PC's name while its relay is open, with no install id: taken, and its copy goes.
      const res = await fetch(`${hubUrl()}/api/codex-hub/push`, {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ pc: 'Office-PC', threads: [] }),
      })
      expect(res.status).toBe(200)
      expect((await hubChats()).map((c) => c.pc)).toEqual(['Laptop'])
      const day = join(HUB_DIR, 'office-pc', 'sessions', '2026', '10', '18')
      expect(existsSync(join(day, `rollout-2026-10-18T09-00-00-${office.chat.id}.jsonl`))).toBe(
        false,
      )

      // A relay for its name with no install id closes the office PC's own, which then connects again.
      const closesBefore = officeRelay!.closes.length
      expect(await socketOpens('/api/codex-hub/relay?pc=Office-PC', bearer)).toBe(true)
      await until(
        async () => officeRelay!.closes.length > closesBefore,
        "the office PC's relay closed",
      )
      await until(
        async () => (await relayPcs()).find((p) => p.pc === 'Office-PC')?.relay === true,
        "the office PC's relay back",
      )

      // Its next push puts its chat back.
      expect(await push(office, officeToken)).toEqual({ threads: 1, sent: 1, missing: 0 })
      expect((await hubChats()).map((c) => c.pc)).toEqual(['Laptop', 'Office-PC'])
    },
    SLOW_MS,
  )

  test(
    'a hub token that was changed is refused everywhere: the PC paired again pushes, the other stays out',
    async () => {
      for (const relay of relays.splice(0)) relay.stop()
      const before = await relayPcs()
      const secondToken = token()
      await stopHub()
      await startHub(secondToken, port)

      // The revoked token: no push, no build, no relay, and Desk's end neither.
      await expect(push(laptop, laptopToken)).rejects.toThrow(/Codex hub answered 401/)
      const old = { authorization: `Bearer ${firstToken}` }
      expect(
        (await fetch(`${hubUrl()}/api/codex-hub/pusher?platform=linux-x64`, { headers: old }))
          .status,
      ).toBe(401)
      expect(await socketOpens('/api/codex-hub/relay?pc=Laptop', old)).toBe(false)
      expect(await socketOpens('/api/codex-relay/laptop/app-server', old)).toBe(false)
      const refusedRelay = relayOf(laptop, laptopToken)
      await Bun.sleep(300)
      expect((await relayPcs()).find((p) => p.pc === 'Laptop')?.relay).toBe(false)
      refusedRelay.relay.stop()

      // The office PC is paired again, gets the new token, and pushes with it.
      officeToken = await pair(office)
      expect(officeToken).toBe(secondToken)
      expect(await push(office, officeToken)).toEqual({ threads: 1, sent: 0, missing: 0 })
      relayOf(office, officeToken)
      await until(
        async () => (await relayPcs()).find((p) => p.pc === 'Office-PC')?.relay === true,
        "the office PC's relay",
      )
      const after = await relayPcs()
      const at = (list: RelayPc[], pc: string) => list.find((p) => p.pc === pc)!
      expect(Date.parse(at(after, 'Office-PC').pushedAt)).toBeGreaterThan(
        Date.parse(at(before, 'Office-PC').pushedAt),
      )
      // The laptop's copy is the one it pushed before the change, and nothing since.
      expect(at(after, 'Laptop')).toEqual({ ...at(before, 'Laptop'), relay: false })
      expect((await hubChats()).map((c) => c.pc)).toEqual(['Laptop', 'Office-PC'])
    },
    SLOW_MS,
  )
})
