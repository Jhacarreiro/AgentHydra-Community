// server/tests/codex-hub-platforms.test.ts — the hub hands each platform its own pusher and tray build.
//
// A PC asks with `?platform=` (codex-hub-update.ts buildPlatform); a pusher or tray installed before there were
// other builds asks without one and must keep getting the Windows build at its first name (codex-hub.ts PUSHER_EXE,
// TRAY_EXE). The "builds" here are a few bytes.
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { HUB_PLATFORMS, hubBuildFile, PUSHER_EXE, TRAY_EXE } from '../src/core/codex-hub'
import type { CodexHubPushConfig } from '../src/core/codex-hub-push'
import { buildPlatform, isCompiledPusher, updateOnce } from '../src/core/codex-hub-update'
import { app } from '../src/http-app'
import '../src/routes/codex-hub'

const TOKEN = 'test-platforms-token'
const previousToken = process.env.AGENTHYDRA_CODEX_HUB_TOKEN
process.env.AGENTHYDRA_CODEX_HUB_TOKEN = TOKEN
// A copy with its own router, as in codex-hub-update.test.ts.
const http = new Hono().route('/', app)
const dir = dirname(PUSHER_EXE)
const sha = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex')

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await http.fetch(
    new Request(`http://127.0.0.1${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
  )
  const json = res.headers.get('content-type')?.includes('application/json')
  return { status: res.status, body: json ? await res.json() : await res.text() }
}

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  if (previousToken === undefined) delete process.env.AGENTHYDRA_CODEX_HUB_TOKEN
  else process.env.AGENTHYDRA_CODEX_HUB_TOKEN = previousToken
})

test('without a platform the hub hands out the Windows builds at their first names', async () => {
  writeFileSync(PUSHER_EXE, 'win pusher')
  writeFileSync(TRAY_EXE, 'win tray')
  expect(PUSHER_EXE).toBe(join(dir, 'codex-hub-push.exe'))
  expect(TRAY_EXE).toBe(join(dir, 'codex-hub-tray.exe'))
  expect(await get('/api/codex-hub/pusher')).toEqual({
    status: 200,
    body: { sha256: sha('win pusher'), size: 10 },
  })
  expect((await get('/api/codex-hub/pusher/download')).body).toBe('win pusher')
  expect(await get('/api/codex-hub/tray')).toEqual({
    status: 200,
    body: { sha256: sha('win tray'), size: 8 },
  })
  expect((await get('/api/codex-hub/tray/download')).body).toBe('win tray')
  // Asking for windows-x64 by name is the same file.
  expect((await get('/api/codex-hub/pusher?platform=windows-x64')).body).toEqual({
    sha256: sha('win pusher'),
    size: 10,
  })
  // Another platform never gets the Windows build.
  expect((await get('/api/codex-hub/pusher?platform=darwin-arm64')).status).toBe(404)
})

test('each platform gets its own file, named for the platform', async () => {
  for (const name of ['pusher', 'tray'] as const) {
    for (const platform of HUB_PLATFORMS) {
      const file = hubBuildFile(name, platform)!
      const base = name === 'pusher' ? 'codex-hub-push' : 'codex-hub-tray'
      expect(file).toBe(
        join(dir, platform === 'windows-x64' ? `${base}.exe` : `${base}-${platform}`),
      )
      writeFileSync(file, `${name} for ${platform}`)
    }
    for (const platform of HUB_PLATFORMS) {
      const bytes = `${name} for ${platform}`
      expect(await get(`/api/codex-hub/${name}?platform=${platform}`)).toEqual({
        status: 200,
        body: { sha256: sha(bytes), size: bytes.length },
      })
      expect((await get(`/api/codex-hub/${name}/download?platform=${platform}`)).body).toBe(bytes)
    }
  }
})

test("a build's signature, written beside it, is handed out with its hash, and nothing without one", async () => {
  writeFileSync(PUSHER_EXE, 'win pusher')
  writeFileSync(`${PUSHER_EXE}.sig`, 'c2lnbmF0dXJlIG9mIHRoZSBwdXNoZXI=\n')
  const tray = hubBuildFile('tray', 'linux-arm64')!
  writeFileSync(tray, 'arm tray')
  expect(await get('/api/codex-hub/pusher')).toEqual({
    status: 200,
    body: { sha256: sha('win pusher'), size: 10, signature: 'c2lnbmF0dXJlIG9mIHRoZSBwdXNoZXI=' },
  })
  expect((await get('/api/codex-hub/pusher/download')).body).toBe('win pusher')
  expect(await get('/api/codex-hub/tray?platform=linux-arm64')).toEqual({
    status: 200,
    body: { sha256: sha('arm tray'), size: 8 },
  })
  // A signature put in place after the build is read at the next request.
  writeFileSync(`${tray}.sig`, 'dHJheQ==')
  expect((await get('/api/codex-hub/tray?platform=linux-arm64')).body).toMatchObject({
    signature: 'dHJheQ==',
  })
  // An empty one is none.
  writeFileSync(`${PUSHER_EXE}.sig`, '\n')
  expect((await get('/api/codex-hub/pusher')).body).toEqual({ sha256: sha('win pusher'), size: 10 })
})

test('an unknown or empty platform is refused, and a known one with no build is a 404', async () => {
  // An empty one is not "no platform": a PC that meant to name its own never gets the Windows build.
  writeFileSync(PUSHER_EXE, 'win pusher')
  writeFileSync(TRAY_EXE, 'win tray')
  for (const query of [
    ...['solaris-sparc', 'linux', 'win32-x64', '..%2F..%2Fetc%2Fpasswd', ''].map(
      (platform) => `?platform=${platform}`,
    ),
    '?platform',
  ]) {
    for (const path of ['pusher', 'pusher/download', 'tray', 'tray/download']) {
      const res = await get(`/api/codex-hub/${path}${query}`)
      expect(res.status).toBe(400)
      expect((res.body as { error: string }).error).toContain('windows-x64')
    }
  }
  expect(hubBuildFile('pusher', 'freebsd-x64')).toBeNull()
  expect(hubBuildFile('pusher', '')).toBeNull()
  expect(hubBuildFile('pusher')).toBe(PUSHER_EXE)
  rmSync(TRAY_EXE)

  writeFileSync(PUSHER_EXE, 'win pusher')
  for (const path of [
    'pusher?platform=linux-x64',
    'pusher/download?platform=linux-x64',
    'tray',
    'tray/download?platform=darwin-x64',
  ])
    expect((await get(`/api/codex-hub/${path}`)).status).toBe(404)
})

test('the pusher names its own platform the way the hub does', () => {
  expect(buildPlatform('win32', 'x64')).toBe('windows-x64')
  expect(buildPlatform('linux', 'x64')).toBe('linux-x64')
  expect(buildPlatform('linux', 'arm64')).toBe('linux-arm64')
  expect(buildPlatform('darwin', 'x64')).toBe('darwin-x64')
  expect(buildPlatform('darwin', 'arm64')).toBe('darwin-arm64')
  // A compiled build under any of the hub's names updates itself; bun running a checkout does not.
  for (const exe of [
    'C:/Users/me/AppData/Local/CodexHub/codex-hub-push.exe',
    '/usr/local/bin/codex-hub-push',
    '/home/me/.local/bin/codex-hub-push-linux-x64',
    '/home/me/.local/bin/codex-hub-push-linux-arm64',
    '/Users/me/Applications/codex-hub-push-darwin-arm64',
    '/Users/me/Applications/codex-hub-push-darwin-x64',
  ])
    expect(isCompiledPusher(exe)).toBe(true)
  expect(isCompiledPusher('/home/me/.bun/bin/bun')).toBe(false)
  expect(isCompiledPusher('C:/Users/me/.bun/bin/bun.exe')).toBe(false)
})

test('the update check asks for this build, by its platform, on both requests', async () => {
  const cfg: CodexHubPushConfig = {
    url: 'http://127.0.0.1',
    token: TOKEN,
    pc: 'pc',
    headers: {},
    intervalMs: 60_000,
  }
  const asked: string[] = []
  const toHub: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push(String(input))
    return http.fetch(new Request(String(input), init))
  }) as typeof fetch
  const exeDir = mkdtempSync(join(tmpdir(), 'ah-pusher-platform-'))
  try {
    const own = buildPlatform()
    const exe = join(exeDir, `codex-hub-push-${own}`)
    writeFileSync(exe, 'old build')
    const deps = {
      fetch: toHub,
      exePath: exe,
      run: () => ({ status: 0, stdout: 'codex-hub-push\n' }),
      relaunch: () => {},
      log: () => {},
    }

    // A Mac whose hub has only the Windows build keeps what it has instead of taking that one.
    writeFileSync(PUSHER_EXE, 'windows build')
    expect(await updateOnce(cfg, { ...deps, platform: 'darwin-arm64' })).toBe('none')
    expect(asked).toEqual(['http://127.0.0.1/api/codex-hub/pusher?platform=darwin-arm64'])
    expect(readFileSync(exe, 'utf8')).toBe('old build')

    // By default it asks for the platform it runs on, and takes that build.
    const file = hubBuildFile('pusher', own)
    if (!file) return // a platform the hub hands out no builds for
    writeFileSync(file, 'new build')
    asked.length = 0
    expect(await updateOnce(cfg, deps)).toBe('updated')
    expect(asked).toEqual([
      `http://127.0.0.1/api/codex-hub/pusher?platform=${own}`,
      `http://127.0.0.1/api/codex-hub/pusher/download?platform=${own}`,
    ])
    expect(readFileSync(exe, 'utf8')).toBe('new build')
  } finally {
    rmSync(exeDir, { recursive: true, force: true })
  }
})
