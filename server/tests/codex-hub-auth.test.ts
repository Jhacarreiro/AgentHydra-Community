// server/tests/codex-hub-auth.test.ts — who a Codex hub lets act as which PC, through its routes.
//
// Each PC's own token is the authentication on /api/codex-hub/ (src/routes/codex-hub.ts, src/core/codex-hub-pcs.ts):
// it acts for that PC's key alone, from the install id bound to it, whatever a request names. The admin token is
// refused there and taken only by Desk's end and the admin API; the shared token of before acts only for a pending
// PC while the migration window is open. The routes run in-process, with a Bun.serve in front for the sockets: a
// relay refused is refused with an HTTP status before its upgrade, and one whose credential changes is closed with
// 4403. Every PC here has a name of its own (the test files share one hub folder), every setting is restored, and
// every token is made at run time. The last tests check that nothing the hub logged holds a secret, and run
// codex-hub-tray/testdata/contract.json, the cases the tray's own tests run against their stand-in hub.
import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import contract from '../../codex-hub-tray/testdata/contract.json'
import {
  acceptCodexHubPush,
  CODEX_HUB_DIR,
  hubPcKey,
  readCodexHubManifest,
} from '../src/core/codex-hub'
import {
  legacyWindow,
  pcByToken,
  pendingKeys,
  registerPcToken,
  revokePc,
} from '../src/core/codex-hub-pcs'
import { RELAY_REFUSED, relayPcs, relayPcToken } from '../src/core/codex-hub-relay'
import { app } from '../src/http-app'
import { codexHubTestHooks } from '../src/routes/codex-hub'
import { newPcToken, type TestPc, testPc } from './codex-hub-test-pc'

// Everything the hub says while this file runs, for the last-but-one test; nothing of it is printed.
const said: string[] = []
const consoles = (['log', 'info', 'warn', 'error'] as const).map((m) =>
  spyOn(console, m).mockImplementation((...args: unknown[]) => void said.push(args.join(' '))),
)

const ADMIN = `auth-admin-${randomUUID()}`
const LEGACY = `auth-legacy-${randomUUID()}`
const NAMES = ['CODEX_HUB_TOKEN', 'CODEX_HUB_LEGACY_TOKEN', 'CODEX_HUB_LEGACY_UNTIL'].flatMap(
  (s) => [`AGENTHYDRA_${s}`, `CCMANAGERUI_${s}`],
)
const saved = new Map(NAMES.map((n) => [n, process.env[n]]))

/** The hub's settings: the admin token always, the legacy token and its end when given. */
function settings(s: { legacy?: boolean; until?: string } = {}): void {
  for (const n of NAMES) delete process.env[n]
  process.env.AGENTHYDRA_CODEX_HUB_TOKEN = ADMIN
  if (s.legacy) process.env.AGENTHYDRA_CODEX_HUB_LEGACY_TOKEN = LEGACY
  if (s.until) process.env.AGENTHYDRA_CODEX_HUB_LEGACY_UNTIL = s.until
}
settings()

// A copy with its own router: a request through the shared app would build its matcher and stop every later test
// file from registering routes.
const http = new Hono().route('/', app)
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (req, srv) => http.fetch(req, srv),
  websocket,
})

const SUFFIX = randomUUID().slice(0, 6)
let named = 0
/** A PC name no other test, here or in another file, uses. */
const nameOf = (base: string) => `${base}-${SUFFIX}-${++named}`
const installId = () => `install-${randomUUID()}`
const sockets: WebSocket[] = []
const keys = new Set<string>()
/** A PC with a token of its own, bound to a fresh install id; its folder is removed at the end. */
const pcNamed = (base: string, opts?: Parameters<typeof testPc>[1]): TestPc => {
  const p = testPc(nameOf(base), opts)
  keys.add(p.key)
  return p
}

beforeEach(() => {
  settings()
  delete codexHubTestHooks.beforeRelayOpen
})

afterAll(() => {
  for (const ws of sockets) ws.close()
  server.stop(true)
  for (const key of keys) rmSync(join(CODEX_HUB_DIR, key), { recursive: true, force: true })
  delete codexHubTestHooks.beforeRelayOpen
  for (const [n, v] of saved) {
    if (v === undefined) delete process.env[n]
    else process.env[n] = v
  }
  for (const spy of consoles) spy.mockRestore()
})

// --- requests -------------------------------------------------------------------------------------

interface Answer {
  status: number
  /** The answer's JSON, as the test that asked reads it. */
  json: any
  text: string
}

async function call(
  method: string,
  path: string,
  o: { bearer?: string | null; install?: string | null; body?: unknown } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {}
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`
  if (o.install) headers['x-codex-hub-install'] = o.install
  if (o.body !== undefined) headers['content-type'] = 'application/json'
  const res = await http.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
    }),
  )
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    // a page, or nothing
  }
  return { status: res.status, json, text }
}

const thread = (title: string) => ({
  id: randomUUID(),
  name: title,
  preview: title,
  cwd: null,
  updatedAt: 1_792_310_400,
  source: 'cli',
  path: null,
})

/** A push with PC `p`'s token and install id (or those given), naming `pc` in its body. */
const push = (
  p: { token: string; install: string | null },
  pc: string,
  o: { install?: string | null } = {},
) =>
  call('POST', '/api/codex-hub/push', {
    bearer: p.token,
    install: o.install === undefined ? p.install : o.install,
    body: { pc, threads: [thread(`A chat from ${pc}`)] },
  })

const manifestText = (key: string) =>
  readFileSync(join(CODEX_HUB_DIR, key, 'manifest.json'), 'utf8')
const manifestOf = (key: string) => readCodexHubManifest(join(CODEX_HUB_DIR, key))
const build = (bearer: string | null, install?: string | null) =>
  call('GET', '/api/codex-hub/pusher?platform=linux-x64', { bearer, install })
const asPc = (p: { token: string; install: string | null }): Record<string, string> => ({
  authorization: `Bearer ${p.token}`,
  ...(p.install ? { 'x-codex-hub-install': p.install } : {}),
})
const asOwner = { authorization: `Bearer ${ADMIN}` }

/** A folder of copies a PC pushed with the shared token of before, from install `install` (none: no id). */
function seed(pc: string, install: string | null, pushedAt?: string): string {
  const key = hubPcKey(pc)!
  keys.add(key)
  expect(acceptCodexHubPush({ pc, threads: [] }, CODEX_HUB_DIR, undefined, install)).toMatchObject({
    ok: true,
  })
  if (pushedAt) {
    const file = join(CODEX_HUB_DIR, key, 'manifest.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), pushedAt }))
  }
  return key
}

async function until(ok: () => boolean, what = 'the condition'): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

// --- sockets --------------------------------------------------------------------------------------

/** A WebSocket to the hub: whether it opened (false once it closes or errs first), and how it closed. */
function socket(path: string, headers: Record<string, string>) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, {
    headers,
  } as unknown as string[])
  sockets.push(ws)
  const opened = Promise.withResolvers<boolean>()
  const closed = Promise.withResolvers<{ code: number; reason: string }>()
  ws.addEventListener('open', () => opened.resolve(true))
  ws.addEventListener('error', () => opened.resolve(false))
  ws.addEventListener('close', (e) => {
    opened.resolve(false)
    closed.resolve({ code: e.code, reason: e.reason })
  })
  return { ws, opened: opened.promise, closed: closed.promise }
}

/** PC `p`'s relay socket, as its pusher keeps it open, once the hub has registered it. */
async function relayOf(p: TestPc) {
  const s = socket(`/api/codex-hub/relay?pc=${encodeURIComponent(p.pc)}`, asPc(p))
  expect(await s.opened).toBe(true)
  await until(() => relayPcToken(p.key) === p.id, `${p.pc}'s relay`)
  return s
}

