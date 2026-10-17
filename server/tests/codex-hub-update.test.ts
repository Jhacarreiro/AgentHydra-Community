// server/tests/codex-hub-update.test.ts — a PC's pusher keeps itself at the build its hub hands out.
//
// The hub serves the build under the hub's folder (codex-hub.ts PUSHER_EXE) behind its token, with the operator's
// signature beside it; the pusher (core/codex-hub-update.ts) compares hashes, checks the signature, downloads, checks
// that the new build starts, and swaps it in. Here the "exe" files are a few bytes and starting one is a stand-in.
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { PUSHER_EXE } from '../src/core/codex-hub'
import type { CodexHubPushConfig } from '../src/core/codex-hub-push'
import { type HubBuildName, signBuild, updateKeyText } from '../src/core/codex-hub-signature'
import { RESTART_EXIT_CODE, restartPlan, updateKey, updateOnce } from '../src/core/codex-hub-update'
import { app } from '../src/http-app'
import '../src/routes/codex-hub'

const TOKEN = 'test-update-token'
const previousToken = process.env.AGENTHYDRA_CODEX_HUB_TOKEN
process.env.AGENTHYDRA_CODEX_HUB_TOKEN = TOKEN
// A copy with its own router: a request through the shared app would build its matcher and stop every later test
// file from registering routes.
const http = new Hono().route('/', app)
const toHub: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) =>
  http.fetch(new Request(String(input), init))) as typeof fetch
const cfg: CodexHubPushConfig = {
  url: 'http://127.0.0.1',
  token: TOKEN,
  pc: 'pc',
  headers: {},
  intervalMs: 60_000,
}

// The operator's key, and another that is not it.
const operator = generateKeyPairSync('ed25519').privateKey
const stranger = generateKeyPairSync('ed25519').privateKey
const KEY = updateKeyText(operator)
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Puts a build at the hub's Windows pusher, signed as scripts/codex-hub-sign.ts signs it (by default). */
function hubBuild(
  bytes: string,
  sig: { key?: typeof operator; name?: HubBuildName; platform?: string; of?: string } = {},
) {
  writeFileSync(PUSHER_EXE, bytes)
  const { key = operator, name = 'pusher', platform = 'windows-x64', of = bytes } = sig
  writeFileSync(`${PUSHER_EXE}.sig`, `${signBuild(key, name, platform, sha256(of))}\n`)
}

const dir = mkdtempSync(join(tmpdir(), 'ah-pusher-update-'))
const exe = join(dir, 'codex-hub-push.exe')
let relaunched: string[] = []
const deps = (over: Parameters<typeof updateOnce>[1] = {}) => ({
  fetch: toHub,
  exePath: exe,
  run: () => ({ status: 0, stdout: 'codex-hub-push\n' }),
  relaunch: (path: string) => void relaunched.push(path),
  log: () => {},
  // The hub's file here is its Windows build (PUSHER_EXE), whatever OS the suite runs on.
  platform: 'windows-x64',
  updateKey: KEY,
  ...over,
})

beforeEach(() => {
  relaunched = []
  writeFileSync(exe, 'old build')
  rmSync(`${exe}.old`, { force: true })
  mkdirSync(dirname(PUSHER_EXE), { recursive: true })
  hubBuild('new build')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(dirname(PUSHER_EXE), { recursive: true, force: true })
  if (previousToken === undefined) delete process.env.AGENTHYDRA_CODEX_HUB_TOKEN
  else process.env.AGENTHYDRA_CODEX_HUB_TOKEN = previousToken
})

test('a pusher whose build differs from the hub takes the hub build and starts it in its place', async () => {
  expect(await updateOnce(cfg, deps())).toBe('updated')
  expect(readFileSync(exe, 'utf8')).toBe('new build')
  expect(readFileSync(`${exe}.old`, 'utf8')).toBe('old build')
  expect(existsSync(`${exe}.new`)).toBe(false)
  expect(relaunched).toEqual([exe])

  // Now the same build as the hub: nothing happens.
  expect(await updateOnce(cfg, deps())).toBe('current')
  expect(relaunched).toEqual([exe])
})

test('a build that does not start, or does not match the hub hash, never replaces the running one', async () => {
  expect(await updateOnce(cfg, deps({ run: () => ({ status: 1, stdout: '' }) }))).toBe('failed')
  expect(readFileSync(exe, 'utf8')).toBe('old build')
  expect(existsSync(`${exe}.new`)).toBe(false)

  // The download is cut short or altered on the way: its hash differs from the one the hub announced.
  const tampered: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    new URL(String(input)).pathname.endsWith('/download')
      ? new Response('new buil')
      : toHub(input, init)) as typeof fetch
  expect(await updateOnce(cfg, deps({ fetch: tampered }))).toBe('failed')
  expect(readFileSync(exe, 'utf8')).toBe('old build')
  expect(relaunched).toEqual([])
})

