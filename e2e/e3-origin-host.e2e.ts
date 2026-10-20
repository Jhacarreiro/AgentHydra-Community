// E3: the browser-provenance guards, swept from outside. Every route the daemon mounts on its shared
// app, under /api and under Desk 2's /ah/api mirror (server/src/quick-instances-page.ts), is sent
// what a hostile page can make a browser send: a foreign Origin, another local port's Origin
// (AH-11), the 'null' Origin, a rebound Host and Sec-Fetch-Site: cross-site. Each must be refused
// with 403 before any handler runs (server/src/loopback-guard.mjs, mounted on /api/* in index.ts).
// The unit tests prove the guard's decision case by case; this proves it stands in front of every
// route, including one added tomorrow, since the list is read from the source each run. Desk 2's
// own server and its /ws upgrade, which does not go through Hono, get the same treatment.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { Subprocess } from 'bun'
import { call, type Daemon, REPO, scenario, start, waitFor } from './harness'

const lane = scenario('E3')
const home = lane.home()

/** Every `app.<verb>('/api/...')` in the modules that attach to the daemon's shared app
 *  (server/src/http-app.ts): index.ts, every module that imports that app (server/src/routes/*.ts
 *  among them), and every module index.ts hands it to as an `app: Hono` parameter (CliMayte's MCP
 *  routes). instance-mode.ts builds an app of its own for another entry and is left out. Read as
 *  text, never imported. */
function mountedRoutes(): Array<{ method: string; path: string }> {
  const src = join(REPO, 'server/src')
  const files = (readdirSync(src, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts') && !f.split(sep).includes('node_modules'))
    .map((f) => join(src, f))
    .filter((file) => {
      if (file === join(src, 'index.ts')) return true
      const text = readFileSync(file, 'utf8')
      return /from '(\.\.?\/)+http-app'/.test(text) || /\bapp: Hono\b/.test(text)
    })
  const seen = new Map<string, { method: string; path: string }>()
  const re = /\bapp\.(get|post|put|patch|delete|all)\(\s*(['`])(\/api\/[^'`$]*)\2/g
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(re)) {
      const method = m[1] === 'all' ? 'POST' : (m[1] as string).toUpperCase()
      // A path parameter gets a harmless value: the guard answers before any route matches.
      const path = (m[3] as string).replace(/:[^/]+/g, 'e2e').replace(/\*/g, 'x')
      seen.set(`${method} ${path}`, { method, path })
    }
  }
  return [...seen.values()]
}

/** One request's browser headers, by name. */
type Case = { name: string; headers: Record<string, string>; exact?: true }

/** What a hostile page can make a browser send. `exact` marks the case only an exact-origin rule
 *  refuses: Desk 2 takes any loopback origin (desk2/server/src/index.ts isLocalHost), so the daemon's
 *  AH-11 rule is not asserted there. */
function hostile(port: number): Case[] {
  return [
    { name: 'foreign Origin', headers: { origin: 'https://evil.example' } },
    {
      name: 'another local port',
      headers: { origin: `http://127.0.0.1:${port + 1}` },
      exact: true,
    },
    { name: 'null Origin', headers: { origin: 'null' } },
    { name: 'rebound Host', headers: { host: `evil.example:${port}` } },
    { name: 'cross-site fetch', headers: { 'sec-fetch-site': 'cross-site' } },
  ]
}

/** Open a raw WebSocket handshake and return the status line's code (101 when accepted). */
function wsHandshake(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const lines = {
      host: `127.0.0.1:${port}`,
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': btoa('e2e-lane-key-16b'),
      'sec-websocket-version': '13',
      ...headers,
    }
    const head = Object.entries(lines)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('')
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(s) {
          s.write(`GET ${path} HTTP/1.1\r\n${head}\r\n`)
        },
        data(s, chunk) {
          buf += chunk.toString('latin1')
          const m = /^HTTP\/1\.1 (\d{3})/.exec(buf)
          if (m) {
            resolve(Number(m[1]))
            s.end()
          }
        },
        close() {
          reject(new Error(`the ${path} handshake closed with no status line`))
        },
        error(_s, e) {
          reject(e)
        },
      },
    }).catch(reject)
  })
}

let daemon: Daemon

/** Each case's status for one request, keyed by the case's name. */
async function statuses(
  cases: Case[],
  send: (headers: Record<string, string>) => Promise<number>,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const c of cases) out[c.name] = await send(c.headers)
  return out
}
const all = (cases: Case[], status: number) =>
  Object.fromEntries(cases.map((c) => [c.name, status]))

