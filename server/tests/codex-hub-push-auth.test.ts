// server/tests/codex-hub-push-auth.test.ts — a PC's pusher on a hub where each PC has a token of its own.
//
// The pusher (src/core/codex-hub-push.ts) sends this PC's token with its install id, which the hub binds the token
// to: the id comes from AGENTHYDRA_CODEX_HUB_INSTALL when the tray passes one, else from the pusher's own file, made
// once, exclusively, at 0600. When the hub refuses a push it says why in words a person can act on. Its relay
// (src/core/codex-hub-relay-pc.ts) is refused before the upgrade, so a refused dial never opens and its wait goes on
// doubling, logged once for a run of them; a live socket the hub closes with 4403 waits the longest. And the codex
// processes it starts never see the hub's settings (config.ts codexSpawnEnv). Every token is made at run time, every
// PC has a name of its own, and every setting is restored.
import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import { CONFIG_DIR, codexSpawnEnv } from '../src/config'
import { CODEX_HUB_DIR } from '../src/core/codex-hub'
import { revokePc } from '../src/core/codex-hub-pcs'
import {
  type CodexHubPushConfig,
  codexHubPushConfig,
  hubRefusal,
  PUSHER_INSTALL_FILES,
  pushCodexHubOnce,
  pusherInstallId,
} from '../src/core/codex-hub-push'
import { RELAY_REFUSED } from '../src/core/codex-hub-relay'
import { startCodexHubRelay } from '../src/core/codex-hub-relay-pc'
import type { CodexRpc } from '../src/core/codex-rpc'
import { app } from '../src/http-app'
import '../src/routes/codex-hub'
import { newPcToken, type TestPc, testPc } from './codex-hub-test-pc'

const NAMES = [
  'CODEX_HUB_TOKEN',
  'CODEX_HUB_LEGACY_TOKEN',
  'CODEX_HUB_LEGACY_UNTIL',
  'CODEX_HUB_INSTALL',
  'CODEX_HUB_URL',
].flatMap((s) => [`AGENTHYDRA_${s}`, `CCMANAGERUI_${s}`])
const saved = new Map(NAMES.map((n) => [n, process.env[n]]))
const ADMIN = `push-auth-admin-${randomUUID()}`

beforeEach(() => {
  for (const n of NAMES) delete process.env[n]
  process.env.AGENTHYDRA_CODEX_HUB_TOKEN = ADMIN
})

// A copy with its own router: a request through the shared app would build its matcher and stop every later test
// file from registering routes.
const http = new Hono().route('/', app)
const toHub: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) =>
  http.fetch(new Request(String(input), init))) as typeof fetch
const scratch = join(process.env.AGENTHYDRA_HOME!, `hub-push-auth-${randomUUID().slice(0, 6)}`)
mkdirSync(scratch, { recursive: true })
const keys = new Set<string>()
const stops: (() => void)[] = []

