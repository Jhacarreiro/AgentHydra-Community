// The new core's acceptance probe: the 16 live scenarios the old Desk was smoke-tested with on 2026-10-14, run against
// any server that speaks the chat API (`CORE_URL`, default the new core on 7789; the old Desk is
// `CORE_URL=http://127.0.0.1:7798/api AH_URL=http://127.0.0.1:7787/api`). Each scenario runs in its own throwaway chat
// and folder, all at once, on the owner's real accounts; every chat it makes is deleted and every Codex thread
// archived. Prints PASS/FAIL per scenario with its evidence (states, replies to fixed-word prompts, error sentences),
// never an account label or address. `--json` ends with the stages in pipeline order for frontier.py.
//   bun core/smoke/smoke.ts [--json] [scenario ...]
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { isThrowawayCwd, THROWAWAY_DIR } from '../../desk2/shared/throwaway'
import { connectCodexRpc } from '../../server/src/core/codex-rpc'

const BASE = process.env.CORE_URL ?? 'http://127.0.0.1:7789/api'
/** Where the session-tail probes go: the core itself, or AgentHydra's daemon when the target is the old Desk. */
const AH = process.env.AH_URL ?? BASE
// The one folder the window and Desk never list (desk2/shared/throwaway.ts): every chat here runs under it.
const ROOT = join(tmpdir(), THROWAWAY_DIR)
/** AgentHydra's daemon, which lists every Codex thread on this PC (the cleanup's sweep of the run's folders). */
const DAEMON = process.env.DAEMON_URL ?? 'http://127.0.0.1:7787/api'
/** The Desk that serves the owner's window, whose sidebar must never show this run (stage unlisted). */
const DESK = process.env.DESK_URL ?? 'http://127.0.0.1:7798/api'
const CODEX_HOMES = join(homedir(), '.agenthydra', 'codex-instances')
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const only = args.filter((a) => !a.startsWith('--'))

/** Pipeline order: a later stage leans on what an earlier one proves. */
const STAGES = [
  'boot',
  'bad-input',
  'claude-basic',
  'history-paging',
  'codex-queue',
  'codex-image',
  'codex-interrupt',
  'codex-delete-mid-turn',
  'chatgpt-image',
  'chatgpt-oversize',
  'codex-import-race',
  'codex-held-elsewhere',
  'switch-while-busy',
  'claude-to-codex-mid-turn',
  'crossing-cancel',
  'crossing-double-switch',
  'crossing-delete',
  'handoff-roundtrip',
  // Phase 2 (owner, 2026-10-14: CliMayte, HSwarm and the orchestration are the same A + B = C): a task runs on the
  // cheapest account or model with room that can do its tools. todo while the core answers POST /tasks with 404.
  'task-claude',
  'task-api',
  'task-many',
  'task-cancel',
  // Last: nothing the run made shows in the window (desk2/shared/throwaway.ts).
  'unlisted',
]

type Item = {
  kind: string
  text?: string
  ok?: boolean
  error?: string
  id: string
  queued?: boolean
  level?: string
}
type Thread = { accountId: string; threadId: string }
type Chat = {
  id: string
  status: string
  service?: string | null
  sessionId: string | null
  lastError: string | null
  queuedCount?: number
  serviceThreads?: { codex?: Thread; chatgpt?: Thread }
}
type Reply = { status: number; json: any; text: string }

