// server/tests/climayte-origin.test.ts — who dispatched a CliMayte worker, and the ping that goes back.
//
// Owner, 2026-10-03: "when a chat finishes, it pings the orchestrator that started it", and a worker
// that is five-hour or weekly limited and moved is reported to that chat too. That needs the
// dispatching chat recorded on every worker (its `origin`), taken only from the caller the MCP
// route itself resolved, never from what a client wrote into its arguments, and an outbox the
// daemon starts with CliMayte (climayte-ping.ts).
//
// The MCP tools run here against the REAL /api/corch routes: fetch is pointed at the shared Hono
// app, so a tool's POST lands in climayte.ts exactly as it would in the daemon. The caller's
// transcript lookup and every transport (peer pipe, composer, toast) are injected: nothing here
// resolves a real process, messages a real chat or launches a CLI (no account is signed in, so
// every worker waits).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import {
  climayteCancel,
  climayteGet,
  climaytePing,
  climayteRun,
  killsLanded,
  setCliMayteAccountsProvider,
  setCliMaytePingDeps,
  startCliMayte,
  stopCliMaytePing,
} from '../src/climayte'
import { notify, ROOT, workers } from '../src/climayte-core'
import type { CliMayteAttempt } from '../src/climayte-lib'
import { flushCliMayteStore } from '../src/climayte-store-writer'
import { resolveOwnTranscript } from '../src/compaction-history'
import { app } from '../src/http-app'
import { POINTER_DIR } from '../src/instance'
import { TOOLS, toolsForCaller } from '../src/mcp'
import {
  CALLER_AWARE_TOOLS,
  CALLER_PID_ARG,
  callerOrigin,
  setCallerTranscriptResolver,
} from '../src/mcp-self'
import '../src/routes/climayte'

// The shared `app` in http-app.ts freezes its router on its first request, after which every later
// file that loads a routes/*.ts module dies at import (queue-patch-guard.test.ts has the story).
// A fresh Hono with the routes copied in keeps the shared one open.
const http = new Hono().route('/', app)

const SID = '12345678-aaaa-4bbb-8ccc-1234567890ab'
const SPOOF = '99999999-dead-4bee-8fee-000000000000'
const scratch = mkdtempSync(join(tmpdir(), 'climayte-origin-'))
const HOME = join(scratch, 'claude-home')
const CWD = join(scratch, 'repo')
mkdirSync(HOME, { recursive: true })
mkdirSync(CWD, { recursive: true })
const TRANSCRIPT = join(HOME, 'projects', 'p', `${SID}.jsonl`)
const PING_DIR = join(POINTER_DIR, 'climayte')
const KILL = join(PING_DIR, 'ping-off')

type Delivery = { sessionId: string; transcript: string | null; text: string; home: string }
const delivered: Delivery[] = []
const posted: Array<{ url: string; body: Record<string, unknown> | null }> = []
/** Who the bound caller resolves to; a function so a test can make it throw. */
let caller: () => { sessionId: string; path: string; home: string; how: string } = () => ({
  sessionId: SID,
  path: TRANSCRIPT,
  home: HOME,
  how: 'test caller',
})
const realFetch = globalThis.fetch
/** Runs after a GET has its answer and before the caller gets it: the answer's time on the wire. */
let answered: (() => Promise<void>) | null = null

beforeAll(() => {
  setCliMayteAccountsProvider(() => [])
  setCliMaytePingDeps({
    deliverPeer: async (sessionId, transcript, text, _ms, home) => {
      delivered.push({ sessionId, transcript, text, home })
      return { ok: true, reason: 'delivered' }
    },
    composer: undefined,
    toast: async () => undefined,
    journal: () => undefined,
  })
  setCallerTranscriptResolver(async () => caller())
  // @ts-expect-error a narrower signature than the real fetch
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    const u = new URL(String(url))
    if (init?.method === 'POST')
      posted.push({ url: u.pathname, body: init.body ? JSON.parse(String(init.body)) : null })
    const res = await http.fetch(new Request(`http://127.0.0.1${u.pathname}${u.search}`, init))
    if (init?.method !== 'POST' && answered) await answered()
    return res
  }
})

