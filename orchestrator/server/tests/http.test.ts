import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type OAuthConfig, STATE_DIR } from '../src/config.ts'
import { buildApp } from '../src/http.ts'

/** An invented provider: sign-in is configured, so the tunnel gate checks for the owner. */
const PROVIDER: OAuthConfig = {
  issuer: 'https://accounts.example.test',
  clientId: 'test-client',
  redirectUri: 'https://relay.example.test/oauth/callback',
}
const app = buildApp({ oauth: { ...PROVIDER } }, { version: 'test' })
/** A fresh install: no sign-in configured. */
const bare = buildApp({}, { version: 'test' })
const TUNNEL = { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-proto': 'https' }

/** Hono's `request` may answer synchronously, so normalise it to a promise for every caller. */
async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return await app.request(`http://127.0.0.1:7790${path}`, {
    headers: { host: '127.0.0.1:7790', ...headers },
  })
}

type SwitchBody = { up: boolean; paused: boolean; why: string }

describe('the auth gate', () => {
  test('loopback is open', async () => {
    const res = await get('/api/switch')
    expect(res.status).toBe(200)
  })

  test('a tunnel request with no session is a bare 401', async () => {
    const res = await get('/api/switch', { host: 'x.trycloudflare.com', ...TUNNEL })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
  })

  test('the probes the sign-in screen needs stay public over the tunnel', async () => {
    for (const path of ['/api/health', '/api/auth/status', '/api/auth/me']) {
      const res = await get(path, { host: 'x.trycloudflare.com', ...TUNNEL })
      expect(res.status).toBe(200)
    }
    const status = (await (
      await get('/api/auth/status', { host: 'x.trycloudflare.com', ...TUNNEL })
    ).json()) as {
      remote: boolean
      authenticated: boolean
      owner: string | null
    }
    expect(status.remote).toBe(true)
    expect(status.authenticated).toBe(false)
    expect(status.owner).toBeNull()
  })

  test('loopback reports itself authenticated without a cookie', async () => {
    const status = (await (await get('/api/auth/status')).json()) as {
      remote: boolean
      authenticated: boolean
    }
    expect(status.remote).toBe(false)
    expect(status.authenticated).toBe(true)
  })

  test('the switch cannot be thrown over the tunnel without the owner', async () => {
    const res = await app.request('http://127.0.0.1:7790/api/switch/arm', {
      method: 'POST',
      headers: { host: 'x.trycloudflare.com', ...TUNNEL },
    })
    expect(res.status).toBe(401)
  })
})

describe('with no sign-in configured', () => {
  const ask = async (path: string, headers: Record<string, string> = {}): Promise<Response> =>
    await bare.request(`http://127.0.0.1:7790${path}`, {
      headers: { host: '127.0.0.1:7790', ...headers },
    })

  test('loopback is open', async () => {
    expect((await ask('/api/switch')).status).toBe(200)
  })

  test('a request that still arrives through a tunnel is refused, not let in', async () => {
    expect((await ask('/api/switch', { host: 'x.trycloudflare.com', ...TUNNEL })).status).toBe(401)
    const arm = await bare.request('http://127.0.0.1:7790/api/switch/arm', {
      method: 'POST',
      headers: { host: 'x.trycloudflare.com', ...TUNNEL },
    })
    expect(arm.status).toBe(401)
  })

  test('the sign-in screen is told there is nothing to sign in with', async () => {
    const status = (await (
      await ask('/api/auth/status', { host: 'x.trycloudflare.com', ...TUNNEL })
    ).json()) as { authEnforced: boolean; remote: boolean; authenticated: boolean }
    expect(status).toMatchObject({ authEnforced: false, remote: true, authenticated: false })
    const login = await ask('/oauth/login')
    expect(login.status).toBe(404)
    expect(await login.text()).toContain('not configured')
  })
})

describe('the loopback CSRF guard', () => {
  test('a cross-site browser request is refused', async () => {
    expect((await get('/api/switch', { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await get('/api/switch', { origin: 'https://evil.example' })).status).toBe(403)
    expect((await get('/api/switch', { host: 'evil.example' })).status).toBe(403)
  })

  test("the app's own origin and a header-less client are allowed", async () => {
    expect(
      (
        await get('/api/switch', {
          origin: 'http://127.0.0.1:7790',
          'sec-fetch-site': 'same-origin',
        })
      ).status,
    ).toBe(200)
    expect((await app.request('http://127.0.0.1:7790/api/switch')).status).toBe(200)
  })

  test("a page on ANOTHER localhost port is refused - a different port is the same 'site'", async () => {
    // The exact shape that could otherwise arm this machine from a browser tab: same-site, a
    // loopback host, and a CORS-simple POST whose reply the page never needs to read.
    const res = await app.request('http://127.0.0.1:7790/api/switch/arm', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7790',
        origin: 'http://localhost:3000',
        'sec-fetch-site': 'same-site',
      },
    })
    expect(res.status).toBe(403)
    // ...refused on the Sec-Fetch-Site alone, and on the Origin alone, so neither check is load-bearing by itself.
    expect((await get('/api/switch', { 'sec-fetch-site': 'same-site' })).status).toBe(403)
    expect((await get('/api/switch', { origin: 'http://localhost:3000' })).status).toBe(403)
  })

  test('the guard never runs on tunnel traffic (the session gates that instead)', async () => {
    // A tunnel request legitimately carries a public Host; it must reach the auth gate (401), not the guard (403).
    const res = await get('/api/switch', {
      host: 'x.trycloudflare.com',
      origin: 'https://x.trycloudflare.com',
      ...TUNNEL,
    })
    expect(res.status).toBe(401)
  })
})

describe('data proxy', () => {
  test("only the dashboard's named routes are forwarded", async () => {
    const res = await get('/api/data/anything-else')
    expect(res.status).toBe(404)
  })
})

describe('the switch reads the tray heartbeat', () => {
  test('a fresh beat is armed, a paused one is paused, a stale one is off', async () => {
    const path = join(STATE_DIR, 'tray.json')
    writeFileSync(path, JSON.stringify({ pid: 1, at: Date.now(), paused: false }))
    let s = (await (await get('/api/switch')).json()) as SwitchBody
    expect(s.up).toBe(true)
    expect(s.paused).toBe(false)

    writeFileSync(path, JSON.stringify({ pid: 1, at: Date.now(), paused: true }))
    s = (await (await get('/api/switch')).json()) as SwitchBody
    expect(s.up).toBe(true)
    expect(s.paused).toBe(true)

    writeFileSync(path, JSON.stringify({ pid: 1, at: Date.now() - 120_000, paused: false }))
    s = (await (await get('/api/switch')).json()) as SwitchBody
    expect(s.up).toBe(false)
    expect(s.why).toContain('old')
  })
})

describe('the SPA fallback', () => {
  test('without a built web/dist the root explains itself instead of 404ing', async () => {
    const res = await get('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('remote:build')
  })

  test('relay share paths bounce home', async () => {
    const res = await get('/s/whatever')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })
})