async function req(method: string, path: string, body?: unknown, base = BASE): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  return { status: res.status, json, text }
}
async function ok<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await req(method, path, body)
  if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${r.text.slice(0, 240)}`)
  return r.json as T
}

const chats: string[] = []
const running = new AsyncLocalStorage<string>()
const madeBy = new Map<string, string>()
const threads: Thread[] = []
const keep = (t?: Thread) => {
  if (t && !threads.some((x) => x.threadId === t.threadId)) threads.push(t)
}
async function create(name: string, service?: 'codex' | 'chatgpt'): Promise<Chat> {
  const cwd = join(ROOT, name)
  mkdirSync(cwd, { recursive: true })
  const chat = await ok<Chat>('POST', '/chats', { cwd, title: `smoke ${name} (throwaway)` })
  chats.push(chat.id)
  madeBy.set(chat.id, running.getStore() ?? '')
  // One sidebar group for the whole run, not a group per scenario folder (owner, 2026-10-14: "these probably shouldn't be here").
  await ok('PATCH', `/chats/${chat.id}`, { group: 'Smoke tests (throwaway)' })
  if (service) await ok('PATCH', `/chats/${chat.id}`, { service })
  return chat
}
/** A chat an import made: cleaned up, explained on failure and kept in the run's one sidebar group, as create()'s are. */
async function adopt(id: string): Promise<void> {
  if (chats.includes(id)) return
  chats.push(id)
  madeBy.set(id, running.getStore() ?? '')
  await ok('PATCH', `/chats/${id}`, { group: 'Smoke tests (throwaway)' })
}
const items = (id: string) => ok<Item[]>('GET', `/chats/${id}/items`)
const chat = (id: string) => ok<Chat>('GET', `/chats/${id}`)
const results = async (id: string) => (await items(id)).filter((i) => i.kind === 'result')
const replies = async (id: string) =>
  (await items(id))
    .filter((i) => i.kind === 'assistant_text')
    .map((i) => (i.text ?? '').trim().slice(0, 60))
const lines = async (id: string) =>
  (await items(id)).filter((i) => i.kind === 'system').map((i) => (i.text ?? '').slice(0, 140))
const send = (id: string, text: string) =>
  ok<{ queued?: boolean }>('POST', `/chats/${id}/messages`, { text })
async function settle(id: string, n: number, ms = 240_000): Promise<Chat> {
  const end = Date.now() + ms
  for (;;) {
    const c = await chat(id)
    keep(c.serviceThreads?.codex)
    if ((await results(id)).length >= n && !busy(c.status)) return c
    if (Date.now() > end)
      throw new Error(
        `timed out: status ${c.status}, ${(await results(id)).length} of ${n} results`,
      )
    await Bun.sleep(1500)
  }
}
/** Sends and waits for the answer: a new reply (or a new result, for a turn that failed) and the chat no longer busy. */
async function ask(id: string, text: string, ms = 240_000): Promise<Chat> {
  const r0 = (await replies(id)).length
  const n0 = (await results(id)).length
  await send(id, text)
  const end = Date.now() + ms
  for (;;) {
    await Bun.sleep(1500)
    const c = await chat(id)
    keep(c.serviceThreads?.codex)
    if (!busy(c.status) && ((await replies(id)).length > r0 || (await results(id)).length > n0))
      return c
    if (Date.now() > end) throw new Error(`timed out: status ${c.status}`)
  }
}
async function until(cond: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await Bun.sleep(500)
  }
  return false
}
const busy = (status: string) => status === 'working' || status === 'starting'
const word = (s: string | undefined) => (s ?? '').replace(/[^A-Za-z0-9-]/g, '').toUpperCase()

/** A solid red 64x64 PNG, as base64. */
function redPng(): string {
  const { deflateSync } = require('node:zlib') as typeof import('node:zlib')
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const w = 64
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(w, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([255, 0, 0]))])
  const raw = Buffer.concat(Array.from({ length: w }, () => row))
  const png = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]
  return Buffer.concat(png).toString('base64')
}
const sendImage = (id: string, text: string) =>
  ok<{ queued?: boolean }>('POST', `/chats/${id}/messages`, {
    text,
    images: [{ mediaType: 'image/png', dataBase64: redPng(), name: 'red.png' }],
  })

/** A task (phase 2): POST /tasks {prompt, cwd, tools}; GET /tasks/:id, /tasks/:id/wait?seconds=N; POST /tasks/:id/cancel. */
type TaskRow = {
  id: string
  status: string
  result?: string
  error?: string
  backend?: string
  account?: { service?: string }
}
const TASK_TODO = { pass: false, todo: true, detail: 'POST /tasks answers 404: not built yet' }
async function startTask(body: {
  prompt: string
  cwd: string
  tools: string
}): Promise<TaskRow | null> {
  const made = await req('POST', '/tasks', { ...body, title: 'smoke task (throwaway)' })
  if (made.status === 404) return null
  if (made.status >= 300) throw new Error(`POST /tasks: ${made.status} ${made.text.slice(0, 200)}`)
  return made.json as TaskRow
}
/** Waits on the core's own wait (one call per 30 s, never a tight poll) until the task settles. */
async function waitTask(id: string, ms = 300_000): Promise<TaskRow> {
  const end = Date.now() + ms
  for (;;) {
    const r = await ok<TaskRow>('GET', `/tasks/${id}/wait?seconds=30`)
    if (['done', 'failed', 'cancelled'].includes(r.status)) return r
    if (Date.now() > end) throw new Error(`timed out: task ${r.status}`)
  }
}
const taskDetail = (t: TaskRow) => ({
  status: t.status,
  result: (t.result ?? '').slice(0, 60),
  error: t.error,
  route: t.backend ?? t.account?.service ?? null,
})

type Outcome = { pass: boolean; detail: unknown; todo?: boolean }
const out = new Map<string, Outcome & { seconds: number }>()
async function scenario(name: string, run: () => Promise<Outcome>): Promise<void> {
  if (only.length && !only.includes(name)) return
  const t = Date.now()
  let r: Outcome
  try {
    r = await running.run(name, run)
    if (!r.pass)
      await why(name).catch((err) =>
        console.log(`  WHY ${name} failed: ${err instanceof Error ? err.message : String(err)}`),
      )
  } catch (err) {
    r = { pass: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` }
  }
  const seconds = Math.round((Date.now() - t) / 1000)
  out.set(name, { ...r, seconds })
  console.log(
    `${r.pass ? 'PASS' : 'FAIL'} ${name} (${seconds} s) ${JSON.stringify(r.detail).slice(0, 700)}`,
  )
}