afterAll(async () => {
  // Every group here is 'og-*'. Its workers wait for an account that never comes; left queued in
  // the shared store, they would take the accounts a later suite in this process hands out.
  const groups = new Set(
    [...workers.values()].map((w) => w.group).filter((g) => g?.startsWith('og-')),
  )
  for (const group of groups) climayteCancel({ group })
  await killsLanded()
  globalThis.fetch = realFetch
  setCallerTranscriptResolver(null)
  setCliMaytePingDeps(null)
  stopCliMaytePing()
  setCliMayteAccountsProvider(null)
  rmSync(KILL, { force: true })
  rmSync(scratch, { recursive: true, force: true })
})

/** A tool bound to a caller, the way the HTTP MCP route binds it. */
function bound(name: string) {
  const t = toolsForCaller(async () => 4242).find((x) => x.name === name)
  if (!t) throw new Error(`no MCP tool named ${name}`)
  return t
}

const task = (title: string) => ({ prompt: `do ${title}`, cwd: CWD, title, size: 'whole' })
const lastPost = (path: string) => posted.filter((p) => p.url === path).at(-1)?.body ?? null

describe('climayte_run records the calling chat as the origin', () => {
  test('the three CliMayte dispatch/status tools are caller-aware', () => {
    for (const n of ['climayte_run', 'climayte_manage', 'climayte_status'])
      expect(CALLER_AWARE_TOOLS.has(n)).toBe(true)
    // ...and rebound, so they receive the route's caller binding.
    const rebound = toolsForCaller(async () => 1)
      .filter((t, i) => t !== TOOLS[i])
      .map((t) => t.name)
    expect(rebound).toEqual(expect.arrayContaining(['climayte_run', 'climayte_status']))
  })

  test('origin is the resolved caller, and the answer says ping: on', async () => {
    const r = (await bound('climayte_run').run({
      tasks: [task('origin a')],
      group: 'og-run',
    })) as { ping: string; workers: Array<{ id: string }> }
    expect(lastPost('/api/corch/workers')?.origin).toEqual({
      kind: 'chat',
      sessionId: SID,
      home: HOME,
      transcript: TRANSCRIPT,
      how: 'test caller',
    })
    expect(r.ping).toBe('on: 12345678 is messaged when work settles (test caller)')
    const w = climayteGet(r.workers[0].id) as { origin?: { sessionId: string } }
    expect(w.origin?.sessionId).toBe(SID)
  })

  test('an origin the client wrote into its own arguments is ignored', async () => {
    const spoof = { kind: 'chat', sessionId: SPOOF, home: HOME, transcript: null, how: 'me' }
    await bound('climayte_run').run({ tasks: [task('origin b')], group: 'og-spoof', origin: spoof })
    expect(
      (lastPost('/api/corch/workers')?.origin as { sessionId?: string } | undefined)?.sessionId,
    ).toBe(SID)

    // An unresolvable caller sends `origin: null` (none, on purpose: the route traces nothing), the
    // spoof included.
    caller = () => {
      throw new Error('no live session in the calling chain')
    }
    try {
      const r = (await bound('climayte_run').run({
        tasks: [task('origin c')],
        group: 'og-spoof2',
        origin: spoof,
      })) as { ping: string; workers: Array<{ id: string }> }
      expect(lastPost('/api/corch/workers')?.origin).toBeNull()
      expect(r.ping).toBe(
        'off: no live session in the calling chain; run python ~/.claude/tools/climayte_wait.py --group og-spoof2',
      )
      expect((climayteGet(r.workers[0].id) as { origin?: unknown }).origin).toBeUndefined()
    } finally {
      caller = () => ({ sessionId: SID, path: TRANSCRIPT, home: HOME, how: 'test caller' })
    }
  })

  // 2026-10-11: three climayte_run calls (68, 17 and 1 tasks) waited on this lookup, a netstat behind
  // a jammed spawn worker, until the daemon restarted under them, and none was ever dispatched. Past
  // its budget the lookup answers as an untraced caller does, so the dispatch above goes on.
  test('a caller lookup that never answers gives up at its budget', async () => {
    setCallerTranscriptResolver(() => new Promise(() => {}))
    try {
      const started = Date.now()
      expect(await callerOrigin({}, 200)).toEqual({
        origin: null,
        why: 'the calling chat could not be traced within 0.2 s',
      })
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      setCallerTranscriptResolver(async () => caller())
    }
  })

  test('notify: false opts out', async () => {
    const r = (await bound('climayte_run').run({
      tasks: [task('origin d')],
      group: 'og-quiet',
      notify: false,
    })) as { ping: string; workers: Array<{ id: string }> }
    // null, not absent: the route traces a body with no origin key (a plain HTTP caller), never this one.
    expect(lastPost('/api/corch/workers')?.origin).toBeNull()
    expect(r.ping).toStartWith('off: notify: false')
    // Still traced: the chat that called is the From, though nothing is pinged.
    const w = climayteGet(r.workers[0].id) as { origin?: unknown; trace?: { sessionId?: string } }
    expect(w.origin).toBeUndefined()
    expect(w.trace?.sessionId).toBe(SID)
  })

  test('the route refuses a malformed origin rather than storing it', async () => {
    const res = await http.fetch(
      new Request('http://127.0.0.1/api/corch/workers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tasks: [task('origin e')],
          group: 'og-bad',
          origin: { kind: 'chat', sessionId: 'not-a-uuid', home: 'relative', transcript: null },
        }),
      }),
    )
    const r = (await res.json()) as { workers: Array<{ id: string }>; ping: { on: boolean } }
    expect(r.ping.on).toBe(false)
    expect((climayteGet(r.workers[0].id) as { origin?: unknown }).origin).toBeUndefined()
  })

  test('the origin is saved with the worker', async () => {
    const r = climayteRun({
      tasks: [task('origin f')],
      group: 'og-store',
      origin: { kind: 'chat', sessionId: SID, home: HOME, transcript: TRANSCRIPT, how: 'x' },
    })
    const id = r.workers[0].id
    await flushCliMayteStore()
    const stored = JSON.parse(readFileSync(join(ROOT, 'workers.json'), 'utf8')) as {
      workers: Array<{ id: string; origin?: { sessionId: string } }>
    }
    expect(stored.workers.find((w) => w.id === id)?.origin?.sessionId).toBe(SID)
  })
})