afterAll(() => {
  for (const stop of stops) stop()
  for (const key of keys) rmSync(join(CODEX_HUB_DIR, key), { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
  for (const [n, v] of saved) {
    if (v === undefined) delete process.env[n]
    else process.env[n] = v
  }
})

async function until(ok: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

const SUFFIX = randomUUID().slice(0, 6)
/** A PC with a token of its own, bound to a fresh install id unless said; its folder is removed at the end. */
const pcNamed = (base: string, opts?: Parameters<typeof testPc>[1]): TestPc => {
  const p = testPc(`${base}-${SUFFIX}`, opts)
  keys.add(p.key)
  return p
}
const modeOf = (file: string) => statSync(file).mode & 0o777

// --- the install id -------------------------------------------------------------------------------

test('AGENTHYDRA_CODEX_HUB_INSTALL wins over the file, and the file is then not touched', () => {
  const files = Object.values(PUSHER_INSTALL_FILES)
  const before = files.map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : null))
  // The standalone pusher's file holds another id, at the mode the first pushers left; the daemon's is not there.
  const untouched = () => {
    expect(readFileSync(PUSHER_INSTALL_FILES.standalone, 'utf8')).toBe('install-in-the-file-0001\n')
    if (process.platform !== 'win32') expect(modeOf(PUSHER_INSTALL_FILES.standalone)).toBe(0o644)
    expect(existsSync(PUSHER_INSTALL_FILES.daemon)).toBe(false)
  }
  try {
    for (const f of files) rmSync(f, { force: true })
    writeFileSync(PUSHER_INSTALL_FILES.standalone, 'install-in-the-file-0001\n')
    chmodSync(PUSHER_INSTALL_FILES.standalone, 0o644)
    process.env.AGENTHYDRA_CODEX_HUB_URL = 'https://hub.example.test'
    process.env.AGENTHYDRA_CODEX_HUB_INSTALL = ' install-from-the-tray-0001 '
    expect(codexHubPushConfig('standalone')?.install).toBe('install-from-the-tray-0001')
    expect(codexHubPushConfig('daemon')?.install).toBe('install-from-the-tray-0001')
    untouched()
    // The spelling of before the rename works too.
    delete process.env.AGENTHYDRA_CODEX_HUB_INSTALL
    process.env.CCMANAGERUI_CODEX_HUB_INSTALL = 'install-old-spelling-0001'
    expect(codexHubPushConfig('standalone')?.install).toBe('install-old-spelling-0001')
    // An id the hub would not take is a mistake to say, not one to send.
    process.env.AGENTHYDRA_CODEX_HUB_INSTALL = 'not an id'
    expect(() => codexHubPushConfig('standalone')).toThrow(
      'AGENTHYDRA_CODEX_HUB_INSTALL must be 8 to 64 letters, digits, dashes or underscores.',
    )
    untouched()
    // Without it, the file again.
    delete process.env.AGENTHYDRA_CODEX_HUB_INSTALL
    delete process.env.CCMANAGERUI_CODEX_HUB_INSTALL
    expect(codexHubPushConfig('standalone')?.install).toBe('install-in-the-file-0001')
    const id = codexHubPushConfig('daemon')?.install
    expect(readFileSync(PUSHER_INSTALL_FILES.daemon, 'utf8')).toBe(`${id}\n`)
  } finally {
    files.forEach((f, i) => {
      rmSync(f, { force: true })
      if (before[i] !== null) writeFileSync(f, before[i]!)
    })
  }
})

test('the install file is made once, at 0600, and pushers that make it at once end with one id', async () => {
  const file = join(scratch, 'one', 'codex-hub-push-install')
  const id = pusherInstallId(file)
  expect(id).toMatch(/^[0-9a-f-]{36}$/)
  expect(readFileSync(file, 'utf8')).toBe(`${id}\n`)
  expect(pusherInstallId(file)).toBe(id)
  if (process.platform !== 'win32') {
    expect(modeOf(file)).toBe(0o600)
    expect(modeOf(join(scratch, 'one'))).toBe(0o700)
  }

  // Pushers in processes of their own, four to a file, each told to make its file at the same moment. Whoever
  // makes it first, every one of them answers the id it holds.
  const mod = pathToFileURL(join(import.meta.dir, '..', 'src', 'core', 'codex-hub-push.ts')).href
  const code = [
    `const { pusherInstallId } = await import(${JSON.stringify(mod)})`,
    'await Bun.sleep(Math.max(0, Number(process.env.RACE_AT) - Date.now()))',
    'console.log(pusherInstallId(process.env.RACE_FILE))',
  ].join('\n')
  const at = String(Date.now() + 1_500)
  const files = [0, 1, 2].map((n) => join(scratch, `race-${n}`, 'codex-hub-push-install'))
  const answers = await Promise.all(
    files.map((raced) =>
      Promise.all(
        Array.from({ length: 4 }, async () => {
          const p = Bun.spawn([process.execPath, '-e', code], {
            env: { ...process.env, RACE_FILE: raced, RACE_AT: at },
            stdout: 'pipe',
            stderr: 'pipe',
          })
          const [out, err, exit] = await Promise.all([
            new Response(p.stdout).text(),
            new Response(p.stderr).text(),
            p.exited,
          ])
          expect({ exit, err: exit ? err : '' }).toEqual({ exit: 0, err: '' })
          return out.trim()
        }),
      ),
    ),
  )
  files.forEach((raced, n) => {
    const kept = readFileSync(raced, 'utf8')
    expect(kept).toMatch(/^[0-9a-f-]{36}\n$/)
    expect(answers[n]).toEqual(Array(4).fill(kept.trim()))
  })
}, 30_000)

test.skipIf(process.platform === 'win32')(
  'an install file of before, at 0644, keeps its id and becomes 0600',
  () => {
    const file = join(scratch, 'old', 'codex-hub-push-install')
    mkdirSync(join(scratch, 'old'))
    writeFileSync(file, 'install-of-before-0001\n')
    chmodSync(file, 0o644)
    expect(pusherInstallId(file)).toBe('install-of-before-0001')
    expect(modeOf(file)).toBe(0o600)
  },
)

test('an install file with no id in it is replaced; one that cannot be made gives none', () => {
  // Empty, as another pusher leaves it between its create and its write: waited for, then taken as left empty.
  for (const left of ['', 'not an id\n']) {
    const file = join(scratch, `left-${left.length}`, 'codex-hub-push-install')
    mkdirSync(join(scratch, `left-${left.length}`))
    writeFileSync(file, left)
    const id = pusherInstallId(file)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(readFileSync(file, 'utf8')).toBe(`${id}\n`)
    if (process.platform !== 'win32') expect(modeOf(file)).toBe(0o600)
  }
  writeFileSync(join(scratch, 'a-file'), '')
  expect(pusherInstallId(join(scratch, 'a-file', 'codex-hub-push-install'))).toBeNull()
  // A folder where the file should be: nothing to read, and nothing to make.
  mkdirSync(join(scratch, 'a-folder', 'codex-hub-push-install'), { recursive: true })
  expect(pusherInstallId(join(scratch, 'a-folder', 'codex-hub-push-install'))).toBeNull()
})

// --- what the push says ---------------------------------------------------------------------------

/** A stand-in for this PC's app-server: no chats, so a push is only its list. */
const rpc = async (): Promise<CodexRpc> => ({
  call: async <T>() => ({ data: [], nextCursor: null }) as T,
  close: () => undefined,
})
const pushAs = (cfg: CodexHubPushConfig) =>
  pushCodexHubOnce(cfg, { connect: rpc, fetch: toHub, codexHome: scratch })
const urlOf = 'http://127.0.0.1'

test('a refused push says why, in words a person can act on', async () => {
  const office = pcNamed('Push-Office')
  expect(await pushAs(office.cfg(urlOf))).toEqual({ threads: 0, sent: 0, missing: 0 })

  // Another install of the pusher, with the office's token.
  await expect(pushAs({ ...office.cfg(urlOf), install: 'install-another-0001' })).rejects.toThrow(
    'this token belongs to another install of the pusher; pair this PC on its own',
  )
  // No install id: its config folder could not be written.
  await expect(pushAs({ ...office.cfg(urlOf), install: null })).rejects.toThrow(
    `this pusher has no install id: ${CONFIG_DIR} cannot be written; fix that, or set AGENTHYDRA_CODEX_HUB_INSTALL`,
  )
  // A token the hub never had, or no longer has.
  const unknown = newPcToken()
  await expect(pushAs({ ...office.cfg(urlOf), token: unknown.token })).rejects.toThrow(
    "the hub does not know this PC's token (it was paired again elsewhere, or forgotten); pair it again",
  )
  // Revoked by the owner.
  const laptop = pcNamed('Push-Laptop')
  expect(revokePc(laptop.key)).toMatchObject({ ok: true })
  await expect(pushAs(laptop.cfg(urlOf))).rejects.toThrow(
    "the hub revoked this PC's token; pair it again",
  )
  // The office PC is untouched by all of it.
  expect(await pushAs(office.cfg(urlOf))).toEqual({ threads: 0, sent: 0, missing: 0 })
})

test('a pusher still on the shared token of before is told to get a token of its own once the hub refuses it', async () => {
  const shared = `push-auth-legacy-${randomUUID()}`
  const cfg: CodexHubPushConfig = {
    url: urlOf,
    token: shared,
    pc: `Push-Old-${SUFFIX}`,
    install: 'install-old-pusher-0001',
    headers: {},
    intervalMs: 60_000,
  }
  const said =
    'the hub no longer takes the shared token: pair this PC with the Codex Hub app, or put a token from ' +
    '`scripts/codex-hub-pcs.ts add` in AGENTHYDRA_CODEX_HUB_TOKEN'
  // No migration window on this hub.
  await expect(pushAs(cfg)).rejects.toThrow(said)
  // A window open, for a PC that is not pending: the same bare 401.
  process.env.AGENTHYDRA_CODEX_HUB_LEGACY_TOKEN = shared
  await expect(pushAs(cfg)).rejects.toThrow(said)
  // The admin token is refused on a PC's route as any other value of before is.
  await expect(pushAs({ ...cfg, token: ADMIN })).rejects.toThrow(said)
  expect(existsSync(join(CODEX_HUB_DIR, `push-old-${SUFFIX}`))).toBe(false)
})

test('an answer the pusher has no words for is passed on as the hub gave it', () => {
  const { token } = newPcToken()
  // A hub from before PC tokens refuses one with a bare 401; the shared token's 409 is the hold on its name.
  expect(hubRefusal(401, '{"error":"unauthorized"}', token)).toBeNull()
  expect(hubRefusal(409, '{"error":"held","code":"name-taken"}', 'shared')).toBeNull()
  expect(hubRefusal(503, 'not json', token)).toBeNull()
  expect(hubRefusal(401, '{"code":"revoked"}', token)).toBe(
    "the hub revoked this PC's token; pair it again",
  )
})

// --- the relay ------------------------------------------------------------------------------------

/**
 * A hub that answers each relay dial as `answers` says, the last one again for the rest: `refuse` is a 401 before
 * the upgrade, `revoke` opens the socket and closes it with 4403, as a revoke does to a live one.
 */
function scriptedHub(answers: ('refuse' | 'revoke')[]) {
  let dials = 0
  const srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, s) {
      const answer = answers[Math.min(dials++, answers.length - 1)]
      if (answer === 'revoke' && s.upgrade(req)) return undefined
      return Response.json({ error: 'this PC was revoked', code: 'revoked' }, { status: 401 })
    },
    websocket: {
      open: (ws) => ws.close(RELAY_REFUSED, 'This PC was revoked on the hub.'),
      message: () => {},
    },
  })
  stops.push(() => srv.stop(true))
  return `http://127.0.0.1:${srv.port}`
}