async function why(name: string): Promise<void> {
  for (const [id, by] of madeBy) {
    if (by !== name) continue
    const got = await req('GET', `/chats/${id}`).catch(() => null)
    const its = await req('GET', `/chats/${id}/items`).catch(() => null)
    // A chat the scenario deleted answers 404 with an error object, not a list.
    const all = (Array.isArray(its?.json) ? its.json : []) as Item[]
    const errs = all
      .filter((i) => i.kind === 'result' && i.error)
      .map((i) => String(i.error).slice(0, 160))
    const warn = all
      .filter((i) => i.kind === 'system' && i.level === 'warn')
      .map((i) => (i.text ?? '').slice(0, 160))
    const lastError = JSON.stringify((got?.json as Chat | null)?.lastError ?? null)
    console.log(
      `  WHY ${name} ${id.slice(0, 8)}: status=${got?.status} lastError=${lastError} errors=${JSON.stringify(errs)} warn=${JSON.stringify(warn)}`,
    )
  }
}

/** A Codex thread made through a chat, then left as an outside chat (the chat deleted). */
async function outsideThread(name: string): Promise<Thread> {
  const c = await create(name, 'codex')
  await send(c.id, 'Reply with exactly the word PINOK and nothing else. Do not run any command.')
  const done = await settle(c.id, 1)
  const t = done.serviceThreads?.codex
  if (!t) throw new Error('no thread bound')
  keep(t)
  await ok('DELETE', `/chats/${c.id}`)
  chats.splice(chats.indexOf(c.id), 1)
  const listed = await until(
    async () =>
      // Its own thread: the default list never shows the probe's folder (desk2/shared/throwaway.ts).
      ((await ok<{ id: string }[]>('GET', '/external/sessions?throwaway=1')) ?? []).some(
        (s) => s.id === t.threadId,
      ),
    300_000,
  )
  if (!listed) throw new Error('thread never listed as outside')
  return t
}

/** Tries to archive a Codex thread for up to `ms`; how long it took, or -1. */
async function archive(t: Thread, ms: number): Promise<number> {
  const from = Date.now()
  while (Date.now() - from < ms) {
    const rpc = await connectCodexRpc(join(CODEX_HOMES, t.accountId))
    try {
      await rpc.call('thread/archive', { threadId: t.threadId })
      return Date.now() - from
    } catch {
    } finally {
      await rpc.close()
    }
    await Bun.sleep(1000)
  }
  return -1
}

const bootRes = await req('GET', '/chats').catch(
  (err) => ({ status: 0, json: null, text: String(err) }) as Reply,
)
const up = bootRes.status === 200 && Array.isArray(bootRes.json)
out.set('boot', {
  pass: up,
  detail: up
    ? { chats: bootRes.json.length }
    : { status: bootRes.status, text: bootRes.text.slice(0, 160) },
  seconds: 0,
})
console.log(`${up ? 'PASS' : 'FAIL'} boot ${JSON.stringify(out.get('boot')!.detail)}`)

