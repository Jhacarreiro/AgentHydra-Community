// server/tests/codex-hub-hardening.test.ts — what the Codex hub refuses.
//
// A push comes from any PC holding the token: a rollout that unpacks to too much, or a time no Date can print,
// is refused before anything is written.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { acceptCodexHubPush, CODEX_HUB_DIR, hubPcKey } from '../src/core/codex-hub'
import { app } from '../src/http-app'
import '../src/routes/codex-hub'

// A copy with its own router: a request through the shared app would build its matcher and stop
// every later test file from registering routes.
const http = new Hono().route('/', app)

const TOKEN = 'test-hardening-token'
const previousToken = process.env.AGENTHYDRA_CODEX_HUB_TOKEN
process.env.AGENTHYDRA_CODEX_HUB_TOKEN = TOKEN
const PC = `Hard-PC-${crypto.randomUUID().slice(0, 6)}`
const PC_DIR = join(CODEX_HUB_DIR, hubPcKey(PC)!)
const roots: string[] = []

afterAll(() => {
  rmSync(PC_DIR, { recursive: true, force: true })
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  if (previousToken === undefined) delete process.env.AGENTHYDRA_CODEX_HUB_TOKEN
  else process.env.AGENTHYDRA_CODEX_HUB_TOKEN = previousToken
})

const rolloutPath = (id: string) => `sessions/2026/10/14/rollout-2026-10-14T10-00-00-${id}.jsonl`
const gz = (data: string | Uint8Array<ArrayBuffer>) =>
  Buffer.from(Bun.gzipSync(data)).toString('base64')

// --- unpacking pushed rollouts ----------------------------------------------------------------

const LIMIT = 1024 * 1024

/** A hub folder of its own, with one PC's chat already pushed. */
function seeded(): { root: string; dir: string; manifest: string } {
  const root = join(process.env.AGENTHYDRA_HOME!, `hub-${crypto.randomUUID().slice(0, 6)}`)
  roots.push(root)
  const first = acceptCodexHubPush(
    {
      pc: 'pc',
      threads: [{ id: 'one', name: 'One', updatedAt: 1_791_900_000, path: rolloutPath('one') }],
      files: [{ path: rolloutPath('one'), updatedAt: 1_791_900_000, gz: gz('{"a":1}\n') }],
    },
    root,
    LIMIT,
  )
  expect(first).toMatchObject({ ok: true, stored: 1 })
  const dir = join(root, 'pc')
  return { root, dir, manifest: readFileSync(join(dir, 'manifest.json'), 'utf8') }
}

test('a rollout that unpacks past the limit is refused with its path, and nothing is written', () => {
  const { root, dir, manifest } = seeded()
  const bomb = gz(new Uint8Array(2 * LIMIT))
  expect(bomb.length).toBeLessThan(10_000)
  const result = acceptCodexHubPush(
    {
      pc: 'pc',
      threads: [
        { id: 'two', updatedAt: 1_792_000_000, path: rolloutPath('two') },
        { id: 'bomb', updatedAt: 1_792_000_000, path: rolloutPath('bomb') },
      ],
      files: [
        { path: rolloutPath('two'), updatedAt: 1_792_000_000, gz: gz('{"b":2}\n') },
        { path: rolloutPath('bomb'), updatedAt: 1_792_000_000, gz: bomb },
      ],
    },
    root,
    LIMIT,
  )
  expect(result).toMatchObject({ ok: false, status: 413 })
  expect((result as { error: string }).error).toContain(rolloutPath('bomb'))
  expect(existsSync(join(dir, ...rolloutPath('two').split('/')))).toBe(false)
  expect(existsSync(join(dir, ...rolloutPath('bomb').split('/')))).toBe(false)
  expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe(manifest)
})

test('rollouts that pass the limit only together are refused too; up to it they are kept', () => {
  const { root, dir, manifest } = seeded()
  const half = (id: string) => ({
    path: rolloutPath(id),
    updatedAt: 1_792_000_000,
    gz: gz('x'.repeat(LIMIT / 2 + 1)),
  })
  const threads = ['a', 'b'].map((id) => ({ id, updatedAt: 1_792_000_000, path: rolloutPath(id) }))
  const result = acceptCodexHubPush(
    { pc: 'pc', threads, files: [half('a'), half('b')] },
    root,
    LIMIT,
  )
  expect(result).toMatchObject({ ok: false, status: 413 })
  expect((result as { error: string }).error).toContain(rolloutPath('b'))
  expect(existsSync(join(dir, ...rolloutPath('a').split('/')))).toBe(false)
  expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe(manifest)

  const exact = { path: rolloutPath('a'), updatedAt: 1_792_000_000, gz: gz('x'.repeat(LIMIT)) }
  expect(acceptCodexHubPush({ pc: 'pc', threads, files: [exact] }, root, LIMIT)).toMatchObject({
    ok: true,
    stored: 1,
  })
  expect(readFileSync(join(dir, ...rolloutPath('a').split('/'))).length).toBe(LIMIT)
})

// --- times a Date cannot print ----------------------------------------------------------------

const pushRaw = (body: string) =>
  http.fetch(
    new Request('http://127.0.0.1/api/codex-hub/push', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body,
    }),
  )

test('a push whose updatedAt is no time is refused with 400, and the stored copy stays as it was', async () => {
  const good = {
    pc: PC,
    threads: [{ id: 'kept', name: 'Kept', updatedAt: 1_791_900_000, path: rolloutPath('kept') }],
    files: [{ path: rolloutPath('kept'), updatedAt: 1_791_900_000, gz: gz('{"k":1}\n') }],
  }
  expect((await pushRaw(JSON.stringify(good))).status).toBe(200)
  const manifest = readFileSync(join(PC_DIR, 'manifest.json'), 'utf8')
  const index = readFileSync(join(PC_DIR, 'session_index.jsonl'), 'utf8')

  const newFile = { path: rolloutPath('late'), updatedAt: 1_792_000_000, gz: gz('{"l":1}\n') }
  const thread = (updatedAt: unknown) => ({
    id: 'late',
    name: 'Late',
    path: rolloutPath('late'),
    updatedAt,
  })
  for (const body of [
    JSON.stringify({ pc: PC, threads: [thread(1e23)], files: [newFile] }),
    JSON.stringify({ pc: PC, threads: [thread(-1)], files: [newFile] }),
    // JSON's 1e400 parses to Infinity.
    `{"pc":${JSON.stringify(PC)},"threads":[{"id":"late","path":"${rolloutPath('late')}","updatedAt":1e400}]}`,
    JSON.stringify({
      pc: PC,
      threads: [thread(1_792_000_000)],
      files: [{ ...newFile, updatedAt: 1e23 }],
    }),
  ]) {
    const res = await pushRaw(body)
    expect({ body, status: res.status }).toEqual({ body, status: 400 })
    expect(((await res.json()) as { error: string }).error).toContain('updatedAt')
    expect(readFileSync(join(PC_DIR, 'manifest.json'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(PC_DIR, 'session_index.jsonl'), 'utf8')).toBe(index)
    expect(existsSync(join(PC_DIR, ...rolloutPath('late').split('/')))).toBe(false)
  }
})
