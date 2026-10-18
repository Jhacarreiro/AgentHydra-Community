// server/tests/climayte-log-archive.test.ts — log retention (climayte-log-archive.ts): an old
// worker's logs move into day archives that the status path still reads and plain tar still opens,
// nothing of a recent or active worker moves, and an archive whose append was cut short keeps every
// whole entry.
//
// The store loads once per process, so the CliMayte runs are child processes with their own
// AGENTHYDRA_HOME, as in climayte-store.test.ts.
import { afterAll, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { appendTar, readTarEntry, scanTar } from '../src/climayte-tar'

const CLIMAYTE = pathToFileURL(resolve(import.meta.dir, '../src/climayte.ts')).href
const MARK = '@@archive-test@@'
const root = mkdtempSync(join(tmpdir(), 'ah-climayte-archive-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const DAY = 24 * 3_600_000
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** One start of CliMayte on `home`: runs `body` (the module is `c`) and returns what it returned. */
async function start(home: string, body: string): Promise<unknown> {
  const script = `
    const c = await import(${JSON.stringify(CLIMAYTE)})
    const out = await (async () => { ${body} })()
    console.log(${JSON.stringify(MARK)} + JSON.stringify(out ?? null))
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      AGENTHYDRA_HOME: home,
      AGENTHYDRA_DATA_DIR: join(home, 'data'),
      AGENTHYDRA_DB: join(home, 'data', 'test.db'),
      AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
    },
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const line = out
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(MARK))
  if (code !== 0 || !line) throw new Error(`the start failed (exit ${code}): ${err}\n${out}`)
  return JSON.parse(line.slice(MARK.length))
}

/** `tar <args>` in `cwd` (relative names: GNU tar reads `C:` in a path as a host): its stdout. */
async function tar(cwd: string, ...args: string[]): Promise<Buffer> {
  const child = Bun.spawn(['tar', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited])
  if (code !== 0) throw new Error(`tar ${args.join(' ')} exited ${code}`)
  return Buffer.from(out)
}

/** The entry names `tar -tf` lists (Windows' tar ends its lines with CRLF). */
const listed = async (cwd: string, archive: string): Promise<string[]> =>
  (await tar(cwd, '-tf', archive)).toString().split(/\r?\n/).filter(Boolean)

function worker(id: string, status: string, attempts: unknown[]) {
  return {
    id,
    group: 'g-archive',
    title: id,
    cwd: root,
    prompt: 'a task',
    pending: [],
    model: null,
    effort: null,
    accounts: null,
    status,
    sessionId: null,
    accountId: null,
    attempts,
    result: null,
    results: [],
    error: null,
    lastActivity: null,
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    turns: 0,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

/** An attempt whose record is complete, so a load reads nothing to fill it in. */
function attempt(log: string, outcome: string, endedAt: number | null) {
  return {
    account: { id: 'acct-1', num: 1, name: 'one' },
    pid: null,
    log,
    errLog: log.replace(/\.jsonl$/, '.err.log'),
    startedAt: (endedAt ?? Date.now()) - 60_000,
    endedAt,
    outcome,
    notice: null,
    resumed: false,
    started: true,
    sessionId: null,
    peak: null,
    spend: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

const said = (text: string) =>
  `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] } })}\n`

/** Write `body` at `path`, last written `at`. */
function file(path: string, body: string | Buffer, at: number): string {
  writeFileSync(path, body)
  utimesSync(path, new Date(at), new Date(at))
  return path
}

test("an old worker's logs move into their day archives and the status path still reads them; a recent or active worker's stay", async () => {
  const home = join(root, 'home')
  const logs = join(home, 'corch', 'logs')
  mkdirSync(join(home, 'data'), { recursive: true })
  mkdirSync(logs, { recursive: true })
  const now = Date.now()
  // Two attempts that ended on different days: each one's files go to its own day's archive.
  const firstEnd = now - 10 * DAY
  const secondEnd = now - 9 * DAY
  const first = join(logs, 'w-old-0.jsonl')
  const second = join(logs, 'w-old-1.jsonl')
  const packedFirst = zstdCompressSync(Buffer.from(said('first step') + said('out of room')))
  file(`${first}.zst`, packedFirst, firstEnd)
  file(join(logs, 'w-old-0.err.log'), '', firstEnd)
  // Never packed (a pack that failed): archived as it is.
  const secondText = said('second step') + said('all done')
  file(second, secondText, secondEnd)
  file(join(logs, 'w-old-1.err.log'), 'a warning\n', secondEnd)
  file(join(logs, 'w-old-check-1.log'), 'check passed\n', secondEnd)
  // A long session: more lines than the status view keeps (its newest 60).
  const long = file(
    join(logs, 'w-long-0.jsonl'),
    Array.from({ length: 70 }, (_, i) => said(`step ${i}`)).join(''),
    firstEnd,
  )
  // Finished a day ago: inside the window.
  const recent = file(join(logs, 'w-new-0.jsonl'), said('recent'), now - DAY)
  // Still running, its log idle for ten days: an active worker's files never move.
  const busy = file(join(logs, 'w-busy-0.jsonl'), said('waiting'), firstEnd)
  // Named for no worker on record: goes by its own age.
  file(join(logs, 'w-gone-0.jsonl'), said('orphan'), now - 20 * DAY)
  const notOurs = file(join(logs, 'daemon-notes.txt'), 'kept', now - 20 * DAY)
  writeFileSync(
    join(home, 'corch', 'workers.json'),
    JSON.stringify({
      workers: [
        worker('w-old', 'done', [
          attempt(first, 'quota', firstEnd),
          attempt(second, 'done', secondEnd),
        ]),
        worker('w-long', 'done', [attempt(long, 'done', firstEnd)]),
        worker('w-new', 'done', [attempt(recent, 'done', now - DAY)]),
        worker('w-busy', 'running', [attempt(busy, 'running', null)]),
      ],
      perAccount: {},
    }),
  )

  const before = (await start(home, `return c.climayteGet('w-old').events`)) as string[]
  expect(before).toContain('said: first step')
  expect(before).toContain('said: all done')

  const out = (await start(
    home,
    `const pass = await c.runArchivePass({ days: 7 })
     return { pass, events: c.climayteGet('w-old').events, long: c.climayteGet('w-long').events }`,
  )) as {
    pass: { files: number; workers: number; archives: string[] }
    events: string[]
    long: string[]
  }

  const archive = join(logs, 'archive')
  const firstTar = `${day(firstEnd)}.tar`
  const secondTar = `${day(secondEnd)}.tar`
  // Every file of w-old and the orphan left logs/; nothing else did.
  expect(readdirSync(logs).sort()).toEqual(
    ['archive', 'daemon-notes.txt', 'w-busy-0.jsonl', 'w-new-0.jsonl'].sort(),
  )
  expect(existsSync(notOurs)).toBe(true)
  expect(out.pass).toMatchObject({ files: 7, workers: 3 })
  expect(readdirSync(archive).sort()).toEqual(
    [...new Set([firstTar, secondTar, `${day(now - 20 * DAY)}.tar`])].sort(),
  )

  // The status path reads the same lines, and says where each archived attempt's log was read from.
  const marks = out.events.filter((l) => l.startsWith('(log read from its day archive'))
  expect(marks).toEqual([
    `(log read from its day archive ${join(archive, firstTar)})`,
    `(log read from its day archive ${join(archive, secondTar)})`,
  ])
  expect(out.events.filter((l) => !marks.includes(l))).toEqual(before)
  // Past the view's 60-line cut the note still shows: it ends the attempt's lines.
  expect(out.long).toHaveLength(60)
  expect(out.long.at(-1)).toBe(`(log read from its day archive ${join(archive, firstTar)})`)
  expect(out.long.at(-2)).toBe('said: step 69')

  // Plain tar opens them: nothing is locked inside AgentHydra.
  expect(await tar(archive, '-xOf', firstTar, 'w-old-0.jsonl.zst')).toEqual(packedFirst)
  expect((await tar(archive, '-xOf', secondTar, 'w-old-1.jsonl')).toString()).toBe(secondText)
  expect((await listed(archive, secondTar)).sort()).toEqual([
    'w-old-1.err.log',
    'w-old-1.jsonl',
    'w-old-check-1.log',
  ])
}, 60_000)

test('an archive whose append was cut short keeps every whole entry, and the next append carries on after them', async () => {
  const path = join(root, 'torn.tar')
  const a = Buffer.from('first entry\n')
  const b = Buffer.alloc(1300, 'b')
  const c = Buffer.from('third entry\n')
  const entry = (name: string, data: Buffer) => ({ name, data, mtimeMs: Date.now() })
  let file = await open(path, 'w+')
  const idx = await scanTar(file)
  await appendTar(file, idx, [entry('w-a-0.jsonl', a), entry('w-b-0.jsonl', b)])
  const whole = idx.end
  await appendTar(file, idx, [entry('w-c-0.jsonl', c)])
  // A pass killed mid-write: the third entry's header and a few bytes of it, no end blocks.
  await file.truncate(whole + 512 + 4)
  await file.close()

  expect(readTarEntry(path, 'w-a-0.jsonl')).toEqual(a)
  expect(readTarEntry(path, 'w-b-0.jsonl')).toEqual(b)
  expect(readTarEntry(path, 'w-c-0.jsonl')).toBeNull()

  file = await open(path, 'r+')
  await appendTar(file, await scanTar(file), [entry('w-c-0.jsonl', c)])
  await file.close()
  expect(readTarEntry(path, 'w-c-0.jsonl')).toEqual(c)
  expect(readTarEntry(path, 'w-b-0.jsonl')).toEqual(b)
  expect(await listed(root, 'torn.tar')).toEqual(['w-a-0.jsonl', 'w-b-0.jsonl', 'w-c-0.jsonl'])
})
