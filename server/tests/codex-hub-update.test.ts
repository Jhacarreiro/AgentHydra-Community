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

test('a hub with no build to hand out, and a request without the token, change nothing', async () => {
  rmSync(PUSHER_EXE)
  expect(await updateOnce(cfg, deps())).toBe('none')
  writeFileSync(PUSHER_EXE, 'new build')
  const res = await http.fetch(new Request('http://127.0.0.1/api/codex-hub/pusher/download'))
  expect(res.status).toBe(401)
  expect(readFileSync(exe, 'utf8')).toBe('old build')
})