if (up)
  await Promise.all([
    scenario('claude-basic', async () => {
      const c = await create('claude')
      const done = await ask(c.id, 'Reply with exactly the word HELLO and nothing else.')
      const last = (await replies(c.id)).at(-1)
      return {
        pass: word(last) === 'HELLO' && done.status === 'idle',
        detail: { last, status: done.status, lastError: done.lastError },
      }
    }),

    scenario('codex-queue', async () => {
      const c = await create('queue', 'codex')
      const a = await send(
        c.id,
        'Reply with exactly the word ONE and nothing else. Do not run any command.',
      )
      const b = await send(
        c.id,
        'Reply with exactly the word TWO and nothing else. Do not run any command.',
      )
      const done = await settle(c.id, 2)
      const r = await replies(c.id)
      const q = (await items(c.id)).filter((i) => i.kind === 'user').map((i) => i.queued ?? false)
      const pass =
        !a.queued &&
        b.queued === true &&
        word(r.at(-2)) === 'ONE' &&
        word(r.at(-1)) === 'TWO' &&
        done.status === 'idle' &&
        !done.queuedCount &&
        q.every((x) => !x)
      return {
        pass,
        detail: {
          queued: [a.queued, b.queued],
          replies: r,
          status: done.status,
          queuedCount: done.queuedCount,
          stillMarkedQueued: q,
        },
      }
    }),

    scenario('codex-interrupt', async () => {
      const c = await create('interrupt', 'codex')
      await send(
        c.id,
        'Write the numbers from 1 to 400, one per line, with no other text. Do not run any command.',
      )
      const wasRunning = await until(async () => busy((await chat(c.id)).status), 60_000)
      await Bun.sleep(1500)
      await ok('POST', `/chats/${c.id}/interrupt`)
      const stopped = await until(async () => !busy((await chat(c.id)).status), 15_000)
      const r1 = await results(c.id)
      await send(
        c.id,
        'Reply with exactly the word AFTER and nothing else. Do not run any command.',
      )
      const done = await settle(c.id, 2)
      const r = await replies(c.id)
      const pass =
        wasRunning &&
        stopped &&
        r1.at(-1)?.error === 'Interrupted' &&
        word(r.at(-1)) === 'AFTER' &&
        done.status === 'idle'
      return {
        pass,
        detail: {
          running: wasRunning,
          stopped,
          first: r1.map((x) => x.ok ?? x.error),
          last: r.at(-1),
          status: done.status,
          lastError: done.lastError,
        },
      }
    }),

    scenario('handoff-roundtrip', async () => {
      const c = await create('roundtrip')
      await ask(c.id, 'Remember the code word ZEBRA42. Reply with exactly OK and nothing else.')
      await ok('PATCH', `/chats/${c.id}`, { service: 'codex' })
      await ask(
        c.id,
        'What code word did I ask you to remember? Reply with just that word. Do not run any command.',
      )
      const onCodex = (await replies(c.id)).at(-1)
      await ok('PATCH', `/chats/${c.id}`, { service: 'chatgpt' })
      await ask(
        c.id,
        'Remember a second word: MANGO. Then reply with just the first code word I gave, nothing else.',
      )
      const onGpt = (await replies(c.id)).at(-1)
      await ok('PATCH', `/chats/${c.id}`, { service: null })
      const done = await ask(
        c.id,
        'What second word did I give you, after the code word? Reply with just that word.',
      )
      const onClaude = (await replies(c.id)).at(-1)
      const pass =
        word(onCodex) === 'ZEBRA42' &&
        word(onGpt) === 'ZEBRA42' &&
        word(onClaude) === 'MANGO' &&
        done.status === 'idle'
      return {
        pass,
        detail: { onCodex, onGpt, onClaude, status: done.status, lines: await lines(c.id) },
      }
    }),

    scenario('chatgpt-oversize', async () => {
      const c = await create('oversize', 'chatgpt')
      await send(c.id, `Reply OK. ${'x'.repeat(100_001)}`)
      const done = await settle(c.id, 1, 60_000)
      const r = await results(c.id)
      await send(c.id, 'Reply with exactly the word SMALL and nothing else.')
      const after = await settle(c.id, 2)
      const last = (await replies(c.id)).at(-1)
      const pass =
        /up to 100,000 characters/.test(r.at(-1)?.error ?? '') &&
        word(last) === 'SMALL' &&
        after.status === 'idle'
      return {
        pass,
        detail: {
          first: r.at(-1)?.error,
          statusAfterFirst: done.status,
          last,
          status: after.status,
        },
      }
    }),

    scenario('bad-input', async () => {
      const c = await create('badinput')
      const probes: Record<string, number> = {
        'pin foo': (await req('PATCH', `/chats/${c.id}`, { service: 'foo' })).status,
        'pin claude string': (await req('PATCH', `/chats/${c.id}`, { service: 'claude' })).status,
        'pin missing chat': (
          await req('PATCH', '/chats/00000000-0000-4000-8000-000000000000', { service: 'codex' })
        ).status,
        'import empty': (await req('POST', '/chats/import', { sessionId: '' })).status,
        'import unknown': (await req('POST', '/chats/import', { sessionId: 'nope-not-a-session' }))
          .status,
        'import no body': (await req('POST', '/chats/import')).status,
        'older -1': (await req('GET', '/external/sessions/nope/older?before=-1')).status,
        'older abc': (await req('GET', '/external/sessions/nope/older?before=abc')).status,
        'tail before -1': (await req('GET', '/sessions/nope/tail?before=-1', undefined, AH)).status,
        'tail before abc': (await req('GET', '/sessions/nope/tail?before=abc', undefined, AH))
          .status,
        'tail before huge': (await req('GET', '/sessions/nope/tail?before=1e300', undefined, AH))
          .status,
        'send empty': (await req('POST', `/chats/${c.id}/messages`, { text: '' })).status,
        'interrupt idle': (await req('POST', `/chats/${c.id}/interrupt`)).status,
        'cancel-queued unknown': (
          await req('POST', `/chats/${c.id}/cancel-queued`, { itemId: 'nope' })
        ).status,
      }
      // No 5xx, and a bad pin or an unknown chat is refused, not taken.
      const five = Object.entries(probes).filter(([, s]) => s >= 500)
      const refused =
        probes['pin foo']! >= 400 &&
        probes['pin missing chat'] === 404 &&
        probes['import empty']! >= 400 &&
        probes['send empty']! >= 400
      return { pass: five.length === 0 && refused, detail: probes }
    }),

    scenario('codex-delete-mid-turn', async () => {
      const c = await create('deletemid', 'codex')
      await send(
        c.id,
        'Write the numbers from 1 to 400, one per line, with no other text. Do not run any command.',
      )
      await until(
        async () => !!(await chat(c.id)).serviceThreads?.codex && busy((await chat(c.id)).status),
        60_000,
      )
      const t = (await chat(c.id)).serviceThreads?.codex
      keep(t)
      await Bun.sleep(1500)
      const del = await req('DELETE', `/chats/${c.id}`)
      chats.splice(chats.indexOf(c.id), 1)
      // The server let go of the thread: another program may write it within seconds. Freed at once when the account's
      // app-server ends; about 60 s after thread/unsubscribe when other chats keep it up (measured 2026-10-14).
      const freed = t ? await archive(t, 75_000) : -1
      if (freed >= 0 && t) threads.splice(threads.indexOf(t), 1)
      const gone = (await req('GET', `/chats/${c.id}`)).status
      const pass = del.status < 300 && gone === 404 && freed >= 0
      return {
        pass,
        detail: {
          delete: del.status,
          after: gone,
          threadFreedMs: freed,
          case:
            freed < 0
              ? 'never freed'
              : freed < 15_000
                ? 'app-server ended'
                : 'unloaded after unsubscribe',
        },
      }
    }),

    scenario('codex-import-race', async () => {
      const t = await outsideThread('race')
      const [a, b] = await Promise.all([
        ok<Chat>('POST', '/chats/import', { sessionId: t.threadId }),
        ok<Chat>('POST', '/chats/import', { sessionId: t.threadId }),
      ])
      for (const id of new Set([a.id, b.id])) await adopt(id)
      const list = (await ok<Chat[]>('GET', '/chats')).filter(
        (x) => x.serviceThreads?.codex?.threadId === t.threadId,
      )
      return {
        pass: a.id === b.id && list.length === 1,
        detail: { same: a.id === b.id, chatsOnThread: list.length },
      }
    }),

    scenario('codex-held-elsewhere', async () => {
      const t = await outsideThread('held')
      // Another program holds the thread (as the Codex app would): the server must say so and start no new thread.
      const holder = spawn(
        'bun',
        [join(import.meta.dir, 'codex-hold.ts'), t.accountId, t.threadId],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
      let said = ''
      holder.stdout.on('data', (d) => (said += String(d)))
      holder.stderr.on('data', (d) => (said += String(d)))
      const exited = new Promise((r) => holder.once('exit', r))
      const holding =
        (await until(
          async () => said.includes('holding') || said.includes('hold failed'),
          90_000,
        )) && said.includes('holding')
      const imported = await ok<Chat>('POST', '/chats/import', { sessionId: t.threadId })
      await adopt(imported.id)
      await send(
        imported.id,
        'Reply with exactly the word HELD and nothing else. Do not run any command.',
      )
      const first = await settle(imported.id, 1, 120_000)
      const firstLine = (await results(imported.id)).at(-1)?.error
      const sameThread1 = first.serviceThreads?.codex?.threadId === t.threadId
      holder.stdin.end()
      await Promise.race([exited, Bun.sleep(15_000)])
      if (holder.exitCode === null) holder.kill()
      await send(
        imported.id,
        'Reply with exactly the word FREE and nothing else. Do not run any command.',
      )
      const second = await settle(imported.id, 2)
      const last = (await replies(imported.id)).at(-1)
      const sameThread2 = second.serviceThreads?.codex?.threadId === t.threadId
      const pass =
        holding &&
        /open in|holds|active writer|Codex app/i.test(firstLine ?? '') &&
        sameThread1 &&
        word(last) === 'FREE' &&
        sameThread2
      return {
        pass,
        detail: {
          holding,
          firstError: firstLine,
          sameThread1,
          last,
          sameThread2,
          holderSaid: said.trim().slice(0, 200),
        },
      }
    }),

    scenario('switch-while-busy', async () => {
      const c = await create('switchbusy', 'codex')
      await send(
        c.id,
        'Write the numbers from 1 to 300, one per line, with no other text. Do not run any command.',
      )
      await until(async () => busy((await chat(c.id)).status), 60_000)
      const wasBusy = busy((await chat(c.id)).status)
      const pin = await req('PATCH', `/chats/${c.id}`, { service: 'chatgpt' })
      const sent = await req('POST', `/chats/${c.id}/messages`, {
        text: 'Reply with exactly the word SWITCHED and nothing else.',
      })
      const shownQueued = (await items(c.id)).some((i) => i.kind === 'user' && i.queued === true)
      const answered = await until(
        async () =>
          word((await replies(c.id)).at(-1)) === 'SWITCHED' && !busy((await chat(c.id)).status),
        240_000,
      )
      const r = await replies(c.id)
      const rs = (await results(c.id)).map((x) => x.ok ?? x.error)
      const done = await chat(c.id)
      const pass =
        wasBusy &&
        pin.status < 300 &&
        sent.json?.queued === true &&
        shownQueued &&
        answered &&
        rs.length === 2 &&
        rs.every((x) => x === true) &&
        done.status === 'idle'
      return {
        pass,
        detail: {
          wasBusy,
          pin: pin.status,
          sent: [sent.status, sent.text.slice(0, 80)],
          shownQueued,
          results: rs,
          last: r.at(-1),
          status: done.status,
          lines: await lines(c.id),
        },
      }
    }),

    scenario('claude-to-codex-mid-turn', async () => {
      const c = await create('claudemid')
      await send(
        c.id,
        'Remember the code word KIWI7. Then write the numbers from 1 to 150, one per line.',
      )
      await until(async () => busy((await chat(c.id)).status), 90_000)
      const wasBusy = busy((await chat(c.id)).status)
      const pin = await req('PATCH', `/chats/${c.id}`, { service: 'codex' })
      const sent = await send(
        c.id,
        'What code word did I give you? Reply with just that word. Do not run any command.',
      )
      const answered = await until(
        async () =>
          word((await replies(c.id)).at(-1)) === 'KIWI7' && !busy((await chat(c.id)).status),
        300_000,
      )
      const done = await chat(c.id)
      const last = (await replies(c.id)).at(-1)
      return {
        pass:
          wasBusy && pin.status < 300 && sent.queued === true && answered && done.status === 'idle',
        detail: { wasBusy, pin: pin.status, queued: sent.queued, last, status: done.status },
      }
    }),

    // A message waiting for Codex's reply (the pin moved to ChatGPT mid-reply) is taken back: nothing is sent, and the
    // next message goes to ChatGPT as usual.
    scenario('crossing-cancel', async () => {
      const c = await create('xcancel', 'codex')
      await send(
        c.id,
        'Write the numbers from 1 to 300, one per line, with no other text. Do not run any command.',
      )
      await until(async () => busy((await chat(c.id)).status), 60_000)
      await ok('PATCH', `/chats/${c.id}`, { service: 'chatgpt' })
      const sent = await send(c.id, 'Reply with exactly the word NOPE and nothing else.')
      const waiting = (await items(c.id)).find((i) => i.kind === 'user' && i.queued === true)
      const cancel = waiting
        ? await req('POST', `/chats/${c.id}/cancel-queued`, { itemId: waiting.id })
        : null
      const idle = await until(async () => !busy((await chat(c.id)).status), 240_000)
      await Bun.sleep(20_000)
      const nope = (await replies(c.id)).some((r) => word(r) === 'NOPE')
      const stillShown = (await items(c.id)).some((i) => i.id === waiting?.id)
      const turns = (await results(c.id)).length
      const next = await ask(c.id, 'Reply with exactly the word AFTERCANCEL and nothing else.')
      const last = (await replies(c.id)).at(-1)
      const pass =
        sent.queued === true &&
        !!waiting &&
        cancel?.json?.cancelled === true &&
        idle &&
        !nope &&
        !stillShown &&
        turns === 1 &&
        word(last) === 'AFTERCANCEL' &&
        !busy(next.status)
      return {
        pass,
        detail: {
          queued: sent.queued,
          waiting: !!waiting,
          cancel: cancel && [cancel.status, cancel.text.slice(0, 120)],
          idle,
          nope,
          stillShown,
          turns,
          last,
          lines: await lines(c.id),
        },
      }
    }),

    // The pin moves twice while Codex replies (to ChatGPT, then back to Claude): the waiting message goes to Claude only.
    scenario('crossing-double-switch', async () => {
      const c = await create('xdouble', 'codex')
      await send(
        c.id,
        'Write the numbers from 1 to 300, one per line, with no other text. Do not run any command.',
      )
      await until(async () => busy((await chat(c.id)).status), 60_000)
      await ok('PATCH', `/chats/${c.id}`, { service: 'chatgpt' })
      const sent = await send(
        c.id,
        'Reply with exactly the word DOUBLE and nothing else. Do not run any command.',
      )
      const back = await req('PATCH', `/chats/${c.id}`, { service: null })
      const answered = await until(
        async () =>
          word((await replies(c.id)).at(-1)) === 'DOUBLE' && !busy((await chat(c.id)).status),
        300_000,
      )
      const done = await chat(c.id)
      // ChatGPT never ran: no catch-up line between the pin to ChatGPT and the pin back, and no more than Codex's turn
      // and Claude's (the old Desk's Claude worker writes no result; a core's Claude turn may).
      const said = await lines(c.id)
      const toGpt = said.findIndex((l) => /now runs on ChatGPT/.test(l))
      const toClaude = said.findIndex((l) => /runs on Claude again/.test(l))
      const gptRan =
        toGpt < 0 ||
        toClaude < toGpt ||
        said.slice(toGpt + 1, toClaude).some((l) => /Caught up/.test(l))
      const turns = (await results(c.id)).length
      const pass =
        sent.queued === true &&
        back.status < 300 &&
        answered &&
        !gptRan &&
        turns <= 2 &&
        (done.service ?? null) === null &&
        !busy(done.status)
      return {
        pass,
        detail: {
          queued: sent.queued,
          back: back.status,
          answered,
          gptRan,
          turns,
          service: done.service ?? null,
          status: done.status,
          last: (await replies(c.id)).at(-1),
          lines: said,
        },
      }
    }),

    // The chat is deleted while a message waits for Codex's reply: nothing is sent, and the server stays well.
    scenario('crossing-delete', async () => {
      const c = await create('xdelete', 'codex')
      await send(
        c.id,
        'Write the numbers from 1 to 300, one per line, with no other text. Do not run any command.',
      )
      await until(
        async () => busy((await chat(c.id)).status) && !!(await chat(c.id)).serviceThreads?.codex,
        60_000,
      )
      keep((await chat(c.id)).serviceThreads?.codex)
      await ok('PATCH', `/chats/${c.id}`, { service: 'chatgpt' })
      const sent = await send(c.id, 'Reply with exactly the word GONE and nothing else.')
      const del = await req('DELETE', `/chats/${c.id}`)
      chats.splice(chats.indexOf(c.id), 1)
      await Bun.sleep(30_000)
      const after = await req('GET', `/chats/${c.id}`)
      const list = await req('GET', '/chats')
      const back = ((list.json ?? []) as Chat[]).some((x) => x.id === c.id)
      const pass =
        sent.queued === true &&
        del.status < 300 &&
        after.status >= 400 &&
        list.status === 200 &&
        !back
      return {
        pass,
        detail: {
          queued: sent.queued,
          del: del.status,
          after: after.status,
          list: list.status,
          back,
        },
      }
    }),

    scenario('codex-image', async () => {
      const c = await create('image', 'codex')
      const n0 = (await replies(c.id)).length
      await sendImage(
        c.id,
        'What single colour fills this picture? Reply with just the colour name. Do not run any command.',
      )
      const answered = await until(
        async () => (await replies(c.id)).length > n0 && !busy((await chat(c.id)).status),
        240_000,
      )
      const last = (await replies(c.id)).at(-1)
      return {
        pass: answered && /red/i.test(last ?? ''),
        detail: {
          last,
          results: (await results(c.id)).map((x) => x.ok ?? x.error),
          lines: await lines(c.id),
        },
      }
    }),

    scenario('chatgpt-image', async () => {
      const c = await create('gptimage', 'chatgpt')
      const n0 = (await replies(c.id)).length
      await sendImage(c.id, 'Reply with exactly the word TEXTONLY and nothing else.')
      const answered = await until(
        async () => (await replies(c.id)).length > n0 && !busy((await chat(c.id)).status),
        240_000,
      )
      const said = await lines(c.id)
      const last = (await replies(c.id)).at(-1)
      return {
        pass: answered && said.some((l) => /reads text only/.test(l)) && word(last) === 'TEXTONLY',
        detail: { last, lines: said },
      }
    }),

    scenario('history-paging', async () => {
      // The newest outside Claude chat with older pages: every page above its tail, newest first, until the start.
      const list = (await ok<{ id: string; source?: string }[]>('GET', '/external/sessions'))
        .filter((s) => s.source !== 'codex')
        .slice(0, 15)
      for (const s of list) {
        const first = await fetch(`${BASE}/external/sessions/${s.id}/items`)
        if (!first.ok) continue
        let before = Number(first.headers.get('x-older-before') ?? Number.NaN)
        if (!(Number.isFinite(before) && before > 0)) continue
        const firstPage = ((await first.json()) as Item[]).filter((i) =>
          ['user', 'assistant_text', 'system'].includes(i.kind),
        ).length
        let msgs = firstPage
        let pages = 0
        const seen = new Set<number>()
        while (Number.isFinite(before) && before > 0 && pages < 40) {
          if (seen.has(before)) return { pass: false, detail: { loop: before, pages } }
          seen.add(before)
          const r = await fetch(`${BASE}/external/sessions/${s.id}/older?before=${before}`)
          if (!r.ok) return { pass: false, detail: { olderStatus: r.status, pages } }
          const got = (await r.json()) as Item[]
          msgs += got.filter((i) => ['user', 'assistant_text', 'system'].includes(i.kind)).length
          before = Number(r.headers.get('x-older-before') ?? Number.NaN)
          pages++
        }
        const reachedStart = !(Number.isFinite(before) && before > 0)
        return {
          pass: pages >= 1 && reachedStart && msgs > firstPage,
          detail: { firstPage, msgs, pages, reachedStart },
        }
      }
      return {
        pass: false,
        detail: { checked: list.length, why: 'no outside Claude chat listed with an older page' },
      }
    }),

    // A task with tools runs on an agent account and uses them: it reads a file only it can see.
    scenario('task-claude', async () => {
      const cwd = join(ROOT, 'task-read')
      mkdirSync(cwd, { recursive: true })
      await Bun.write(join(cwd, 'WORD.txt'), 'TASKREAD')
      const t = await startTask({
        prompt:
          'Read the file WORD.txt in this folder and reply with exactly its contents and nothing else.',
        cwd,
        tools: 'read',
      })
      if (!t) return TASK_TODO
      const done = await waitTask(t.id)
      return {
        pass: done.status === 'done' && word(done.result) === 'TASKREAD',
        detail: taskDetail(done),
      }
    }),

    // A tool-free task goes to the cheapest route with room (a Free web login or an API model).
    scenario('task-api', async () => {
      const t = await startTask({
        prompt: 'Reply with exactly the word TASKAPI and nothing else.',
        cwd: ROOT,
        tools: 'none',
      })
      if (!t) return TASK_TODO
      const done = await waitTask(t.id)
      return {
        pass: done.status === 'done' && word(done.result) === 'TASKAPI',
        detail: taskDetail(done),
      }
    }),

    // Six at once, as a fan-out sends them: each finishes with its own answer.
    scenario('task-many', async () => {
      const words = [1, 2, 3, 4, 5, 6].map((n) => `MANY${n}`)
      const started = await Promise.all(
        words.map((w) =>
          startTask({
            prompt: `Reply with exactly the word ${w} and nothing else.`,
            cwd: ROOT,
            tools: 'none',
          }),
        ),
      )
      if (started.some((t) => !t)) return TASK_TODO
      const done = await Promise.all(started.map((t) => waitTask(t!.id)))
      const got = done.map((d) => word(d.result))
      return {
        pass: done.every((d) => d.status === 'done') && got.every((g, i) => g === words[i]),
        detail: { got, routes: done.map((d) => d.backend ?? d.account?.service ?? null) },
      }
    }),

    // A running task is stopped: it reads cancelled, and nothing more comes of it.
    scenario('task-cancel', async () => {
      const cwd = join(ROOT, 'task-cancel')
      mkdirSync(cwd, { recursive: true })
      const t = await startTask({
        prompt:
          'Write the numbers from 1 to 3000, one per line, with no other text. Do not run any command.',
        cwd,
        tools: 'read',
      })
      if (!t) return TASK_TODO
      const running = await until(
        async () => (await ok<TaskRow>('GET', `/tasks/${t.id}`)).status === 'running',
        120_000,
      )
      const cancel = await req('POST', `/tasks/${t.id}/cancel`)
      const stopped = await until(
        async () => (await ok<TaskRow>('GET', `/tasks/${t.id}`)).status === 'cancelled',
        20_000,
      )
      return {
        pass: running && cancel.status < 300 && stopped,
        detail: {
          running,
          cancel: cancel.status,
          stopped,
          last: taskDetail(await ok<TaskRow>('GET', `/tasks/${t.id}`)),
        },
      }
    }),
  ])

// Read before the cleanup, while every session the run made still exists (owner, 2026-10-14: a round's chats filled
// the sidebar until its cleanup ran): Desk's outside list holds none of them.
await scenario('unlisted', async () => {
  const listed = (await req('GET', '/external/sessions', undefined, DESK).catch(() => null))
    ?.json as { id: string; cwd?: string | null }[] | null
  if (!Array.isArray(listed))
    return { pass: false, detail: 'Desk did not answer /external/sessions' }
  const shown = listed.filter((s) => isThrowawayCwd(s.cwd)).map((s) => s.id.slice(0, 8))
  return { pass: shown.length === 0, detail: { checked: listed.length, shown } }
})

// Cleanup: every chat made here, then every thread, then (on the old Desk) the CliMayte workers its chats ran on.
/** A cleanup call, retried for a minute while the server restarts. */
async function patient(method: string, path: string): Promise<Reply | null> {
  for (let i = 0; i < 30; i++) {
    try {
      return await req(method, path)
    } catch {
      await Bun.sleep(2000)
    }
  }
  return null
}
for (const id of chats) {
  keep(((await patient('GET', `/chats/${id}`))?.json as Chat | null)?.serviceThreads?.codex)
  const del = await patient('DELETE', `/chats/${id}`)
  if (!del || (del.status >= 300 && del.status !== 404))
    console.log(`cleanup chat ${id.slice(0, 8)} NOT deleted: ${del?.status ?? 'unreachable'}`)
}
await Bun.sleep(1500)
// A thread a stage made but never saw (its chat gone before this read it) is the run's too: every Codex thread in a folder
// under ROOT goes as well (2026-10-14: 'smoke interrupt (throwaway)' stayed in the Codex list after a run).
const listed = (await req('GET', '/codex-chats', undefined, DAEMON).catch(() => null))?.json as {
  rows?: { instanceId: string; threadId: string; cwd?: string }[]
} | null
for (const r of listed?.rows ?? [])
  if (String(r.cwd).includes('agenthydra-smoke'))
    keep({ accountId: r.instanceId, threadId: r.threadId })
for (const t of threads)
  console.log(
    `cleanup thread ${t.threadId.slice(0, 8)} ${(await archive(t, 15_000)) >= 0 ? 'archived' : 'NOT archived'}`,
  )
if (process.env.AH_URL) {
  const rows = (await req('GET', '/corch/workers?lean=1', undefined, AH)).json as
    | { id: string; cwd?: string; status?: string }[]
    | null
  const done = (rows ?? [])
    .filter(
      (w) =>
        String(w.cwd ?? '').includes('agenthydra-smoke') &&
        ['done', 'failed', 'cancelled'].includes(String(w.status)),
    )
    .map((w) => w.id)
  if (done.length)
    console.log(
      `cleanup workers removed: ${(await req('POST', '/corch/remove', { ids: done }, AH)).status}`,
    )
}

const stages = STAGES.filter((s) => s === 'boot' || !only.length || only.includes(s)).map(
  (name) => {
    const r = out.get(name)
    if (!r)
      return {
        name,
        status: up ? 'skipped' : 'todo',
        detail: up ? 'not run' : 'the server is not up',
      }
    const status = r.pass ? 'pass' : r.todo ? 'todo' : 'fail'
    return { name, status, seconds: r.seconds, detail: r.detail }
  },
)
const passed = stages.filter((s) => s.name !== 'boot' && s.status === 'pass').length
console.log(
  `SUMMARY ${passed} of ${stages.length - 1} passed: ${
    stages
      .filter((s) => s.status !== 'pass')
      .map((s) => s.name)
      .join(', ') || 'none failed'
  }`,
)
if (asJson) console.log(JSON.stringify({ stages }))