/** This PC's relay to `url`, with short waits that the test sees, and what its sockets did. */
function relayTo(url: string) {
  const seen = { waits: [] as number[], opened: 0, closes: [] as number[] }
  const pc = pcNamed(`Relay-PC-${randomUUID().slice(0, 4)}`)
  const relay = startCodexHubRelay(pc.cfg(url), {
    spawnAppServer: async () => {
      throw new Error('no app-server in this test')
    },
    codexHome: scratch,
    mode: 'ask',
    retryMs: { min: 50, max: 400 },
    later: (dial, ms) => {
      seen.waits.push(ms)
      return setTimeout(dial, ms)
    },
    connect: (u, headers) => {
      const ws = new WebSocket(u, { headers } as unknown as string[])
      ws.addEventListener('open', () => seen.opened++)
      ws.addEventListener('close', (e) => seen.closes.push(e.code))
      return ws
    },
  })!
  stops.push(() => relay.stop())
  return Object.assign(seen, { stop: () => relay.stop() })
}

test('dials the hub refuses before the upgrade never open, wait 50, 100 and 200 ms, and are logged once', async () => {
  const url = scriptedHub(['refuse'])
  const lines: string[] = []
  const logged = spyOn(console, 'error').mockImplementation(
    (...args: unknown[]) => void lines.push(args.join(' ')),
  )
  try {
    const relay = relayTo(url)
    await until(() => relay.waits.length >= 3, 'three refused dials')
    relay.stop()
    expect(relay.waits).toEqual([50, 100, 200])
    expect(relay.opened).toBe(0)
    expect(lines).toEqual([
      `[codex-hub] relay to ${url}: the hub refused the relay, or is out of reach`,
    ])
  } finally {
    logged.mockRestore()
  }
})

