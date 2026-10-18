import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JOURNAL_PATH } from '../src/climayte-core'
import { readJournal } from '../src/climayte-journal'
import { DRONE_REFUSAL } from '../src/climayte-lib'
import { chatPaths } from '../src/hydra-core/paths'
import { CORE_TOOLS } from '../src/mcp-core'
import { FAN_OUT_TOOLS } from '../src/mcp-fan-out'
import { callerOrigin, callerRole, setCallerTranscriptResolver } from '../src/mcp-self'
import { scratch } from './hydra-core-fixture'

const PRIME = 'chat-prime'
const FOLDER = 'D:/example/folder'
const OTHER = 'chat-other'
const OWNER = 'chat-owner'

type Row = {
  id: string
  role: string
  sessionId: string
  sessions?: string[]
  desk?: { chatId: string }
}

let dir = ''
let savedFetch: typeof fetch
let savedWorker: string | undefined
let workers: Row[] = []
let chats = new Map<string, Record<string, unknown>>()
let transcripts = new Map<string, { kind: string; text: string }[]>()
let posts: { path: string; body: Record<string, unknown> }[] = []
let nextId = 1

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function say(id: string, text: string): void {
  const items = transcripts.get(id) ?? []
  items.push({ kind: 'user', text }, { kind: 'assistant_text', text: 'Fake reply' })
  transcripts.set(id, items)
}

// One fake for both servers this path reaches: the daemon (/api/corch/workers) and the Desk (/api/chats).
function fakeServers(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const path = u.pathname
    const method = init?.method ?? 'GET'
    if (method === 'GET' && path === '/api/corch/workers') {
      if (u.searchParams.has('ids'))
        return json([{ id: 'w-new', status: 'done', report: 'Old path' }])
      const session = u.searchParams.get('session')
      return json(
        workers
          .filter((w) => session && [w.sessionId, ...(w.sessions ?? [])].includes(session))
          .map((w) => ({
            id: w.id,
            group: 'g-example',
            title: `Example ${w.id}`,
            role: w.role,
            ...(w.desk ? { desk: w.desk } : {}),
          })),
      )
    }
    if (method === 'GET' && path.startsWith('/api/corch/workers/')) {
      const id = decodeURIComponent(path.split('/')[4])
      const w = workers.find((x) => x.id === id)
      return w ? json({ id, role: w.role }) : json({ error: 'worker not found' }, 404)
    }
    if (method === 'GET' && path === '/api/chats') return json([...chats.values()])
    if (method === 'GET' && path.endsWith('/transcript'))
      return json(transcripts.get(path.split('/')[3]) ?? [])
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    posts.push({ path, body })
    if (method === 'POST' && path === '/api/corch/workers')
      return json({ workers: [{ id: 'w-new' }] })
    if (method === 'POST' && path.endsWith('/send')) return json({ ok: true, message: 'Queued.' })
    if (method === 'POST' && path === '/api/chats') {
      const id = `chat-seat-${nextId++}`
      chats.set(id, {
        id,
        title: body.title,
        cwd: body.cwd,
        parentId: body.parentId,
        status: 'idle',
      })
      transcripts.set(id, [])
      if (body.prompt) say(id, String(body.prompt))
      return json({ id, title: body.title })
    }
    if (method === 'POST' && path.endsWith('/messages')) {
      say(path.split('/')[3], String(body.text))
      return json({ ok: true })
    }
    return json({ error: 'not in the fake' }, 404)
  }) as unknown as typeof fetch
}

/** The calling session, as the process walk would have traced it (the resolver seam). */
function callerIs(sessionId: string): void {
  setCallerTranscriptResolver(async () => ({
    sessionId,
    path: '',
    home: FOLDER,
    how: 'test resolver',
  }))
}

/** The process walk found no session, as compaction-history.ts says it. */
const NO_SESSION =
  "could not tell which Claude Code session is calling: no live session's engine is in the calling process chain (3 processes walked). Pass session_id - your own session id - explicitly."