/** The HTTP answer to an upgrade the hub refuses: it never gets as far as a socket. */
async function refusedUpgrade(path: string, headers: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    headers: {
      ...headers,
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': randomBytes(16).toString('base64'),
      'sec-websocket-version': '13',
    },
  })
  const text = await res.text()
  let code: string | undefined
  try {
    code = JSON.parse(text).code
  } catch {
    code = undefined
  }
  return { status: res.status, code }
}

/** Sends a request line as given, unnormalized, and answers the status the server sent. */
async function rawStatus(method: string, target: string): Promise<number> {
  const head = Promise.withResolvers<string>()
  let got = ''
  const conn = await Bun.connect({
    hostname: '127.0.0.1',
    port: server.port!,
    socket: {
      data(_s, data) {
        got += Buffer.from(data).toString('latin1')
        if (got.includes('\r\n')) head.resolve(got)
      },
      close() {
        head.resolve(got)
      },
      error(_s, error) {
        head.reject(error)
      },
    },
  })
  conn.write(
    `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nAuthorization: Bearer ${ADMIN}\r\n` +
      'Content-Length: 0\r\nConnection: close\r\n\r\n',
  )
  const line = await head.promise
  conn.end()
  return Number(/^HTTP\/1\.1 (\d{3})/.exec(line)?.[1])
}

// --- the pairing page -------------------------------------------------------------------------------

const STATE = 'c'.repeat(32)
const PORT = 49152

/** The pairing page for `pc`, as the tray opens it, and the codes and confirmation it holds. */
async function pairPage(q: Record<string, string> & { pc: string }) {
  const query = new URLSearchParams({ port: String(PORT), state: STATE, ...q })
  const res = await http.fetch(new Request(`http://127.0.0.1/codex-hub/pair?${query}`))
  const html = await res.text()
  const fromHtml = (s: string) =>
    s.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
  return {
    status: res.status,
    html,
    csp: res.headers.get('content-security-policy'),
    title: fromHtml(/<h1>([^<]*)<\/h1>/.exec(html)?.[1] ?? ''),
    text: fromHtml(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' '),
    codes: [...html.matchAll(/name="code" value="([0-9a-f]{64})"/g)].map((m) => m[1]!),
    confirm: /name="confirm" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? null,
  }
}

/** The tray's redeem of a page's code with a token it made, from its install id. */
const redeem = (code: string, t = newPcToken(), install: string | null = installId()) =>
  call('POST', '/api/codex-hub/redeem', { install, body: { code, id: t.id, hash: t.hash } })

// --- the push ---------------------------------------------------------------------------------------

test("a PC token pushes its own chats; a body naming another PC writes under the token's PC, and that PC's copies stay byte for byte", async () => {
  const a = pcNamed('Push-A')
  const b = pcNamed('Push-B')
  expect(await push(a, a.pc)).toMatchObject({ status: 200, json: { pc: a.pc, stored: 0 } })
  expect(await push(b, b.pc)).toMatchObject({ status: 200 })
  const bBefore = manifestText(b.key)

  for (let i = 0; i < 2; i++)
    expect(await push(a, b.pc)).toMatchObject({ status: 200, json: { pc: a.pc } })
  expect(manifestText(b.key)).toBe(bBefore)
  expect(manifestOf(a.key)).toMatchObject({ pc: a.pc, install: a.install })
  expect(said.filter((l) => l.includes(`${a.pc}'s token pushed as "${b.pc}"`))).toEqual([
    `[codex-hub] ${a.pc}'s token pushed as "${b.pc}"; kept as ${a.pc}`,
  ])

  // A name with the token's key keeps its spelling.
  const spelled = a.pc.toUpperCase().replaceAll('-', ' ')
  expect(hubPcKey(spelled)).toBe(a.key)
  expect(await push(a, spelled)).toMatchObject({ status: 200, json: { pc: spelled } })
  expect(manifestOf(a.key)?.pc).toBe(spelled)
})

test('a PC token needs its install id: none is 400, another is 409, and a token from add binds the first it is sent with', async () => {
  const a = pcNamed('Install')
  expect(await push(a, a.pc, { install: null })).toMatchObject({
    status: 400,
    json: { code: 'install-required' },
  })
  expect(await push(a, a.pc, { install: installId() })).toMatchObject({
    status: 409,
    json: { code: 'install-mismatch' },
  })
  expect(existsSync(join(CODEX_HUB_DIR, a.key))).toBe(false)

  const t = newPcToken()
  const pc = nameOf('Added')
  const added = await call('POST', '/api/codex-relay/admin/pcs', {
    bearer: ADMIN,
    body: { pc, id: t.id, hash: t.hash },
  })
  expect(added).toMatchObject({ status: 200, json: { pc, key: hubPcKey(pc), id: t.id } })
  keys.add(added.json.key)
  // Unbound, it answers whoami without an install id; the first push with one binds it.
  expect(await call('GET', '/api/codex-hub/whoami', { bearer: t.token })).toMatchObject({
    status: 200,
    json: { pc, key: added.json.key, id: t.id },
  })
  const first = installId()
  expect(await push({ token: t.token, install: first }, pc)).toMatchObject({ status: 200 })
  expect(
    (await call('GET', '/api/codex-hub/whoami', { bearer: t.token, install: first })).json,
  ).toEqual({ pc, key: added.json.key, id: t.id, install: first })
  expect(await push({ token: t.token, install: installId() }, pc)).toMatchObject({
    status: 409,
    json: { code: 'install-mismatch' },
  })
})

// --- the relay --------------------------------------------------------------------------------------