test('E3: the daemon answers its own origin, both spellings, and a client with no browser headers', async () => {
  daemon = await lane.boot(home)
  const own: Case[] = [
    { name: 'no browser headers', headers: {} },
    { name: 'own origin', headers: { origin: daemon.url } },
    { name: 'own origin as localhost', headers: { origin: `http://localhost:${daemon.port}` } },
    { name: 'Host localhost', headers: { host: `localhost:${daemon.port}` } },
  ]
  const got = await statuses(
    own,
    async (headers) => (await daemon.api('/api/health', { headers })).status,
  )
  expect(got).toEqual(all(own, 200))
}, 60_000)

/** The guard's answer: 403 with its own `forbidden: <reason>`, not a handler's 403. */
const refused = (res: { status: number; body?: any }) =>
  res.status === 403 && String(res.body?.error).startsWith('forbidden:')

test('E3: every mounted /api route, and its /ah/api mirror, refuses every hostile request with 403', async () => {
  const routes = mountedRoutes()
  // A floor, so a source layout change that empties the scan fails here instead of passing on nothing.
  expect(routes.length).toBeGreaterThan(200)
  // With the guard down the sweep would run every handler, POST /api/update/apply (a git pull and a
  // reinstall of this checkout) and /api/shutdown among them. So the guard is first seen refusing
  // every case, both verbs and both prefixes, on /api/health, which changes nothing.
  const down: string[] = []
  for (const prefix of ['', '/ah'])
    for (const method of ['GET', 'POST'])
      for (const h of hostile(daemon.port)) {
        const res = await call(`${daemon.url}${prefix}/api/health`, {
          method,
          headers: h.headers,
          body: method === 'GET' ? undefined : '{}',
        })
        if (!refused(res)) down.push(`${method} ${prefix}/api/health (${h.name}): ${res.status}`)
      }
  expect(down).toEqual([])
  const through: string[] = []
  const jobs: Array<() => Promise<void>> = []
  for (const r of routes)
    for (const prefix of ['', '/ah'])
      for (const h of hostile(daemon.port))
        jobs.push(async () => {
          const res = await call(daemon.url + prefix + r.path, {
            method: r.method,
            headers: h.headers,
            body: r.method === 'GET' ? undefined : '{}',
            signal: AbortSignal.timeout(10_000),
          }).catch((e) => ({ status: 0, body: String(e) }))
          if (!refused(res))
            through.push(`${r.method} ${prefix}${r.path} (${h.name}): ${res.status}`)
        })
  for (let i = 0; i < jobs.length; i += 16) await Promise.all(jobs.slice(i, i + 16).map((j) => j()))
  expect(through.sort()).toEqual([])
}, 120_000)

test('E3: a preflight from a foreign origin is not granted', async () => {
  const pre = await daemon.api('/api/settings', {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  })
  expect(pre.headers.get('access-control-allow-origin') ?? '').not.toContain('evil.example')
})

let desk: Subprocess
let deskPort: number

test('E3: Desk 2 serves its own origin and refuses a hostile one on its API', async () => {
  deskPort = Number(home.env.HYDRA_DESK_PORT)
  desk = start([process.execPath, 'server/src/index.ts'], {
    cwd: join(REPO, 'desk2'),
    env: { ...home.env, HYDRA_DESK_PORT: String(deskPort), HYDRA_URL: daemon.url },
    log: join(home.dir, 'logs', 'desk2.log'),
  })
  const desk2 = `http://127.0.0.1:${deskPort}`
  await waitFor('Desk 2', async () => (await call(`${desk2}/api/health`)).status === 200, 45_000)
  expect((await call(`${desk2}/api/settings`, { headers: { origin: desk2 } })).status).toBe(200)
  const cases = hostile(deskPort).filter((h) => !h.exact)
  const got = await statuses(
    cases,
    async (headers) => (await call(`${desk2}/api/settings`, { headers })).status,
  )
  expect(got).toEqual(all(cases, 403))
}, 60_000)

test("E3: Desk 2's /ws upgrade takes its own origin and refuses every hostile one", async () => {
  expect(await wsHandshake(deskPort, '/ws', { origin: `http://127.0.0.1:${deskPort}` })).toBe(101)
  const cases = hostile(deskPort).filter((h) => !h.exact)
  expect(await statuses(cases, (headers) => wsHandshake(deskPort, '/ws', headers))).toEqual(
    all(cases, 403),
  )
  desk.kill('SIGTERM')
  await desk.exited
}, 30_000)

lane.realHomeUntouched()