describe("a task's detail carries its whole brief only when asked", () => {
  // Desk 2's CliMayte pane shows the whole brief (owner, 2026-10-04: "should show full one"); the
  // views, and so climayte_status { id }, keep its first 300 characters, so a chat reading its own
  // task is not handed back the brief it wrote.
  test('prompt=full answers the whole brief; climayte_status { id } still gets 300 characters', async () => {
    const prompt = `do the long one ${'x'.repeat(600)}`
    const id = climayteRun({
      tasks: [{ prompt, cwd: CWD, title: 'long brief', size: 'whole' }],
      group: 'og-brief',
    }).workers[0].id
    const res = await http.fetch(
      new Request(`http://127.0.0.1/api/corch/workers/${id}?prompt=full`),
    )
    expect(((await res.json()) as { prompt: string }).prompt).toBe(prompt)
    const status = (await bound('climayte_status').run({ id })) as { prompt: string }
    expect(status.prompt).toBe(prompt.slice(0, 300))
  })
})

describe('a task a worker dispatches reports to that worker', () => {
  test('a caller that is a CliMayte worker becomes a worker origin; a wave task gets none', async () => {
    const mgr = climayteRun({
      tasks: [{ ...task('manager'), chat: true }],
      group: 'og-mgr',
      origin: { kind: 'chat', sessionId: SID, home: HOME, transcript: TRANSCRIPT, how: 'x' },
    }).workers[0]
    const mgrSession = workers.get(mgr.id)?.sessionId as string
    caller = () => ({ sessionId: mgrSession, path: TRANSCRIPT, home: HOME, how: 'worker caller' })
    try {
      const r = (await bound('climayte_run').run({
        tasks: [task('sub task')],
        group: 'og-sub',
      })) as { ping: string; workers: Array<{ id: string }> }
      expect(workers.get(r.workers[0].id)?.origin).toEqual({ kind: 'worker', workerId: mgr.id })
      expect(r.ping).toBe(`on: manager ${mgr.id} is sent a message when work settles`)
    } finally {
      caller = () => ({ sessionId: SID, path: TRANSCRIPT, home: HOME, how: 'test caller' })
    }
    const wave = climayteRun({
      tasks: [task('wave task')],
      group: 'og-wave',
      wave: 'wv-test',
      origin: { kind: 'chat', sessionId: mgrSession, home: HOME, transcript: null, how: 'x' },
    })
    expect(workers.get(wave.workers[0].id)?.origin).toBeUndefined()
  })
})