test("a PC token's relay with another PC's name in ?pc= opens as its own PC, and the other PC's relay stays", async () => {
  const a = pcNamed('Relay-A')
  const b = pcNamed('Relay-B')
  const relayB = await relayOf(b)
  const s = socket(`/api/codex-hub/relay?pc=${encodeURIComponent(b.pc)}`, asPc(a))
  expect(await s.opened).toBe(true)
  await until(() => relayPcToken(a.key) === a.id, "A's relay")
  expect(relayPcToken(b.key)).toBe(b.id)
  s.ws.close()
  relayB.ws.close()
  await until(() => !relayPcs().has(a.key) && !relayPcs().has(b.key), 'both relays gone')
})

test('every refusal of a relay is an HTTP answer before the upgrade: the socket never opens', async () => {
  settings({ legacy: true })
  const a = pcNamed('Refused')
  const revoked = pcNamed('Refused-Revoked')
  revokePc(revoked.key)
  const path = (pc: string) => `/api/codex-hub/relay?pc=${encodeURIComponent(pc)}`
  const cases: [string, string, Record<string, string>, number, string][] = [
    ['no install id', path(a.pc), asPc({ token: a.token, install: null }), 400, 'install-required'],
    [
      'another install id',
      path(a.pc),
      asPc({ ...a, install: installId() }),
      409,
      'install-mismatch',
    ],
    ['a revoked token', path(revoked.pc), asPc(revoked), 401, 'revoked'],
    [
      'an unknown token',
      path(a.pc),
      asPc({ ...newPcToken(), install: a.install }),
      401,
      'unknown-token',
    ],
    [
      'the legacy token for a key that is not pending',
      path(a.pc),
      asPc({ token: LEGACY, install: a.install }),
      401,
      'unauthorized',
    ],
    [
      'no ?pc on the legacy path',
      '/api/codex-hub/relay',
      asPc({ token: LEGACY, install: a.install }),
      400,
      'bad-request',
    ],
    [
      'the admin token',
      path(a.pc),
      asPc({ token: ADMIN, install: a.install }),
      401,
      'unauthorized',
    ],
  ]
  for (const [why, target, headers, status, code] of cases) {
    expect({ why, ...(await refusedUpgrade(target, headers)) }).toEqual({ why, status, code })
    const s = socket(target, headers)
    expect({ why, opened: await s.opened }).toEqual({ why, opened: false })
  }
  expect(relayPcs().has(a.key)).toBe(false)
  expect(relayPcs().has(revoked.key)).toBe(false)
})

// --- builds and whoami --------------------------------------------------------------------------------

test('the builds take a PC token (its install id is checked when sent), and the legacy token only while a PC is pending', async () => {
  const a = pcNamed('Builds')
  // No build is put on this hub: a PC that gets this far is told there is none.
  for (const res of [await build(a.token), await build(a.token, a.install)])
    expect(res).toMatchObject({ status: 404, json: { code: 'not-found' } })
  expect(
    await call('GET', '/api/codex-hub/tray/download?platform=linux-x64', { bearer: a.token }),
  ).toMatchObject({ status: 404 })
  expect(await build(a.token, installId())).toMatchObject({
    status: 409,
    json: { code: 'install-mismatch' },
  })
  const revoked = pcNamed('Builds-Revoked')
  revokePc(revoked.key)
  expect(await build(revoked.token)).toMatchObject({ status: 401, json: { code: 'revoked' } })
  expect(await build(ADMIN)).toMatchObject({
    status: 401,
    json: { error: 'unauthorized', code: 'unauthorized' },
  })
  expect(await build(LEGACY)).toMatchObject({ status: 401, json: { code: 'unauthorized' } })

  settings({ legacy: true })
  expect(pendingKeys()).toEqual([])
  expect(await build(LEGACY)).toMatchObject({ status: 401, json: { code: 'unauthorized' } })
  const key = seed(nameOf('Builds-Old'), installId())
  try {
    expect(pendingKeys()).toEqual([key])
    expect(await build(LEGACY)).toMatchObject({ status: 404, json: { code: 'not-found' } })
    settings({ legacy: true, until: '2026-01-01T00:00:00Z' })
    expect(await build(LEGACY)).toMatchObject({ status: 401, json: { code: 'unauthorized' } })
  } finally {
    rmSync(join(CODEX_HUB_DIR, key), { recursive: true, force: true })
  }
})

test('whoami answers what the hub has a PC token under, and nothing for the legacy or the admin token', async () => {
  const a = pcNamed('Whoami')
  expect(
    await call('GET', '/api/codex-hub/whoami', { bearer: a.token, install: a.install }),
  ).toEqual(
    expect.objectContaining({
      status: 200,
      json: { pc: a.pc, key: a.key, id: a.id, install: a.install },
    }),
  )
  settings({ legacy: true })
  const key = seed(nameOf('Whoami-Old'), installId())
  try {
    for (const bearer of [LEGACY, ADMIN, null])
      expect(await call('GET', '/api/codex-hub/whoami', { bearer })).toMatchObject({
        status: 401,
        json: { code: 'unauthorized' },
      })
  } finally {
    rmSync(join(CODEX_HUB_DIR, key), { recursive: true, force: true })
  }
})

// --- Desk's end and the admin API ---------------------------------------------------------------------

test("Desk's end and the admin API refuse a PC token and the legacy token, and take the admin token", async () => {
  settings({ legacy: true })
  const a = pcNamed('Owner')
  const relay = await relayOf(a)
  const desk = `/api/codex-relay/${a.key}/app-server`
  for (const bearer of [a.token, LEGACY]) {
    const headers = asPc({ token: bearer, install: a.install })
    expect(
      await call('GET', '/api/codex-relay/admin/pcs', { bearer, install: a.install }),
    ).toMatchObject({ status: 401, json: { error: 'unauthorized', code: 'unauthorized' } })
    expect(
      await call('POST', '/api/codex-relay/admin/pcs', {
        bearer,
        body: { pc: nameOf('Not-Added'), ...newPcToken() },
      }),
    ).toMatchObject({ status: 401 })
    expect(await refusedUpgrade(desk, headers)).toEqual({ status: 401, code: 'unauthorized' })
    expect(await socket(desk, headers).opened).toBe(false)
  }
  const list = await call('GET', '/api/codex-relay/admin/pcs', { bearer: ADMIN })
  expect(list).toMatchObject({ status: 200, json: { legacy: { open: true } } })
  expect(list.json.pcs.find((r: { key: string }) => r.key === a.key)).toMatchObject({
    pc: a.pc,
    state: 'token',
    tokenId: a.id,
    pairedBy: 'cli',
    install: a.install,
    relay: true,
  })
  const session = socket(desk, asOwner)
  expect(await session.opened).toBe(true)
  session.ws.close()
  relay.ws.close()
})

// --- the legacy token ---------------------------------------------------------------------------------