test('a build that starts but prints another banner, such as the tray in the pusher slot, is refused', async () => {
  for (const stdout of ['codex-hub-tray\n', 'codex-hub-pusher\n', 'codex-hub-\n', ''])
    expect(await updateOnce(cfg, deps({ run: () => ({ status: 0, stdout }) }))).toBe('failed')
  expect(readFileSync(exe, 'utf8')).toBe('old build')
  expect(existsSync(`${exe}.new`)).toBe(false)
  expect(relaunched).toEqual([])
  // A Windows build ends its line with CRLF.
  expect(
    await updateOnce(cfg, deps({ run: () => ({ status: 0, stdout: 'codex-hub-push\r\n' }) })),
  ).toBe('updated')
})

test('a hub build that failed its checks is not fetched again until the hub has another', async () => {
  let downloads = 0
  const counting: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith('/download')) downloads++
    return toHub(input, init)
  }) as typeof fetch
  const refused = new Set<string>()
  // It exits with an error, or it crashes (a processor it cannot run on): it would again.
  const failures = [{ status: 1 }, { status: null, signal: 'SIGILL' as const }]
  for (const [i, failed] of failures.entries()) {
    hubBuild(`broken build ${i}`)
    const broken = deps({ fetch: counting, refused, run: () => ({ stdout: '', ...failed }) })
    expect(await updateOnce(cfg, broken)).toBe('failed')
    expect(await updateOnce(cfg, broken)).toBe('failed')
    expect(downloads).toBe(i + 1)
  }
  hubBuild('newer build')
  expect(await updateOnce(cfg, deps({ fetch: counting, refused }))).toBe('updated')
  expect(downloads).toBe(3)
  expect(readFileSync(exe, 'utf8')).toBe('newer build')
})

test('a download that is not the signed build, or a --version cut off at the timeout, is tried again', async () => {
  const refused = new Set<string>()
  // Someone on the way sends the hub's signed hash and other bytes.
  const tampered: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    new URL(String(input)).pathname.endsWith('/download')
      ? new Response('not the signed build')
      : toHub(input, init)) as typeof fetch
  expect(await updateOnce(cfg, deps({ fetch: tampered, refused }))).toBe('failed')
  // The antivirus holds the new build's first start past the timeout.
  const timedOut = Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' })
  const slow = () => ({ status: null, signal: 'SIGTERM' as const, stdout: '', error: timedOut })
  expect(await updateOnce(cfg, deps({ refused, run: slow }))).toBe('failed')
  expect(refused.size).toBe(0)
  expect(readFileSync(exe, 'utf8')).toBe('old build')
  expect(existsSync(`${exe}.new`)).toBe(false)

  // The hub's real build, at the next check.
  expect(await updateOnce(cfg, deps({ refused }))).toBe('updated')
  expect(readFileSync(exe, 'utf8')).toBe('new build')
})

test('a download stops at the size the hub announced, has a time limit, and leaves nothing when it fails', async () => {
  // Someone on the way sends the hub's signed hash, then bytes with no end in sight (here, 64 MB).
  let sent = 0
  let signal: AbortSignal | null | undefined
  const endless: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!new URL(String(input)).pathname.endsWith('/download')) return toHub(input, init)
    signal = init?.signal
    return new Response(
      new ReadableStream({
        pull(c) {
          if (sent >= 64 << 20) return c.close()
          sent += 1 << 16
          c.enqueue(new Uint8Array(1 << 16))
        },
      }),
    )
  }) as typeof fetch
  const refused = new Set<string>()
  expect(await updateOnce(cfg, deps({ fetch: endless, refused }))).toBe('failed')
  expect(sent).toBeLessThan(1 << 20)
  expect(signal).toBeInstanceOf(AbortSignal)
  expect(existsSync(`${exe}.new`)).toBe(false)

  // The connection breaks off, or the time runs out, halfway through.
  const broken: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    new URL(String(input)).pathname.endsWith('/download')
      ? new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('new'))
              c.error(new Error('the connection was reset'))
            },
          }),
        )
      : toHub(input, init)) as typeof fetch
  await expect(updateOnce(cfg, deps({ fetch: broken, refused }))).rejects.toThrow(
    'the connection was reset',
  )
  expect(existsSync(`${exe}.new`)).toBe(false)
  expect(readFileSync(exe, 'utf8')).toBe('old build')

  expect(refused.size).toBe(0)
  expect(await updateOnce(cfg, deps({ refused }))).toBe('updated')
})