describe('climayte_status {group, ping: true} adopts a running group', () => {
  test('sets the caller as origin on live workers that have none, and only those', async () => {
    const r = climayteRun({ tasks: [task('adopt a'), task('adopt b')], group: 'og-adopt' })
    const [a, b] = r.workers.map((w) => w.id)
    const other = { kind: 'worker' as const, workerId: 'w-someone' }
    const wb = workers.get(b)
    if (wb) wb.origin = other
    const res = (await bound('climayte_status').run({ group: 'og-adopt', ping: true })) as {
      ping: string
      adopted: number
    }
    expect(res.adopted).toBe(1)
    expect(res.ping).toStartWith('on: 12345678')
    expect(workers.get(a)?.origin).toMatchObject({ kind: 'chat', sessionId: SID })
    expect(workers.get(b)?.origin).toEqual(other)
  })
})

describe('a chat that reads or cancels its own workers is not pinged about them again', () => {
  // 2026-10-13: a chat busy for six hours was sent 104 lines in one ping about workers it had read or cancelled.
  test("a scoped climayte_status and a climayte_cancel stamp seenAt on the caller's own workers only", async () => {
    const mine = {
      kind: 'chat' as const,
      sessionId: SID,
      home: HOME,
      transcript: TRANSCRIPT,
      how: 'x',
    }
    const r = climayteRun({
      tasks: [task('seen a'), task('seen b')],
      group: 'og-seen',
      origin: mine,
    })
    const [a, b] = r.workers.map((w) => w.id)
    const wb = workers.get(b)
    if (wb) wb.origin = { ...mine, sessionId: '0f0f0f0f-0000-4000-8000-000000000000' }
    const before = Date.now()
    await bound('climayte_status').run({ group: 'og-seen' })
    const read = workers.get(a)?.seenAt ?? 0
    expect(read).toBeGreaterThanOrEqual(before)
    expect(workers.get(b)?.seenAt).toBeUndefined()
    // An unscoped list is not a look at any one worker.
    workers.get(a)!.seenAt = undefined
    await bound('climayte_status').run({})
    expect(workers.get(a)?.seenAt).toBeUndefined()
    await bound('climayte_cancel').run({ id: a })
    expect(workers.get(a)?.status).toBe('cancelled')
    expect(workers.get(a)?.seenAt).toBeGreaterThanOrEqual(read)
    // A finished worker's stamp reaches its done/ file, so a daemon restart does not bring its pings back.
    await new Promise((r) => setTimeout(r, 5))
    await bound('climayte_status').run({ id: a })
    await flushCliMayteStore()
    const filed = JSON.parse(readFileSync(join(ROOT, 'done', `${a}.json`), 'utf8'))
    expect(filed.seenAt).toBe(workers.get(a)?.seenAt)
  })

  test('a read is never stamped later than its answer was built, waiting or not', async () => {
    // Review, 2026-10-13: stamped when the answer arrived, a worker that finished while it was on its way
    // counted as seen, and its finished ping was dropped though the chat had only read "running".
    const r = climayteRun({
      tasks: [task('seen late')],
      group: 'og-seen-late',
      origin: { kind: 'chat', sessionId: SID, home: HOME, transcript: TRANSCRIPT, how: 'x' },
    })
    const a = r.workers[0].id
    for (const wait of [{}, { wait_seconds: 1 }]) {
      const start = Date.now()
      let built = 0
      answered = async () => {
        built = Date.now()
        await new Promise((r) => setTimeout(r, 20))
      }
      await bound('climayte_status').run({ id: a, ...wait })
      answered = null
      expect(workers.get(a)?.seenAt).toBeGreaterThanOrEqual(start)
      expect(workers.get(a)?.seenAt).toBeLessThanOrEqual(built)
    }
  })
})