test('the legacy token pushes and relays for a pending key with its install id, and for nothing else', async () => {
  settings({ legacy: true })
  const install = installId()
  const pc = nameOf('Legacy')
  const key = seed(pc, install)
  const bare = seed(nameOf('Legacy-Bare'), null)
  const since = legacyWindow().since!
  const stale = seed(
    nameOf('Legacy-Stale'),
    installId(),
    new Date(Date.parse(since) - 31 * 86_400_000).toISOString(),
  )
  const owned = pcNamed('Legacy-Owned')
  const fresh = nameOf('Legacy-New')
  expect(pendingKeys()).toEqual([key])
  const legacyAs = (i: string | null) => ({ token: LEGACY, install: i })
  try {
    expect(await push(legacyAs(install), pc)).toMatchObject({ status: 200, json: { pc } })
    expect(manifestOf(key)?.install).toBe(install)
    const relay = socket(`/api/codex-hub/relay?pc=${pc}`, asPc(legacyAs(install)))
    expect(await relay.opened).toBe(true)
    await until(() => relayPcToken(key) === 'legacy', 'the legacy relay')
    relay.ws.close()
    await until(() => !relayPcs().has(key), 'the legacy relay gone')

    const before = manifestText(key)
    const refused: [string, string, string | null][] = [
      ['another install id', pc, installId()],
      ['no install id', pc, null],
      ['a manifest without an install id', manifestOf(bare)!.pc, install],
      ['a stale key', manifestOf(stale)!.pc, manifestOf(stale)!.install!],
      ['a key with a record', owned.pc, owned.install],
      ['a new name', fresh, install],
    ]
    for (const [why, name, i] of refused) {
      expect({ why, ...(await push(legacyAs(i), name)) }).toMatchObject({
        why,
        status: 401,
        json: { code: 'unauthorized' },
      })
      expect({
        why,
        ...(await refusedUpgrade(`/api/codex-hub/relay?pc=${name}`, asPc(legacyAs(i)))),
      }).toEqual({
        why,
        status: 401,
        code: 'unauthorized',
      })
    }
    expect(manifestText(key)).toBe(before)
    expect(existsSync(join(CODEX_HUB_DIR, hubPcKey(fresh)!))).toBe(false)
    expect(existsSync(join(CODEX_HUB_DIR, owned.key))).toBe(false)
  } finally {
    for (const k of [key, bare, stale])
      rmSync(join(CODEX_HUB_DIR, k), { recursive: true, force: true })
  }
})

test('the exchange, through the route: the legacy relay closes with 4403, the legacy token is refused for that key, and the new token pushes', async () => {
  settings({ legacy: true })
  const install = installId()
  const pc = nameOf('Exchange')
  const key = seed(pc, install)
  try {
    const relay = socket(`/api/codex-hub/relay?pc=${pc}`, asPc({ token: LEGACY, install }))
    expect(await relay.opened).toBe(true)
    await until(() => relayPcToken(key) === 'legacy', 'the legacy relay')
    const t = newPcToken()
    const body = { id: t.id, hash: t.hash }
    expect(
      await call('POST', '/api/codex-hub/exchange', { bearer: LEGACY, install, body }),
    ).toMatchObject({ status: 200, json: { pc, key, id: t.id } })
    expect(await relay.closed).toEqual({
      code: RELAY_REFUSED,
      reason: 'This PC moved to a token of its own.',
    })
    // A repeat after a lost answer gets the same one.
    expect(
      await call('POST', '/api/codex-hub/exchange', { bearer: LEGACY, install, body }),
    ).toMatchObject({ status: 200, json: { pc, key, id: t.id } })
    expect(await push({ token: LEGACY, install }, pc)).toMatchObject({ status: 401 })
    expect(
      await refusedUpgrade(`/api/codex-hub/relay?pc=${pc}`, asPc({ token: LEGACY, install })),
    ).toEqual({ status: 401, code: 'unauthorized' })
    expect(await push({ token: t.token, install }, pc)).toMatchObject({ status: 200, json: { pc } })
    // Only the legacy token, with the window open, may exchange.
    for (const bearer of [t.token, ADMIN, null])
      expect(
        await call('POST', '/api/codex-hub/exchange', {
          bearer,
          install,
          body: { id: newPcToken().id, hash: newPcToken().hash },
        }),
      ).toMatchObject({ status: 401, json: { code: 'unauthorized' } })
  } finally {
    rmSync(join(CODEX_HUB_DIR, key), { recursive: true, force: true })
  }
})

// --- redeem and retire ------------------------------------------------------------------------------

test("redeem: the page's code is taken once, a repeat gets the same answer, and a code made before the key changed is refused", async () => {
  const pc = nameOf('Redeem')
  const key = hubPcKey(pc)!
  keys.add(key)
  const page = await pairPage({ pc })
  expect(page.codes).toHaveLength(1)
  const t = newPcToken()
  const install = installId()
  expect(await redeem(page.codes[0]!, t, install)).toMatchObject({
    status: 200,
    json: { pc, key, id: t.id },
  })
  expect(await redeem(page.codes[0]!, t, install)).toMatchObject({
    status: 200,
    json: { pc, key, id: t.id },
  })
  expect(await redeem(page.codes[0]!, newPcToken(), install)).toMatchObject({
    status: 401,
    json: { code: 'pair-code' },
  })
  expect(await call('GET', '/api/codex-hub/whoami', { bearer: t.token, install })).toMatchObject({
    status: 200,
    json: { pc, key, id: t.id, install },
  })

  // Two pages that replace its token, opened before either is used: the second is name-changed.
  const replaceCode = async () => {
    const asked = await pairPage({ pc })
    expect(asked.confirm).not.toBeNull()
    const replace = await pairPage({ pc, confirm: asked.confirm! })
    expect(replace.title).toBe(`Replace ${pc}'s token`)
    return replace.codes[0]!
  }
  const first = await replaceCode()
  const second = await replaceCode()
  const u = newPcToken()
  expect(await redeem(first, u, install)).toMatchObject({ status: 200, json: { key, id: u.id } })
  expect(pcByToken(t.token)).toMatchObject({ code: 'unknown-token' })
  expect(await redeem(second, newPcToken(), install)).toMatchObject({
    status: 409,
    json: { code: 'name-changed' },
  })
  // A revoke drops the key's codes: one made before it is unknown.
  const third = await replaceCode()
  expect(revokePc(key)).toMatchObject({ ok: true })
  expect(await redeem(third, newPcToken(), install)).toMatchObject({
    status: 401,
    json: { code: 'pair-code' },
  })

  // A token id in use: id-taken, and the code is still good for the next token.
  const other = nameOf('Redeem-Other')
  keys.add(hubPcKey(other)!)
  const code = (await pairPage({ pc: other })).codes[0]!
  expect(await redeem(code, { ...newPcToken(), id: u.id })).toMatchObject({
    status: 409,
    json: { code: 'id-taken' },
  })
  expect(await redeem(code)).toMatchObject({ status: 200, json: { key: hubPcKey(other) } })
  // No install id, or a body of another shape.
  expect(await redeem(code, newPcToken(), null)).toMatchObject({
    status: 400,
    json: { code: 'install-required' },
  })
  expect(
    await call('POST', '/api/codex-hub/redeem', { install, body: { code: 'nope' } }),
  ).toMatchObject({ status: 400, json: { code: 'bad-request' } })
})