function untraced(): void {
  setCallerTranscriptResolver(async () => {
    throw new Error(NO_SESSION)
  })
}

beforeEach(() => {
  dir = scratch()
  savedWorker = process.env.AGENTHYDRA_CLIMAYTE_WORKER
  delete process.env.AGENTHYDRA_CLIMAYTE_WORKER
  savedFetch = globalThis.fetch
  workers = [
    { id: 'w-prime', role: 'prime', sessionId: 'sess-prime', desk: { chatId: PRIME } },
    { id: 'w-seat', role: 'seat', sessionId: 'sess-seat', desk: { chatId: 'chat-seat-0' } },
    { id: 'w-drone', role: 'drone', sessionId: 'sess-new', sessions: ['sess-drone'] },
  ]
  chats = new Map<string, Record<string, unknown>>([
    [PRIME, { id: PRIME, title: 'Example prime', cwd: FOLDER, status: 'idle' }],
    [OTHER, { id: OTHER, title: 'Another chat', cwd: FOLDER, status: 'idle' }],
    [OWNER, { id: OWNER, sessionId: 'sess-owner', title: 'Owner desktop chat', cwd: FOLDER }],
  ])
  transcripts = new Map()
  posts = []
  nextId = 1
  mkdirSync(chatPaths(dir, PRIME).root, { recursive: true })
  writeFileSync(chatPaths(dir, PRIME).cwd, FOLDER)
  fakeServers()
})

afterEach(() => {
  globalThis.fetch = savedFetch
  setCallerTranscriptResolver(null)
  if (savedWorker === undefined) delete process.env.AGENTHYDRA_CLIMAYTE_WORKER
  else process.env.AGENTHYDRA_CLIMAYTE_WORKER = savedWorker
  rmSync(dir, { recursive: true, force: true })
})

const coreUse = CORE_TOOLS.find((t) => t.name === 'core_use')!
const fanOut = FAN_OUT_TOOLS.find((t) => t.name === 'fan_out')!

test('a Prime chat is found by its own session, with no env var set: role prime', async () => {
  callerIs('sess-prime')
  expect(await callerRole({})).toBe('prime')
  expect(process.env.AGENTHYDRA_CLIMAYTE_WORKER).toBeUndefined()
})

test('a drone is found by an earlier session of its worker: role drone', async () => {
  callerIs('sess-drone')
  expect(await callerRole({})).toBe('drone')
})

test('a session no worker owns that names a Desk chat gets a seat there, never a fresh worker', async () => {
  callerIs('sess-nobody')
  expect(await callerRole({})).toBeUndefined()
  const r = await coreUse.run({
    chat: PRIME,
    id: 'person:iris-ui',
    mode: 'consult',
    question: 'Is the grid right?',
    cwd: FOLDER,
  })
  expect(r).toMatchObject({ status: 'done', seat: { chat: 'chat-seat-1' } })
  expect(posts.some((p) => p.path === '/api/corch/workers')).toBe(false)
})