describe('startCliMayte runs the ping outbox', () => {
  test('a finished worker, limited and moved on the way, is one delivery to its chat', async () => {
    startCliMayte()
    expect(climaytePing()).not.toBeNull()
    const id = climayteRun({
      tasks: [task('ping me')],
      group: 'og-ping',
      origin: { kind: 'chat', sessionId: SID, home: HOME, transcript: TRANSCRIPT, how: 'x' },
    }).workers[0].id
    const w = workers.get(id)
    if (!w) throw new Error('worker missing')
    const t = Date.now()
    const attempt = (num: number, outcome: string, notice: string | null) =>
      ({
        account: { id: `acct-${num}`, num },
        startedAt: t - 60_000,
        endedAt: t - 30_000,
        outcome,
        notice,
      }) as unknown as CliMayteAttempt
    w.attempts = [attempt(94, 'quota', "You've hit your session limit"), attempt(102, 'done', null)]
    w.attempts[1].startedAt = t - 25_000
    w.status = 'done'
    w.accountId = 'acct-102'
    notify(w)
    const before = delivered.length
    await climaytePing()?.flushNow()
    const mine = delivered.slice(before)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ sessionId: SID, transcript: TRANSCRIPT, home: HOME })
    expect(mine[0].text).toContain('#94 hit its 5-hour limit; resumed on #102')
    expect(mine[0].text).toContain('needs your verdict')
    await climaytePing()?.flushNow()
    expect(delivered.length).toBe(before + 1)
  })

  test('the kill switch: nothing is sent, and climayte_run says ping: off', async () => {
    mkdirSync(PING_DIR, { recursive: true })
    writeFileSync(KILL, '')
    try {
      const r = (await bound('climayte_run').run({
        tasks: [task('silenced')],
        group: 'og-off',
      })) as { ping: string; workers: Array<{ id: string }> }
      expect(r.ping).toStartWith('off: ')
      expect(r.ping).toContain('ping-off')
      const w = workers.get(r.workers[0].id)
      if (!w) throw new Error('worker missing')
      w.status = 'done'
      notify(w)
      const before = delivered.length
      await climaytePing()?.flushNow()
      expect(delivered.length).toBe(before)
    } finally {
      rmSync(KILL, { force: true })
    }
    expect(existsSync(KILL)).toBe(false)
  })
})

describe('resolveOwnTranscript names the Claude home it matched', () => {
  test('home is the registry dir the transcript was found under', async () => {
    mkdirSync(join(HOME, 'projects', 'p'), { recursive: true })
    writeFileSync(TRANSCRIPT, '')
    const t = await resolveOwnTranscript({
      sessionId: SID,
      callerPid: null,
      extraHomes: async () => [HOME],
    })
    expect(t.home).toBe(HOME)
    expect(t.path).toBe(TRANSCRIPT)
  })
})

// Each case walks the real process chain (then a powershell.exe per walk on Windows, now the process
// table read in-process), two or three walks a case, and the nearest-engine case starts two bun
// processes: MEASURED alone 2026-10-04 with 8 GB free, past bun's 5 s default in the full suite.
// The allowance is chosen, not inherited.
const PROCESS_WALK_TEST_MS = 30_000

// Owner, 2026-10-12: a chat's script posted about 60 workers to /api/corch/workers with no origin, and
// nothing could say which thread ran them ("it doesn't specify what OG thread ran it"). A plain HTTP
// dispatch is now traced from its socket to the chat its process runs under; `origin: null` is a
// dispatcher's word that there is none. The POST comes from a child process over a real loopback
// socket, so the route reads a real peer pid from the OS connection table.
describe('a plain HTTP dispatch records the chat its process runs under', () => {
  let server: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req, srv) => http.fetch(req, srv),
    })
  })
  afterAll(() => server.stop(true))

  /** POSTs `body` to the dispatch route from a child process: the child's pid and the answer. */
  async function postFromChild(body: Record<string, unknown>) {
    const url = `http://127.0.0.1:${server.port}/api/corch/workers`
    const script = `const r = await fetch(${JSON.stringify(url)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }); process.stdout.write(await r.text())`
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(child.stdout).text()
    await child.exited
    return { pid: child.pid, reply: JSON.parse(out) as { workers: Array<{ id: string }> } }
  }

  test(
    'no origin in the body: the sending process is traced to its chat',
    async () => {
      const asked: Array<number | null> = []
      setCallerTranscriptResolver(async (a) => {
        asked.push(await (a[CALLER_PID_ARG] as () => Promise<number | null>)())
        return caller()
      })
      try {
        const { pid, reply } = await postFromChild({ tasks: [task('traced a')], group: 'og-http' })
        expect(asked).toEqual([pid])
        const w = climayteGet(reply.workers[0].id) as {
          origin?: { sessionId: string; how: string }
        }
        expect(w.origin?.sessionId).toBe(SID)
        expect(w.origin?.how).toBe('traced from the HTTP request: test caller')
      } finally {
        setCallerTranscriptResolver(async () => caller())
      }
    },
    PROCESS_WALK_TEST_MS,
  )

  // The owner (2026-10-13): "Not traced is never an option. They must always be traced." origin: null
  // still traces the sending process to its chat; it only stops the pings.
  test(
    'origin: null in the body: no ping, but the sending process is still traced to its chat',
    async () => {
      let asked = 0
      setCallerTranscriptResolver(async () => {
        asked++
        return caller()
      })
      try {
        const { reply } = await postFromChild({
          tasks: [task('traced b')],
          group: 'og-http-none',
          origin: null,
        })
        expect(asked).toBe(1)
        const w = climayteGet(reply.workers[0].id) as {
          origin?: unknown
          trace?: { sessionId?: string }
        }
        expect(w.origin).toBeUndefined()
        expect(w.trace?.sessionId).toBe(SID)
      } finally {
        setCallerTranscriptResolver(async () => caller())
      }
    },
    PROCESS_WALK_TEST_MS,
  )
})