test('retire revokes only the caller, from its own install, and closes its relay with 4403', async () => {
  const a = pcNamed('Retire')
  const b = pcNamed('Retire-Other')
  const relay = await relayOf(a)
  const retire = (install: string | null, body: unknown) =>
    call('POST', '/api/codex-hub/retire', { bearer: a.token, install, body })
  expect(await retire(installId(), {})).toMatchObject({
    status: 409,
    json: { code: 'install-mismatch' },
  })
  expect(pcByToken(a.token)).toMatchObject({ ok: true })
  expect(relayPcToken(a.key)).toBe(a.id)
  for (const body of [
    { renamedTo: 5 },
    { renamedTo: 'x'.repeat(65) },
    { renamedTo: 'x)\n[codex-hub] Office-PC revoked' },
    { renamedTo: 'New\u001b[2K' },
    [],
  ])
    expect(await retire(a.install, body)).toMatchObject({
      status: 400,
      json: { code: 'bad-request' },
    })
  expect(await retire(a.install, { renamedTo: 'New-Name' })).toMatchObject({
    status: 200,
    json: { pc: a.pc, key: a.key, state: 'revoked' },
  })
  expect(await relay.closed).toEqual({
    code: RELAY_REFUSED,
    reason: 'This PC was renamed on the hub.',
  })
  expect(pcByToken(a.token)).toMatchObject({ code: 'revoked', status: 401 })
  expect(await push(a, a.pc)).toMatchObject({ status: 401, json: { code: 'revoked' } })
  expect(await push(b, b.pc)).toMatchObject({ status: 200 })
})

// --- the admin API ------------------------------------------------------------------------------------

test('add: a key in use takes replace, which closes its relay; without it, name-paired', async () => {
  const a = pcNamed('Add')
  const add = (pc: string, replace?: boolean) => {
    const t = newPcToken()
    return call('POST', '/api/codex-relay/admin/pcs', {
      bearer: ADMIN,
      body: { pc, id: t.id, hash: t.hash, ...(replace ? { replace } : {}) },
    }).then((r) => ({ ...r, t }))
  }
  expect(await add(a.pc)).toMatchObject({ status: 409, json: { code: 'name-paired' } })
  settings({ legacy: true })
  const pending = seed(nameOf('Add-Pending'), installId())
  try {
    expect(await add(manifestOf(pending)!.pc)).toMatchObject({
      status: 409,
      json: { code: 'name-paired' },
    })
  } finally {
    rmSync(join(CODEX_HUB_DIR, pending), { recursive: true, force: true })
  }
  const relay = await relayOf(a)
  const replaced = await add(a.pc, true)
  expect(replaced).toMatchObject({ status: 200, json: { pc: a.pc, key: a.key } })
  expect(await relay.closed).toEqual({ code: RELAY_REFUSED, reason: 'This PC was paired again.' })
  expect(await push(a, a.pc)).toMatchObject({ status: 401, json: { code: 'unknown-token' } })
  expect(await push({ token: replaced.t.token, install: installId() }, a.pc)).toMatchObject({
    status: 200,
  })
  const taken = { pc: nameOf('Add-Twin'), id: replaced.t.id, hash: newPcToken().hash }
  expect(
    await call('POST', '/api/codex-relay/admin/pcs', { bearer: ADMIN, body: taken }),
  ).toMatchObject({ status: 409, json: { code: 'id-taken' } })
  expect(
    await call('POST', '/api/codex-relay/admin/pcs', { bearer: ADMIN, body: { pc: 'x', id: 'y' } }),
  ).toMatchObject({ status: 400, json: { code: 'bad-request' } })
})

test("revoke: the relay closes with 4403, Desk's session on it ends, the next push and build check are revoked, and the other PC is untouched", async () => {
  const a = pcNamed('Revoke')
  const b = pcNamed('Revoke-Other')
  const relay = await relayOf(a)
  const relayB = await relayOf(b)
  const session = socket(`/api/codex-relay/${a.key}/app-server`, asOwner)
  expect(await session.opened).toBe(true)
  const revoked = await call('POST', `/api/codex-relay/admin/pcs/${a.key}/revoke`, {
    bearer: ADMIN,
  })
  expect(revoked).toMatchObject({
    status: 200,
    json: { pc: a.pc, key: a.key, state: 'revoked', relayClosed: true },
  })
  expect(await relay.closed).toEqual({
    code: RELAY_REFUSED,
    reason: 'This PC was revoked on the hub.',
  })
  expect((await session.closed).reason).toBe('This PC was revoked on the hub.')
  expect(await push(a, a.pc)).toMatchObject({ status: 401, json: { code: 'revoked' } })
  expect(await build(a.token)).toMatchObject({ status: 401, json: { code: 'revoked' } })
  expect(await call('GET', '/api/codex-hub/whoami', { bearer: a.token })).toMatchObject({
    status: 401,
    json: { code: 'revoked' },
  })
  expect(relayPcToken(b.key)).toBe(b.id)
  expect(await push(b, b.pc)).toMatchObject({ status: 200 })
  relayB.ws.close()

  // A pending key gets a placeholder, which claims its install id: its older folder no longer moves.
  settings({ legacy: true })
  const install = installId()
  const older = seed(nameOf('Revoke-Old'), install, new Date(Date.now() - 3_600_000).toISOString())
  const newer = seed(nameOf('Revoke-New'), install)
  try {
    expect(pendingKeys()).toEqual([newer])
    expect(
      await call('POST', `/api/codex-relay/admin/pcs/${newer}/revoke`, { bearer: ADMIN }),
    ).toMatchObject({ status: 200, json: { state: 'revoked', relayClosed: false } })
    expect(pendingKeys()).toEqual([])
    const rows = (await call('GET', '/api/codex-relay/admin/pcs', { bearer: ADMIN })).json.pcs
    expect(rows.find((r: { key: string }) => r.key === older)).toMatchObject({
      state: 'unpaired',
      why: 'claimed',
    })
    expect(rows.find((r: { key: string }) => r.key === newer)).toMatchObject({
      state: 'revoked',
      revokedWhy: 'revoked by the owner before it moved',
      install,
    })
  } finally {
    for (const k of [older, newer]) rmSync(join(CODEX_HUB_DIR, k), { recursive: true, force: true })
  }
})