test('a traced session that is no worker and has no Desk chat is a Prime: its consult opens one seat, a worker of the persona, resumed after', async () => {
  callerIs('sess-nobody')
  mkdirSync(chatPaths(dir, 'chat-nodesk').root, { recursive: true })
  writeFileSync(chatPaths(dir, 'chat-nodesk').cwd, FOLDER)
  const ask = (question?: string) =>
    coreUse.run({ chat: 'chat-nodesk', id: 'person:iris-ui', mode: 'consult', question })
  expect(await ask('Is the grid right?')).toMatchObject({ job: 'w-new', status: 'done' })
  const opened = posts.filter((p) => p.path === '/api/corch/workers')
  expect(opened).toHaveLength(1)
  expect((opened[0].body.tasks as Record<string, unknown>[])[0]).toMatchObject({
    role: 'seat',
    persona: 'person:iris-ui',
    cwd: FOLDER,
  })
  expect(await ask('And the spacing?')).toMatchObject({ job: 'w-new', status: 'done' })
  expect(posts.filter((p) => p.path === '/api/corch/workers')).toHaveLength(1)
  expect(posts.filter((p) => p.path === '/api/corch/workers/w-new/send')).toEqual([
    { path: '/api/corch/workers/w-new/send', body: { text: 'And the spacing?' } },
  ])
  expect(await ask()).toMatchObject({ job: 'w-new', status: 'done' })
  expect(posts.filter((p) => p.path.startsWith('/api/corch/workers'))).toHaveLength(2)
  expect(posts.some((p) => p.path === '/api/chats')).toBe(false)
  const log = readFileSync(join(dir, 'log.jsonl'), 'utf8')
  expect(log).toContain(
    '"event":"seat-opened","mode":"consult","id":"person:iris-ui","seat":"w-new"',
  )
  expect(log).toContain(
    '"event":"seat-resumed","mode":"consult","id":"person:iris-ui","seat":"w-new"',
  )
  expect(log).not.toContain('"event":"seatless"')
})

test('a caller that cannot be traced is refused a consult or a hire, told how to be traced, and starts nothing', async () => {
  untraced()
  mkdirSync(chatPaths(dir, 'chat-nodesk').root, { recursive: true })
  for (const chat of ['chat-nodesk', PRIME])
    for (const mode of ['consult', 'hire']) {
      const err = await Promise.resolve(
        coreUse.run({ chat, id: 'person:iris-ui', mode, question: 'Hi?', job: 'Do it' }),
      ).catch((x: Error) => x)
      const msg = String((err as Error).message)
      expect(msg).toContain(`cannot ${mode} person:iris-ui`)
      expect(msg).toContain("from the chat's own Claude Code session")
      expect(msg).not.toContain('session_id')
      expect(msg).not.toMatch(/drone|seat/i)
    }
  expect(posts).toEqual([])
  const log = readFileSync(join(dir, 'log.jsonl'), 'utf8')
  expect(log).toContain(
    '"event":"refused","mode":"consult","id":"person:iris-ui","caller":"untraced"',
  )
  expect(log).not.toContain('"event":"seatless"')
})

test('fan_out from a caller that cannot be traced is refused before any group starts', async () => {
  untraced()
  // `only` names no account: past the role check the old path fails resolving it, so no fan-out runs here.
  const err = await Promise.resolve(
    fanOut.run({ tasks: [{ cwd: FOLDER, prompt: 'p' }], only: ['no-such-account'] }),
  ).catch((x: Error) => x)
  const msg = String((err as Error).message)
  expect(msg).toContain('cannot start a fan-out')
  expect(msg).toContain("from the chat's own Claude Code session")
  expect(posts).toEqual([])
})

test('a failed trace never tells the caller to pass a session id, which the trace does not read', async () => {
  untraced()
  const r = await callerOrigin({ session_id: 'sess-prime' })
  expect(r.origin).toBeNull()
  expect(r.why).toContain('could not tell which Claude Code session is calling')
  expect(r.why).not.toContain('session_id')
})

test("the owner's own chat (a Desk chat whose session no worker owns) is a Prime and gets a seat", async () => {
  callerIs('sess-owner')
  const r = await coreUse.run({ id: 'person:iris-ui', mode: 'consult', question: 'Hi?' })
  expect(r).toMatchObject({
    seat: { chat: 'chat-seat-1', title: 'Iris Example · Owner desktop chat' },
  })
  expect(posts.find((p) => p.path === '/api/chats')?.body.parentId).toBe(OWNER)
})

test('a Prime opens seats only for its own chat: another Desk chat named as chat is refused', async () => {
  callerIs('sess-prime')
  await expect(
    coreUse.run({ chat: OTHER, id: 'person:iris-ui', mode: 'consult', question: 'Hi?' }),
  ).rejects.toThrow('core_use works only for the calling chat')
  expect(posts.filter((p) => p.path === '/api/chats')).toHaveLength(0)
  expect(existsSync(chatPaths(dir, OTHER).seats)).toBe(false)
})