describe('a chat registered under a CLI instance is found as the caller', () => {
  // a desktop app that runs chats through the Agent SDK on a CLI instance: the engine's registry is in that
  // instance's config dir, which the caller's own detection does not name, so its workers had no origin.
  test(
    'callerHomes includes every CLI instance, and the pid walk matches there',
    async () => {
      const { createCliInstance, listCliInstances } = await import('../src/core/cli-instances')
      const { callerHomes } = await import('../src/mcp-self')
      const made = createCliInstance('origin-desk-chat')
      expect(made.ok).toBe(true)
      const dir = listCliInstances().find((i) => i.name === 'origin-desk-chat')!.configDir
      const sid = '12345678-bbbb-4ccc-8ddd-1234567890ab'
      mkdirSync(join(dir, 'sessions'), { recursive: true })
      mkdirSync(join(dir, 'projects', 'p'), { recursive: true })
      writeFileSync(join(dir, 'projects', 'p', `${sid}.jsonl`), '')
      writeFileSync(
        join(dir, 'sessions', `${process.pid}.json`),
        JSON.stringify({ pid: process.pid, sessionId: sid, cwd: CWD }),
      )

      expect(await callerHomes(process.pid)).toContain(dir)
      const t = await resolveOwnTranscript({
        callerPid: process.pid,
        extraHomes: () => callerHomes(process.pid),
      })
      expect(t.sessionId).toBe(sid)
      expect(t.home).toBe(dir)
    },
    PROCESS_WALK_TEST_MS,
  )

  // The default home's registry used to be searched to the end of the chain before any instance's,
  // so a chat that a default-home session started (a desk app launched from a chat) was reported as
  // that session. Stdio: no caller pid, so the asking process's parents are walked and
  // CLAUDE_CONFIG_DIR is the default home. The asker is a grandchild of this test, so its two nearest
  // ancestors are a relay this test starts and this test, alive whatever launched the run. Asked
  // from here it needed two live ancestors of the runner, and a serial `bun test` from a shell whose
  // own parent had exited has one (2026-10-11).
  test(
    'the nearest engine is the caller, whichever home registered it',
    async () => {
      const src = (file: string) =>
        JSON.stringify(pathToFileURL(join(import.meta.dir, '..', 'src', file)).href)
      const asker = join(scratch, 'nearest-asker.ts')
      const relay = join(scratch, 'nearest-relay.ts')
      writeFileSync(
        asker,
        [
          `const { processAncestry } = await import(${src('core/process.ts')})`,
          `const { resolveOwnTranscript } = await import(${src('compaction-history.ts')})`,
          'const chain = (await processAncestry(process.pid)) ?? []',
          'const t = await resolveOwnTranscript({',
          '  callerPid: null,',
          '  extraHomes: async () => [process.env.NEAREST_INSTANCE],',
          '})',
          'console.log(JSON.stringify({ chain: chain.slice(0, 2).map((p) => p.pid), sessionId: t.sessionId, home: t.home }))',
        ].join('\n'),
      )
      // The relay starts the asker only when its stdin closes, after both engines are registered.
      writeFileSync(
        relay,
        [
          'await Bun.stdin.text()',
          `const asker = Bun.spawn([process.execPath, ${JSON.stringify(asker)}], { stdout: 'inherit', stderr: 'inherit' })`,
          'process.exit(await asker.exited)',
        ].join('\n'),
      )
      const register = (home: string, pid: number, sid: string) => {
        mkdirSync(join(home, 'sessions'), { recursive: true })
        mkdirSync(join(home, 'projects', 'p'), { recursive: true })
        writeFileSync(join(home, 'projects', 'p', `${sid}.jsonl`), '')
        writeFileSync(
          join(home, 'sessions', `${pid}.json`),
          JSON.stringify({ pid, sessionId: sid, cwd: CWD }),
        )
      }
      const instance = join(scratch, 'nearest-instance')
      const defaultHome = join(scratch, 'nearest-default')
      const nearSid = '12345678-cccc-4ddd-8eee-1234567890ab'
      // A scratch user folder too: the walk also reads ~/.claude's registry, where a crashed
      // session's leftover `<pid>.json` can name a pid Windows has since given to the new relay.
      const user = join(scratch, 'nearest-user')
      const proc = Bun.spawn([process.execPath, relay], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: defaultHome,
          NEAREST_INSTANCE: instance,
          HOME: user,
          USERPROFILE: user,
        },
      })
      register(instance, proc.pid, nearSid)
      register(defaultHome, process.pid, '12345678-dddd-4eee-8fff-1234567890ab')
      proc.stdin.end()
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const answer = out.trim().split('\n').at(-1)
      if ((await proc.exited) !== 0 || !answer) throw new Error(`the asker failed: ${err}`)
      const t = JSON.parse(answer)
      expect(t.chain).toEqual([proc.pid, process.pid])
      expect(t.sessionId).toBe(nearSid)
      expect(t.home).toBe(instance)
    },
    PROCESS_WALK_TEST_MS,
  )
})