test("forget removes a PC's copies and record; a path that is not a key is refused, and .. never reaches the route", async () => {
  const a = pcNamed('Forget')
  expect(await push(a, a.pc)).toMatchObject({ status: 200 })
  const forget = (key: string) =>
    call('DELETE', `/api/codex-relay/admin/pcs/${key}`, { bearer: ADMIN })
  for (const key of ['.pusher', '%252e%252e', 'Forget', 'a%20b', '-x'])
    expect({ key, ...(await forget(key)) }).toMatchObject({
      key,
      status: 400,
      json: { code: 'bad-key' },
    })
  // The URL is resolved before routing, so `..` names the parent path: no route there removes anything.
  for (const target of ['..', '%2e%2e', '%2E%2E', '.%2e'])
    expect({
      target,
      status: await rawStatus('DELETE', `/api/codex-relay/admin/pcs/${target}`),
    }).toEqual({ target, status: 404 })
  expect(existsSync(join(CODEX_HUB_DIR, a.key, 'manifest.json'))).toBe(true)
  expect(existsSync(CODEX_HUB_DIR)).toBe(true)

  expect(await forget(a.key)).toMatchObject({
    status: 200,
    json: { pc: a.pc, key: a.key, removed: true },
  })
  expect(existsSync(join(CODEX_HUB_DIR, a.key))).toBe(false)
  expect(await push(a, a.pc)).toMatchObject({ status: 401, json: { code: 'unknown-token' } })
  expect(await forget(a.key)).toMatchObject({ status: 404, json: { code: 'not-found' } })
  expect(
    await call('POST', `/api/codex-relay/admin/pcs/${a.key}/revoke`, { bearer: ADMIN }),
  ).toMatchObject({
    status: 404,
    json: { code: 'not-found' },
  })
})

// --- races --------------------------------------------------------------------------------------------

/** A push whose body arrives only once `gate` settles, so a test can change the PC's credential meanwhile. */
function gatedPush(p: TestPc, gate: Promise<void>) {
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      await gate
      ctrl.enqueue(
        new TextEncoder().encode(JSON.stringify({ pc: p.pc, threads: [thread('late')] })),
      )
      ctrl.close()
    },
  })
  return http.fetch(
    new Request('http://127.0.0.1/api/codex-hub/push', {
      method: 'POST',
      headers: { ...asPc(p), 'content-type': 'application/json' },
      body,
    }),
  )
}

/** Whether the hub has seen `p`'s token once: its first request is past its checks. */
const used = (p: TestPc) => {
  const r = pcByToken(p.token)
  return r.ok ? !!r.record.firstUsedAt : true
}

test('a push whose body arrives after a revoke is refused, and writes nothing', async () => {
  const a = pcNamed('Race-Revoke')
  const gate = Promise.withResolvers<void>()
  const res = gatedPush(a, gate.promise)
  await until(() => used(a), 'the push past its checks')
  revokePc(a.key)
  gate.resolve()
  const answer = await res
  expect(answer.status).toBe(401)
  expect(((await answer.json()) as { code: string }).code).toBe('revoked')
  expect(existsSync(join(CODEX_HUB_DIR, a.key))).toBe(false)
})

test('a push across a forget recreates no folder', async () => {
  const a = pcNamed('Race-Forget')
  // Its copies from before, put there directly so that the push below is the token's first request.
  acceptCodexHubPush({ pc: a.pc, threads: [] }, CODEX_HUB_DIR, undefined, a.install)
  const gate = Promise.withResolvers<void>()
  const res = gatedPush(a, gate.promise)
  await until(() => used(a), 'the push past its checks')
  expect(
    await call('DELETE', `/api/codex-relay/admin/pcs/${a.key}`, { bearer: ADMIN }),
  ).toMatchObject({ status: 200 })
  gate.resolve()
  const answer = await res
  expect(answer.status).toBe(401)
  expect(((await answer.json()) as { code: string }).code).toBe('unknown-token')
  expect(existsSync(join(CODEX_HUB_DIR, a.key))).toBe(false)
})

test('a relay checked before a revoke and opened after it is closed with 4403 and never registered', async () => {
  const a = pcNamed('Race-Relay')
  const reached = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  codexHubTestHooks.beforeRelayOpen = (key) => {
    if (key !== a.key) return
    reached.resolve()
    return gate.promise
  }
  const s = socket(`/api/codex-hub/relay?pc=${a.pc}`, asPc(a))
  await reached.promise
  revokePc(a.key)
  gate.resolve()
  expect(await s.closed).toEqual({
    code: RELAY_REFUSED,
    reason: "This PC's token is no longer valid on the hub.",
  })
  expect(relayPcs().has(a.key)).toBe(false)
})

test('a re-pair while the old socket is mid-upgrade: the old one is closed, and the new link stays registered', async () => {
  const a = pcNamed('Race-Repair')
  const reached = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  codexHubTestHooks.beforeRelayOpen = (key, tokenId) => {
    if (key !== a.key || tokenId !== a.id) return
    reached.resolve()
    return gate.promise
  }
  const old = socket(`/api/codex-hub/relay?pc=${a.pc}`, asPc(a))
  await reached.promise
  const n = newPcToken()
  expect(
    registerPcToken({ pc: a.pc, id: n.id, hash: n.hash, install: a.install, replace: true }),
  ).toMatchObject({ ok: true })
  const fresh = socket(
    `/api/codex-hub/relay?pc=${a.pc}`,
    asPc({ token: n.token, install: a.install }),
  )
  expect(await fresh.opened).toBe(true)
  await until(() => relayPcToken(a.key) === n.id, 'the new link')
  gate.resolve()
  expect((await old.closed).code).toBe(RELAY_REFUSED)
  expect(relayPcToken(a.key)).toBe(n.id)
  expect(fresh.ws.readyState).toBe(WebSocket.OPEN)
  fresh.ws.close()
})

test("Desk's end refuses a legacy link that outlived the window with 4004, and closes the link with 4403", async () => {
  settings({ legacy: true })
  const install = installId()
  const pc = nameOf('Desk-Guard')
  const key = seed(pc, install)
  try {
    const relay = socket(`/api/codex-hub/relay?pc=${pc}`, asPc({ token: LEGACY, install }))
    expect(await relay.opened).toBe(true)
    await until(() => relayPcToken(key) === 'legacy', 'the legacy relay')
    // The window ends with the link still open: nothing closes it until Desk asks for a session.
    settings({ legacy: true, until: '2026-01-01T00:00:00Z' })
    expect(relayPcToken(key)).toBe('legacy')
    const session = socket(`/api/codex-relay/${key}/app-server`, asOwner)
    expect(await session.closed).toEqual({
      code: 4004,
      reason: 'That PC is not connected to the Codex hub now.',
    })
    expect(await relay.closed).toEqual({
      code: RELAY_REFUSED,
      reason: "This PC's token is no longer valid on the hub.",
    })
    expect(relayPcs().has(key)).toBe(false)
  } finally {
    rmSync(join(CODEX_HUB_DIR, key), { recursive: true, force: true })
  }
})