test('a Prime that names its chat by title, or names none, files the seat under its Desk chat id', async () => {
  callerIs('sess-prime')
  await coreUse.run({
    chat: 'Example prime',
    id: 'person:iris-ui',
    mode: 'consult',
    question: 'A?',
  })
  await coreUse.run({ id: 'person:iris-ui', mode: 'consult', question: 'B?' })
  expect(posts.filter((p) => p.path === '/api/chats')).toHaveLength(1)
  expect(JSON.parse(readFileSync(chatPaths(dir, PRIME).seats, 'utf8'))).toMatchObject({
    'person:iris-ui': { chat: 'chat-seat-1' },
  })
})

test('core_use from a Prime chat opens a seat under it, with no env var set', async () => {
  callerIs('sess-prime')
  const r = await coreUse.run({
    chat: PRIME,
    id: 'person:iris-ui',
    mode: 'consult',
    question: 'Layout for the login page?',
  })
  expect(r).toMatchObject({
    status: 'done',
    reply: 'Fake reply',
    seat: { chat: 'chat-seat-1', title: 'Iris Example · Example prime' },
  })
  expect(posts.find((p) => p.path === '/api/chats')?.body).toMatchObject({
    parentId: PRIME,
    title: 'Iris Example · Example prime',
    cwd: FOLDER,
  })
  expect(posts.some((p) => p.path === '/api/corch/workers')).toBe(false)
})

test('core_use from a drone or a seat is refused, journaled on its worker and in the core log, and opens no chat', async () => {
  for (const [session, id] of [
    ['sess-drone', 'w-drone'],
    ['sess-seat', 'w-seat'],
  ]) {
    callerIs(session)
    const err = await Promise.resolve(
      coreUse.run({ chat: PRIME, id: 'person:iris-ui', mode: 'consult', question: 'Hi?' }),
    ).catch((x: Error) => x)
    expect(String((err as Error).message)).toBe(
      'This session cannot consult person:iris-ui: ask whoever started you to consult it.',
    )
    const refused = readJournal(JOURNAL_PATH, { id }).filter((e) => e.event === 'refused')
    expect(refused.at(-1)?.notice).toContain('This session cannot consult person:iris-ui')
  }
  expect(posts.filter((p) => p.path === '/api/chats')).toHaveLength(0)
  const log = readFileSync(join(dir, 'log.jsonl'), 'utf8')
  expect(log).toContain('"event":"refused","mode":"consult","id":"person:iris-ui","caller":"drone"')
  expect(log).toContain('"caller":"seat"')
})

test('fan_out from a drone is refused, with no env var set', async () => {
  callerIs('sess-drone')
  const before = readJournal(JOURNAL_PATH, { id: 'w-drone' }).length
  await expect(fanOut.run({ tasks: [{ cwd: FOLDER, prompt: 'p' }] })).rejects.toThrow(DRONE_REFUSAL)
  expect(posts.filter((p) => p.path === '/api/corch/workers')).toHaveLength(0)
  const after = readJournal(JOURNAL_PATH, { id: 'w-drone' }).slice(before)
  expect(after.map((e) => e.event)).toEqual(['refused'])
  expect(after[0]?.notice).toBe(DRONE_REFUSAL)
  expect(DRONE_REFUSAL).not.toMatch(/drone/i)
  expect(DRONE_REFUSAL).toContain('TOO BIG:')
})

test('with no traced caller, the env worker id is the stdio fallback', async () => {
  setCallerTranscriptResolver(async () => {
    throw new Error('no session for this process')
  })
  process.env.AGENTHYDRA_CLIMAYTE_WORKER = 'w-drone'
  expect(await callerRole({})).toBe('drone')
})