test.skipIf(process.platform === 'win32')(
  "a downloaded build's --version gets no hub address or token, from the pusher or from a .env",
  async () => {
    // A build that does not know --version would run as this PC's pusher. This one is run by bun, which reads a .env
    // in its working folder as a compiled pusher does, and writes down what it was given.
    const probe = join(dir, 'probe.ts')
    const given = join(dir, 'probe-env.json')
    writeFileSync(
      probe,
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(given)}, JSON.stringify(process.env))\nconsole.log('codex-hub-push')\n`,
    )
    hubBuild(`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}\n`)
    const names = [
      'AGENTHYDRA_CODEX_HUB_URL',
      'AGENTHYDRA_CODEX_HUB_TOKEN',
      'CCMANAGERUI_CODEX_HUB_URL',
      'CCMANAGERUI_CODEX_HUB_TOKEN',
    ]
    // The pusher has the hub settings in its environment (AGENTHYDRA_CODEX_HUB_TOKEN is already set: the hub's token
    // here), and in a .env in the folder it was started from.
    const cwd = mkdtempSync(join(tmpdir(), 'ah-pusher-cwd-'))
    writeFileSync(join(cwd, '.env'), names.map((name) => `${name}=from-the-env-file\n`).join(''))
    const started = process.cwd()
    const set = names.filter((name) => name !== 'AGENTHYDRA_CODEX_HUB_TOKEN')
    for (const name of set) process.env[name] = 'from-the-pusher'
    try {
      process.chdir(cwd)
      expect(await updateOnce(cfg, deps({ run: undefined }))).toBe('updated')
    } finally {
      process.chdir(started)
      for (const name of set) delete process.env[name]
      rmSync(cwd, { recursive: true, force: true })
    }
    const env = JSON.parse(readFileSync(given, 'utf8')) as Record<string, string>
    for (const name of names) expect(env[name] ?? '', name).toBe('')
    expect(env.PATH).toBeTruthy()
  },
)

test('a hub with no build to hand out, and a request without the token, change nothing', async () => {
  rmSync(PUSHER_EXE)
  expect(await updateOnce(cfg, deps())).toBe('none')
  writeFileSync(PUSHER_EXE, 'new build')
  const res = await http.fetch(new Request('http://127.0.0.1/api/codex-hub/pusher/download'))
  expect(res.status).toBe(401)
  expect(readFileSync(exe, 'utf8')).toBe('old build')
})

test('with an update key, only a build signed with it for the pusher on this platform is fetched', async () => {
  const asked: string[] = []
  const counting: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push(new URL(String(input)).pathname)
    return toHub(input, init)
  }) as typeof fetch
  const lines: string[] = []
  const refused = new Set<string>()
  const check = () => updateOnce(cfg, deps({ fetch: counting, refused, log: (l) => lines.push(l) }))
  for (const [what, sig] of [
    ['another key', { key: stranger }],
    ['the tray', { name: 'tray' }],
    ['another platform', { platform: 'linux-x64' }],
    ['other bytes', { of: 'other build' }],
  ] as const) {
    hubBuild('new build', sig)
    expect(await check(), what).toBe('failed')
    expect(lines.at(-1), what).toContain('not signed with this build')
  }
  rmSync(`${PUSHER_EXE}.sig`)
  expect(await check()).toBe('failed')
  expect(lines.at(-1)).toContain('the hub build is not signed')
  // None of them was downloaded, and each was refused once.
  expect(asked.filter((p) => p.endsWith('/download'))).toEqual([])
  expect(await check()).toBe('failed')
  expect(lines).toHaveLength(5)
  expect(readFileSync(exe, 'utf8')).toBe('old build')

  // The same build, once its signature is in place, is taken.
  hubBuild('new build')
  expect(await check()).toBe('updated')
  expect(readFileSync(exe, 'utf8')).toBe('new build')
})

test('without an update key the pusher takes a build only from an https hub', async () => {
  let asked = 0
  const viaHttps: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked++
    return toHub(String(input).replace('https://hub.example.test', 'http://127.0.0.1'), init)
  }) as typeof fetch
  const lines: string[] = []
  const keyless = deps({ fetch: viaHttps, updateKey: '', log: (l) => lines.push(l) })
  rmSync(`${PUSHER_EXE}.sig`)
  expect(await updateOnce(cfg, keyless)).toBe('failed')
  expect(lines).toEqual([
    'kept this build: it has no update key (AGENTHYDRA_CODEX_HUB_UPDATE_KEY) and the hub is not https',
  ])
  expect(asked).toBe(0)
  expect(readFileSync(exe, 'utf8')).toBe('old build')

  expect(await updateOnce({ ...cfg, url: 'https://hub.example.test' }, keyless)).toBe('updated')
  expect(readFileSync(exe, 'utf8')).toBe('new build')

  // A key that is not one takes nothing, from any hub.
  writeFileSync(exe, 'old build')
  asked = 0
  const badKey = deps({ fetch: viaHttps, updateKey: 'not a key', log: (l) => lines.push(l) })
  expect(await updateOnce({ ...cfg, url: 'https://hub.example.test' }, badKey)).toBe('failed')
  expect(lines.at(-1)).toContain('not a public key')
  expect(asked).toBe(0)
})

test('the update key comes from AGENTHYDRA_CODEX_HUB_UPDATE_KEY', () => {
  const previous = process.env.AGENTHYDRA_CODEX_HUB_UPDATE_KEY
  try {
    process.env.AGENTHYDRA_CODEX_HUB_UPDATE_KEY = ` ${KEY}\n`
    expect(updateKey()).toBe(KEY)
    // A build compiled without a key and no variable has none.
    delete process.env.AGENTHYDRA_CODEX_HUB_UPDATE_KEY
    expect(updateKey()).toBe('')
  } finally {
    if (previous === undefined) delete process.env.AGENTHYDRA_CODEX_HUB_UPDATE_KEY
    else process.env.AGENTHYDRA_CODEX_HUB_UPDATE_KEY = previous
  }
})

test('off Windows a service manager starts the new build; anywhere else the pusher does', () => {
  expect(restartPlan({}, 'win32')).toBe('task')
  expect(restartPlan({ INVOCATION_ID: 'x' }, 'win32')).toBe('task')
  expect(restartPlan({}, 'linux')).toBe('spawn')
  expect(restartPlan({ INVOCATION_ID: '0123abcd' }, 'linux')).toBe('exit')
  expect(restartPlan({ XPC_SERVICE_NAME: 'com.example.codex-hub-push' }, 'darwin')).toBe('exit')
  // Terminal, and an app the Finder opened, are not jobs that start the pusher again.
  expect(restartPlan({ XPC_SERVICE_NAME: '0' }, 'darwin')).toBe('spawn')
  expect(restartPlan({ XPC_SERVICE_NAME: 'application.com.example.Term.1' }, 'darwin')).toBe(
    'spawn',
  )
  expect(restartPlan({ AGENTHYDRA_CODEX_HUB_RESTART: 'exit' }, 'linux')).toBe('exit')
  expect(restartPlan({ AGENTHYDRA_CODEX_HUB_RESTART: 'spawn', INVOCATION_ID: 'x' }, 'linux')).toBe(
    'spawn',
  )
})

test.skipIf(process.platform === 'win32')(
  'the new build started in its place writes where the pusher did, and a supervised pusher exits 75',
  async () => {
    const next = join(dir, 'codex-hub-push-next')
    writeFileSync(next, '#!/bin/sh\necho "the new build started with: $*"\n', { mode: 0o755 })
    const child = join(dir, 'relaunch.ts')
    const module = join(import.meta.dir, '..', 'src', 'core', 'codex-hub-update.ts')
    writeFileSync(
      child,
      `import { relaunchSelf } from ${JSON.stringify(module)}\nrelaunchSelf(${JSON.stringify(next)})\n`,
    )
    const relaunch = async (env: Record<string, string>) => {
      const clean = { ...process.env }
      for (const name of ['INVOCATION_ID', 'XPC_SERVICE_NAME', 'AGENTHYDRA_CODEX_HUB_RESTART'])
        delete clean[name]
      const proc = Bun.spawn([process.execPath, child, '--once'], {
        env: { ...clean, ...env },
        stdout: 'pipe',
        stderr: 'inherit',
      })
      // Read to the end: the new build holds the same output until it exits.
      const out = await new Response(proc.stdout).text()
      return { status: await proc.exited, out }
    }

    const own = await relaunch({})
    expect(own.status).toBe(0)
    expect(own.out).toContain('the new build started with: --once')

    for (const env of [
      { INVOCATION_ID: '0123abcd' } as Record<string, string>,
      { XPC_SERVICE_NAME: 'com.example.codex-hub-push' },
      { AGENTHYDRA_CODEX_HUB_RESTART: 'exit' },
    ]) {
      const supervised = await relaunch(env)
      expect(supervised.status).toBe(RESTART_EXIT_CODE)
      expect(supervised.out).not.toContain('the new build started')
      // A unit or job that is not started again stops pushing here: the log says what to set.
      expect(supervised.out).toContain('AGENTHYDRA_CODEX_HUB_RESTART=spawn')
    }
  },
)