describe('every dispatch records who sent it; only a ping origin is pinged', () => {
  let server: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req, srv) => http.fetch(req, srv),
    })
  })
  afterAll(() => server.stop(true))

  test('a declared by: its label and its chat are the trace, and nothing is pinged', async () => {
    const res = await http.fetch(
      new Request('http://127.0.0.1/api/corch/workers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tasks: [task('by a')],
          group: 'og-by',
          origin: null,
          by: { label: 'CreAItor', sessionId: SID },
        }),
      }),
    )
    const r = (await res.json()) as { workers: Array<{ id: string }>; ping: { on: boolean } }
    expect(r.ping.on).toBe(false)
    const w = climayteGet(r.workers[0].id) as { origin?: unknown; trace?: unknown }
    expect(w.origin).toBeUndefined()
    expect(w.trace).toEqual({ sessionId: SID, label: 'CreAItor' })
  })

  test('a by that is malformed is refused with 400, and nothing starts', async () => {
    const res = await http.fetch(
      new Request('http://127.0.0.1/api/corch/workers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tasks: [task('by b')],
          group: 'og-by-bad',
          by: { label: 'x'.repeat(81) },
        }),
      }),
    )
    expect(res.status).toBe(400)
    expect([...workers.values()].some((x) => x.group === 'og-by-bad')).toBe(false)
  })

  test(
    'an untraceable caller is traced as the script that sent it, not as "untraced"',
    async () => {
      const dir = mkdtempSync(join(scratch, 'script-caller-'))
      mkdirSync(join(dir, 'michaiel'))
      const script = join(dir, 'michaiel', 'act.mjs')
      const url = `http://127.0.0.1:${server.port}/api/corch/workers`
      writeFileSync(
        script,
        `const r = await fetch(${JSON.stringify(url)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tasks: [${JSON.stringify(task('traced c'))}], group: 'og-script' }) }); process.stdout.write(await r.text())`,
      )
      setCallerTranscriptResolver(async () => {
        throw new Error('no chat runs this process')
      })
      try {
        const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' })
        const reply = JSON.parse(await new Response(child.stdout).text()) as {
          workers: Array<{ id: string }>
        }
        await child.exited
        const w = climayteGet(reply.workers[0].id) as { origin?: unknown; trace?: unknown }
        expect(w.origin).toBeUndefined()
        expect(w.trace).toEqual({ label: 'michaiel/act.mjs' })
      } finally {
        setCallerTranscriptResolver(async () => caller())
      }
    },
    PROCESS_WALK_TEST_MS,
  )
})