// --- the pairing page ---------------------------------------------------------------------------------

test('the page for each state of a key: free, revoked, unpaired, in use with a token, and in use pending', async () => {
  const free = nameOf('Page-Free')
  const freePage = await pairPage({ pc: free })
  expect(freePage).toMatchObject({ status: 200, title: `Connect ${free}` })
  expect(freePage.text).toContain(
    `The Codex Hub app on this PC gets a token of its own for ${free}.`,
  )
  expect(freePage.codes).toHaveLength(1)
  expect(freePage.confirm).toBeNull()
  expect(freePage.csp).toContain(`form-action 'self' http://127.0.0.1:${PORT}/paired`)
  expect(freePage.text).toContain('Only use this when you opened it from the Codex Hub app')

  const revoked = pcNamed('Page-Revoked')
  revokePc(revoked.key)
  const revokedPage = await pairPage({ pc: revoked.pc })
  expect(revokedPage.text).toMatch(
    new RegExp(
      `${revoked.pc} was revoked on \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC \\(revoked by the owner\\)\\. Connect gives it a new token\\.`,
    ),
  )
  expect(revokedPage.codes).toHaveLength(1)

  const bare = nameOf('Page-Bare')
  seed(bare, null)
  const barePage = await pairPage({ pc: bare })
  expect(barePage.text).toContain(`${bare} has copies here from before (last push `)
  expect(barePage.text).toContain(
    'and no token. Connect gives it a token, and its first push replaces those copies.',
  )
  expect(barePage.codes).toHaveLength(1)

  // A rename: the page says what the app does about the old name.
  const renamed = await pairPage({ pc: free, from: 'Old-Name' })
  expect(renamed.text).toContain(
    `This renames Old-Name to ${free} on the hub. The app retires Old-Name's token once it has connected; Old-Name's copies stay until you forget them.`,
  )

  const owned = pcNamed('Page-Owned')
  const ownedPage = await pairPage({ pc: owned.pc })
  expect(ownedPage.title).toBe(`Connect ${owned.pc}`)
  expect(ownedPage.text).toMatch(
    new RegExp(
      `${owned.pc} is already on this hub: paired \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC \\(on the command line\\); no push yet; offline\\.`,
    ),
  )
  expect(ownedPage.text).toContain(`If this is another PC, connect it as ${owned.pc}-2.`)
  expect(ownedPage.text).toContain(`This is another PC: connect it as ${owned.pc}-2`)
  expect(ownedPage.text).toContain(`This is ${owned.pc} itself, set up again: replace its token…`)
  expect(ownedPage.codes).toHaveLength(1)
  expect(ownedPage.confirm).not.toBeNull()
  expect(ownedPage.html).toContain('<form method="get" action="">')

  settings({ legacy: true })
  const old = nameOf('Page-Pending')
  const oldKey = seed(old, installId())
  try {
    const pendingPage = await pairPage({ pc: old })
    expect(pendingPage.text).toContain(
      `${old} is already on this hub: it pushes with the old shared token; last push `,
    )
    expect(pendingPage.text).toContain('; online now.')
    const replace = await pairPage({ pc: old, confirm: pendingPage.confirm! })
    expect(replace.title).toBe(`Replace ${old}'s token`)
    expect(replace.text).toContain(`${old} pushes with the old shared token. Its last push was `)
    expect(replace.text).toContain(
      `${old}'s current token stops working at once, its relay closes, and any Desk session on it ends.`,
    )
    // That code replaces the legacy token, and only that.
    const t = newPcToken()
    const install = manifestOf(oldKey)!.install!
    expect(await redeem(replace.codes[0]!, t, install)).toMatchObject({
      status: 200,
      json: { key: oldKey },
    })
    expect(pcByToken(t.token)).toMatchObject({ ok: true, record: { pairedBy: 'page', install } })
  } finally {
    rmSync(join(CODEX_HUB_DIR, oldKey), { recursive: true, force: true })
  }

  for (const page of [freePage, revokedPage, barePage, renamed, ownedPage])
    for (const secret of [ADMIN, LEGACY, 'chp_']) expect(page.html).not.toContain(secret)
})

test('the replace step: a confirmation is used once, a link past until has expired, and a key that changed meanwhile gets its page as it is', async () => {
  const a = pcNamed('Page-Confirm')
  const asked = await pairPage({ pc: a.pc })
  const replace = await pairPage({ pc: a.pc, confirm: asked.confirm! })
  expect(replace).toMatchObject({ status: 200, title: `Replace ${a.pc}'s token` })
  expect(replace.text).toContain('Connect and replace')
  expect(replace.text).toContain(
    `${a.pc}'s copies on the hub stay, and this PC's pushes replace them.`,
  )
  expect(replace.codes).toHaveLength(1)

  const used = await pairPage({ pc: a.pc, confirm: asked.confirm! })
  expect(used).toMatchObject({ status: 400, codes: [] })
  expect(used.text).toContain(
    'This confirmation was used already or has expired. Choose Connect this PC in the Codex Hub app again.',
  )
  // Bound to the tray's state and port.
  const other = await pairPage({ pc: a.pc })
  expect(
    await pairPage({ pc: a.pc, confirm: other.confirm!, state: 'd'.repeat(32) }),
  ).toMatchObject({
    status: 400,
    codes: [],
  })
  const later = await pairPage({ pc: a.pc })
  expect(
    await pairPage({ pc: a.pc, confirm: later.confirm!, port: String(PORT + 1) }),
  ).toMatchObject({
    status: 400,
    codes: [],
  })

  // Paired again between the two steps: the page for the key as it is now, which asks again.
  const before = await pairPage({ pc: a.pc })
  const n = newPcToken()
  expect(
    registerPcToken({ pc: a.pc, id: n.id, hash: n.hash, install: a.install, replace: true }),
  ).toMatchObject({ ok: true })
  const after = await pairPage({ pc: a.pc, confirm: before.confirm! })
  expect(after).toMatchObject({ status: 200, title: `Connect ${a.pc}` })
  expect(after.text).toContain(`${a.pc} is already on this hub: `)
  expect(after.confirm).not.toBeNull()
  // A revoke drops the key's confirmations with its codes.
  const dropped = await pairPage({ pc: a.pc })
  revokePc(a.key)
  expect(await pairPage({ pc: a.pc, confirm: dropped.confirm! })).toMatchObject({
    status: 400,
    codes: [],
  })

  const expired = await pairPage({ pc: a.pc, until: String(Math.floor(Date.now() / 1000) - 1) })
  expect(expired).toMatchObject({ status: 400, codes: [] })
  expect(expired.text).toContain(
    'This pairing link has expired. Choose Connect this PC in the Codex Hub app again.',
  )
  expect(expired.text).toContain("the PC's clock is probably behind the hub's")
  const bad: Record<string, string>[] = [
    { until: 'soon' },
    { pc: '' },
    { pc: 'x'.repeat(65) },
    { pc: 'Name\n[codex-hub] forged' },
    { from: 'y'.repeat(65) },
    { from: 'Old\u001b[2K' },
  ]
  for (const q of bad) expect((await pairPage({ pc: a.pc, ...q })).status).toBe(400)
})

