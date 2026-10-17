// server/tests/codex-hub-update.test.ts — a PC's pusher keeps itself at the build its hub hands out.
//
// The hub serves the build under the hub's folder (codex-hub.ts PUSHER_EXE) behind its token; the pusher
// (core/codex-hub-update.ts) compares hashes, downloads, checks that the new build starts, and swaps it in. Here the
// "exe" files are a few bytes and starting one is a stand-in.
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { PUSHER_EXE } from '../src/core/codex-hub'
import type { CodexHubPushConfig } from '../src/core/codex-hub-push'
import { updateOnce } from '../src/core/codex-hub-update'
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
  ...over,
})

beforeEach(() => {
  relaunched = []
  writeFileSync(exe, 'old build')
  rmSync(`${exe}.old`, { force: true })
  mkdirSync(dirname(PUSHER_EXE), { recursive: true })
  writeFileSync(PUSHER_EXE, 'new build')
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
  const broken = deps({ fetch: counting, refused, run: () => ({ status: 1, stdout: '' }) })
  expect(await updateOnce(cfg, broken)).toBe('failed')
  expect(await updateOnce(cfg, broken)).toBe('failed')
  expect(downloads).toBe(1)
  writeFileSync(PUSHER_EXE, 'newer build')
  expect(await updateOnce(cfg, deps({ fetch: counting, refused }))).toBe('updated')
  expect(downloads).toBe(2)
  expect(readFileSync(exe, 'utf8')).toBe('newer build')
})

test.skipIf(process.platform === 'win32')(
  "a downloaded build's --version runs without the hub's address and token",
  async () => {
    // A build that does not know --version would run as this PC's pusher; this one writes down what it was given.
    writeFileSync(PUSHER_EXE, '#!/bin/sh\nenv > "$0.env"\necho codex-hub-push\n')
    const names = [
      'AGENTHYDRA_CODEX_HUB_URL',
      'CCMANAGERUI_CODEX_HUB_URL',
      'CCMANAGERUI_CODEX_HUB_TOKEN',
    ]
    for (const name of names) process.env[name] = 'from-the-pusher'
    try {
      expect(await updateOnce(cfg, deps({ run: undefined }))).toBe('updated')
    } finally {
      for (const name of names) delete process.env[name]
    }
    const env = readFileSync(`${exe}.new.env`, 'utf8')
    expect(env).not.toContain('CODEX_HUB_URL=')
    expect(env).not.toContain('CODEX_HUB_TOKEN=')
    expect(env).toContain('PATH=')
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
