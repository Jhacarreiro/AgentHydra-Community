// server/tests/api-guard-order.test.ts - nothing on the daemon's shared app answers ahead of its /api guard.
//
// index.ts mounts cors and the loopback guard (loopback-guard.mjs, in AH-11's exact-origin mode) on /api/* in its
// body, and only then loads the route groups with `await import('./routes/...')`. Hono runs handlers in the order
// they were registered, so a route registered before that middleware answers without it. A module index.ts imports
// statically runs before the first line of index.ts's body, and so does one daemon-preboot.ts imports statically
// (main.ts loads it before index.ts). kit/ingest-claude.ts once imported routes/hswarm.ts for one helper,
// kit/sweep.ts imports ingest-claude and index.ts imports kit/sweep.ts, so /api/hswarm-status,
// /api/hswarm-accounts and the /api/hswarm/* proxy (which adds HSwarm's console token) answered a cross-site page.
//
// The child loads exactly those static imports, read from the two files' source, so one added tomorrow is covered
// too. It is a child process, as in daemon-preboot.test.ts, because module load order is what is under test and
// this runner's module registry already holds whatever earlier files imported. It runs under the suite's preload.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '../src')
const PRELOAD = resolve(import.meta.dir, '../../tests/setup.ts')
const OWN = 'http://127.0.0.1:7787'
const TOKEN = 'fixture-console-token'

/** What a hostile page can make a browser send: a foreign Origin, or its own name in Host (DNS rebinding). */
const HOSTILE = {
  'foreign Origin': { host: '127.0.0.1:7787', origin: 'https://evil.example' },
  'foreign Host': { host: 'evil.example:7787' },
}
/** HSwarm's three routes: its status, the account names, and the proxy to its console (a read and a write). */
const ROUTES = [
  ['GET', '/api/hswarm-status'],
  ['GET', '/api/hswarm-accounts'],
  ['GET', '/api/hswarm/api/state'],
  ['POST', '/api/hswarm/api/options'],
] as const

const child = (tmp: string) => `
const SRC = ${JSON.stringify(SRC)}
const TMP = ${JSON.stringify(tmp)}
const OWN = ${JSON.stringify(OWN)}
const HOSTILE = ${JSON.stringify(HOSTILE)}
const ROUTES = ${JSON.stringify(ROUTES)}
const { readFileSync } = await import('node:fs')
const { join } = await import('node:path')

// Everything that runs before the first line of index.ts's body: daemon-preboot.ts's static imports, then index.ts's.
const statics = ['daemon-preboot.ts', 'index.ts'].flatMap((file) =>
  new Bun.Transpiler({ loader: 'ts' })
    .scanImports(readFileSync(join(SRC, file), 'utf8'))
    .filter((i) => i.kind === 'import-statement' && i.path.startsWith('.')),
)
for (const i of statics) await import(Bun.resolveSync(i.path, SRC))
const { app } = await import(join(SRC, 'http-app.ts'))
const early = app.routes.map((r) => r.method + ' ' + r.path)

// A running HSwarm that records what reaches it.
const reached = []
const hswarm = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    reached.push(req.method + ' ' + new URL(req.url).pathname + ' token=' + (req.headers.get('x-hswarm-token') ?? ''))
    return Response.json({ ok: true })
  },
})
const sidecar = () => ({ pid: undefined, exited: new Promise(() => {}), kill() {} })
const { startHSwarm } = await import(join(SRC, 'hswarm.ts'))
await startHSwarm({
  enabled: true,
  dir: join(TMP, 'pkg'),
  logDir: join(TMP, 'logs'),
  port: hswarm.port,
  spawn: sidecar,
  importSpawn: sidecar,
  probe: async () => null,
})

// Then what index.ts's body does: the guard on /api/*, then the route groups.
const { createLoopbackGuard } = await import(join(SRC, 'loopback-guard.mjs'))
const { apiOriginAllowlist } = await import(join(SRC, 'api-origins.ts'))
app.use('/api/*', createLoopbackGuard({ allowedOrigins: () => apiOriginAllowlist(OWN, {}) }))
await import(join(SRC, 'routes', 'hswarm.ts'))

const answers = {}
for (const [method, path] of ROUTES)
  for (const [name, headers] of Object.entries(HOSTILE)) {
    const res = await app.request(OWN + path, {
      method,
      headers: { ...headers, 'content-type': 'text/plain' },
      body: method === 'POST' ? '{}' : undefined,
    })
    const body = await res.json().catch(() => null)
    answers[method + ' ' + path + ' (' + name + ')'] = res.status + ' ' + (body?.error ?? '')
  }
const hostileReached = [...reached]
// The proxy itself still works for a client with no browser headers (Desk 2's bridge, a script).
const control = (await app.request(OWN + '/api/hswarm/api/state')).status
console.log('REPORT ' + JSON.stringify({ early, answers, hostileReached, control, reached }))
process.exit(0)
`

interface Report {
  early: string[]
  answers: Record<string, string>
  hostileReached: string[]
  control: number
  reached: string[]
}

let tmp: string
let report: Report

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ah-guard-order-'))
  mkdirSync(join(tmp, 'pkg', 'hswarm'), { recursive: true })
  writeFileSync(join(tmp, 'pkg', 'hswarm', '__init__.py'), '')
  mkdirSync(join(tmp, 'hswarm'))
  writeFileSync(join(tmp, 'hswarm', 'console-token'), TOKEN)
  const script = join(tmp, 'child.ts')
  writeFileSync(script, child(tmp))
  const proc = Bun.spawn([process.execPath, '--preload', PRELOAD, script], {
    env: { ...process.env, NODE_ENV: 'test', HSWARM_HOME: join(tmp, 'hswarm') },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 90_000,
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  const line = stdout.split('\n').find((l) => l.startsWith('REPORT '))
  if (!line)
    throw new Error(`the child gave no report (exit ${proc.exitCode})\n${stdout}\n${stderr}`)
  report = JSON.parse(line.slice('REPORT '.length))
}, 120_000)

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

test('the static imports loaded before index.ts mounts its guard register no route on the shared app', () => {
  // Anything listed here answers before index.ts mounts cors, the loopback guard and the body limit.
  expect(report.early).toEqual([])
})

test("a cross-site request to HSwarm's routes is refused by the guard and never reaches HSwarm", () => {
  const refused: Record<string, string> = {}
  for (const [method, path] of ROUTES) {
    refused[`${method} ${path} (foreign Origin)`] = '403 forbidden: origin not in allowlist'
    refused[`${method} ${path} (foreign Host)`] = '403 forbidden: non-loopback Host rejected'
  }
  expect(report.answers).toEqual(refused)
  expect(report.hostileReached).toEqual([])
  // Not vacuous: the same proxy, asked by a client with no browser headers, reaches HSwarm with the token.
  expect(report.control).toBe(200)
  expect(report.reached).toEqual([`GET /api/state token=${TOKEN}`])
})