test('the page never follows install=: only the fresh code and confirmation differ', async () => {
  const a = pcNamed('Page-Install')
  const blank = (html: string) => html.replace(/value="[0-9a-f]{64}"/g, 'value="…"')
  const plain = await pairPage({ pc: a.pc })
  const asked = await pairPage({ pc: a.pc, install: a.install! })
  expect(asked.html).not.toBe(plain.html)
  expect(blank(asked.html)).toBe(blank(plain.html))
  const free = nameOf('Page-Install-Free')
  expect(blank((await pairPage({ pc: free, install: installId() })).html)).toBe(
    blank((await pairPage({ pc: free })).html),
  )
})

test('<pc>-N is the first free N, and its code redeems to that key', async () => {
  const a = pcNamed('Page-N')
  const two = testPc(`${a.pc}-2`)
  keys.add(two.key)
  const page = await pairPage({ pc: a.pc })
  expect(page.text).toContain(`connect it as ${a.pc}-3`)
  const t = newPcToken()
  const install = installId()
  expect(await redeem(page.codes[0]!, t, install)).toMatchObject({
    status: 200,
    json: { pc: `${a.pc}-3`, key: `${a.key}-3`, id: t.id },
  })
  keys.add(`${a.key}-3`)
  // The PC it was offered beside keeps its token.
  expect(pcByToken(a.token)).toMatchObject({ ok: true, key: a.key })
  // A long name is cut to 58 characters before its -N.
  const long = `${'L'.repeat(70)}`.slice(0, 64)
  const longKey = hubPcKey(long)!
  keys.add(longKey)
  expect(registerPcToken({ pc: long, ...newPcToken(), install: installId() })).toMatchObject({
    ok: true,
  })
  expect((await pairPage({ pc: long })).text).toContain(`connect it as ${'L'.repeat(58)}-2`)
})

// --- the log and the contract -------------------------------------------------------------------------

test('nothing the hub logged while this file ran holds a token, a code, a hash or the admin or legacy token', () => {
  const all = said.join('\n')
  expect(all).toContain('[codex-hub] refused')
  expect(all).not.toMatch(/[0-9a-f]{64}/)
  expect(all).not.toMatch(/chp_[0-9a-f]{16}_/)
  expect(all).not.toContain(ADMIN)
  expect(all).not.toContain(LEGACY)
})

interface ContractCase {
  name: string
  method: 'GET' | 'POST'
  path: string
  bearer: 'none' | 'pc' | 'pc-revoked' | 'pc-unknown' | 'admin' | 'legacy'
  install: 'bound' | 'other' | 'none'
  body?: 'valid' | 'bad'
  setup?: 'pending' | 'nothing-pending' | 'code' | 'code-used'
  want: { status: number; code?: string }
}

// How each case is set up, here and in the tray's TestContract. Each case has a PC name
// of its own and a fresh install id, `bound`; `other` is another. The legacy token is set, and the window open, for
// every case. bearer `pc` and `pc-revoked` are that PC's token, registered with `bound` (and revoked); `pc-unknown`
// is a token never registered. setup `pending` leaves a folder for the PC whose manifest names `bound`, pushed now;
// `nothing-pending` leaves no pending folder; `code` is a code from the page for the PC; `code-used` is one another
// token has redeemed. body `valid` is { code, id, hash } for redeem (a code the hub never made without a setup),
// { id, hash } for exchange and {} for retire; `bad` is { code: 'nope', id, hash }, { id: 'x' } and { renamedTo: 5 }.
test('codex-hub-tray/testdata/contract.json: every case answers what the tray expects', async () => {
  settings({ legacy: true })
  const cases = contract as ContractCase[]
  expect(cases.length).toBeGreaterThan(30)
  for (const c of cases) {
    const pc = nameOf('Contract')
    const key = hubPcKey(pc)!
    keys.add(key)
    const bound = installId()
    const install = { bound, other: installId(), none: null }[c.install]
    let bearer: string | null = null
    if (c.bearer === 'pc' || c.bearer === 'pc-revoked') {
      const p = testPc(pc, { install: bound })
      if (c.bearer === 'pc-revoked') revokePc(p.key)
      bearer = p.token
    } else if (c.bearer === 'pc-unknown') bearer = newPcToken().token
    else if (c.bearer === 'admin') bearer = ADMIN
    else if (c.bearer === 'legacy') bearer = LEGACY
    if (c.setup === 'pending') seed(pc, bound)
    if (c.setup === 'nothing-pending')
      expect({ case: c.name, pending: pendingKeys() }).toEqual({ case: c.name, pending: [] })
    let code = randomBytes(32).toString('hex')
    if (c.setup === 'code' || c.setup === 'code-used') {
      code = (await pairPage({ pc })).codes[0]!
      if (c.setup === 'code-used')
        expect((await redeem(code, newPcToken(), bound)).status).toBe(200)
    }
    const t = newPcToken()
    const bodies: Record<string, { valid: unknown; bad: unknown }> = {
      '/api/codex-hub/redeem': {
        valid: { code, id: t.id, hash: t.hash },
        bad: { code: 'nope', id: t.id, hash: t.hash },
      },
      '/api/codex-hub/exchange': { valid: { id: t.id, hash: t.hash }, bad: { id: 'x' } },
      '/api/codex-hub/retire': { valid: {}, bad: { renamedTo: 5 } },
    }
    const body = c.body ? bodies[c.path]![c.body] : undefined
    try {
      const res = await call(c.method, c.path, { bearer, install, body })
      expect({
        case: c.name,
        status: res.status,
        ...(c.want.code ? { code: res.json?.code } : {}),
      }).toEqual({
        case: c.name,
        ...c.want,
      })
    } finally {
      rmSync(join(CODEX_HUB_DIR, key), { recursive: true, force: true })
    }
  }
  expect(pendingKeys()).toEqual([])
})

test('the test made no folder it did not remove, and left no relay open', async () => {
  for (const ws of sockets) ws.close()
  await until(() => [...keys].every((k) => !relayPcs().has(k)), 'every relay closed')
  for (const key of keys) rmSync(join(CODEX_HUB_DIR, key), { recursive: true, force: true })
  expect(pendingKeys()).toEqual([])
})