test('a socket the hub closes with 4403 logs the reason and waits the longest, and a refused dial after it does not reset the wait', async () => {
  const url = scriptedHub(['revoke', 'refuse'])
  const lines: string[] = []
  const logged = spyOn(console, 'error').mockImplementation(
    (...args: unknown[]) => void lines.push(args.join(' ')),
  )
  try {
    const relay = relayTo(url)
    await until(() => relay.waits.length >= 3, 'the dials after the 4403')
    relay.stop()
    expect(relay.opened).toBe(1)
    expect(relay.closes[0]).toBe(RELAY_REFUSED)
    expect(relay.waits).toEqual([400, 400, 400])
    expect(lines).toEqual([
      `[codex-hub] relay to ${url} closed: This PC was revoked on the hub.`,
      `[codex-hub] relay to ${url}: the hub refused the relay, or is out of reach`,
    ])
  } finally {
    logged.mockRestore()
  }
})

// --- the codex processes it starts ----------------------------------------------------------------

test("the codex processes a PC's pusher starts never see the hub's settings, and see everything else", () => {
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    HOME: 'C:/Users/me',
    AGENTHYDRA_CODEX_HUB_TOKEN: 'a-token',
    AGENTHYDRA_CODEX_HUB_URL: 'https://hub.example.test',
    AGENTHYDRA_CODEX_HUB_HEADERS: '{"cf-access-client-secret":"x"}',
    AGENTHYDRA_CODEX_HUB_INSTALL: 'install-from-the-tray-0001',
    AGENTHYDRA_CODEX_HUB_LEGACY_TOKEN: 'shared',
    CCMANAGERUI_CODEX_HUB_TOKEN: 'a-token-of-before',
    CCMANAGERUI_CODEX_HUB_PC: 'Example-PC',
    Agenthydra_Codex_Hub_Token: 'any case',
    AGENTHYDRA_CODEX_PATH: '/opt/codex/bin/codex',
    AGENTHYDRA_HOME: 'C:/Users/me/.agenthydra',
    AGENTHYDRA_CODEX_HUBS: 'not a hub setting',
    CODEX_HUB_TOKEN: 'not ours',
    OPENAI_API_KEY: 'kept: codex reads it',
  }
  const others = Object.fromEntries(
    Object.entries(env).filter(([name]) => !/^(AGENTHYDRA|CCMANAGERUI)_CODEX_HUB_/i.test(name)),
  )
  expect(Object.keys(others)).toEqual([
    'PATH',
    'HOME',
    'AGENTHYDRA_CODEX_PATH',
    'AGENTHYDRA_HOME',
    'AGENTHYDRA_CODEX_HUBS',
    'CODEX_HUB_TOKEN',
    'OPENAI_API_KEY',
  ])
  // A bare `codex`, which PATH finds, and one named by path, whose PATH gains its folder off Windows.
  expect(codexSpawnEnv('codex', env, scratch)).toEqual(others)
  const { PATH, ...named } = codexSpawnEnv(join(scratch, 'bin', 'codex'), env, scratch)
  const { PATH: _, ...rest } = others
  expect(named).toEqual(rest)
  expect(PATH).toContain('/usr/bin')
  // What it was given is left as it was.
  expect(env.AGENTHYDRA_CODEX_HUB_TOKEN).toBe('a-token')
})
