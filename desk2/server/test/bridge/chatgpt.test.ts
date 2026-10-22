// ChatGPT's conversations as outside sessions (bridge/chatgpt.ts), and their routes through plugins/10-bridge.ts.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer, type DeskServer } from '../../src/index'
import { createBridge } from '../../src/bridge'
import { chatGptHub, chatGptRow, conversationItems, createChatGptSource, isChatGptId, LIST_FRESH_MS, RETRY_MS } from '../../src/bridge/chatgpt'
import { startFakeHydra, type FakeHydra } from './fake-hydra'

const ID = '11111111-2222-3333-4444-555555555555'
const OTHER = '66666666-7777-8888-9999-aaaaaaaaaaaa'
const SID = `chatgpt:${ID}`

const conversation = (state: 'idle' | 'thinking' | 'generating' | 'stopped' = 'idle') => ({
  id: ID,
  title: 'Example question',
  state,
  busy: false,
  truncated: false,
  messages: [
    { id: 'u1', role: 'user' as const, text: 'What is two plus two?', createdAt: 1_760_000_000 },
    { id: 'a1', role: 'assistant' as const, text: 'Four.', createdAt: 1_760_000_005 },
  ],
})

/** A hub that answers the ChatGPT routes, recording what it was asked. */
function fakeHub() {
  const seen: { method: string; path: string; auth: string | null; body: string }[] = []
  let state: Parameters<typeof conversation>[0] = 'idle'
  let listing = true
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      seen.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.get('authorization'), body: await req.text() })
      if (!listing) return Response.json({ error: 'ChatGPT in Desk is turned off on this hub', code: 'CHATGPT_DISABLED' }, { status: 503 })
      if (url.pathname === '/api/chatgpt/conversations') return Response.json({ conversations: [{ id: ID, title: 'Example question', updatedAt: '2026-10-20T10:00:00.000Z' }] })
      if (url.pathname.endsWith('/messages')) {
        state = 'thinking'
        return Response.json({ id: ID }, { status: 202 })
      }
      if (url.pathname.endsWith('/stop')) return Response.json({ stopped: true })
      if (url.pathname === `/api/chatgpt/conversations/${ID}`) return Response.json(conversation(state))
      return Response.json({ code: 'CHATGPT_NOT_FOUND' }, { status: 404 })
    },
  })
  return {
    seen,
    url: `http://127.0.0.1:${server.port}`,
    setState: (s: Parameters<typeof conversation>[0]) => (state = s),
    off: () => (listing = false),
    stop: () => server.stop(true),
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30))

describe('ChatGPT rows', () => {
  test('a conversation is an idle, read-only outside session named chatgpt:<id>', () => {
    const row = chatGptRow({ id: ID, title: '', updatedAt: '2026-10-20T10:00:00.000Z' }, undefined, null)
    expect(row).toMatchObject({ id: SID, title: 'New chat', source: 'chatgpt', status: 'idle', canResume: false, cwd: null, lastActivityAt: Date.parse('2026-10-20T10:00:00.000Z') })
    expect(chatGptRow({ id: ID, title: 'x', updatedAt: null }, 'generating', 5).status).toBe('working')
    expect(chatGptRow({ id: ID, title: 'x', updatedAt: null }, 'thinking', 5).activity).toBe('Thinking')
    expect(isChatGptId(SID)).toBe(true)
    expect(isChatGptId(`chatgpt:../${ID}`)).toBe(false)
    expect(isChatGptId(ID)).toBe(false)
  })

  test("messages become the person's bubbles and ChatGPT's replies", () => {
    expect(conversationItems(conversation())).toEqual([
      { id: 'u1', ts: 1_760_000_000_000, kind: 'user', text: 'What is two plus two?' },
      { id: 'a1', ts: 1_760_000_005_000, kind: 'assistant_text', text: 'Four.' },
    ])
  })

  test('takes only an http(s) hub without credentials in its address', () => {
    expect(chatGptHub({ AGENTHYDRA_CHATGPT_HUB_URL: 'file:///x' })).toBeNull()
    expect(chatGptHub({ AGENTHYDRA_CHATGPT_HUB_URL: 'http://a:b@example.test' })).toBeNull()
    expect(chatGptHub({ HYDRA_URL: 'http://127.0.0.1:7787', AGENTHYDRA_CODEX_HUB_TOKEN: 't' })).toEqual({ base: new URL('http://127.0.0.1:7787'), token: 't' })
  })
})

describe('the ChatGPT source', () => {
  let hub: ReturnType<typeof fakeHub>
  beforeAll(() => {
    hub = fakeHub()
  })
  afterAll(() => hub.stop())

  test('lists without waiting on the hub, reads again only when stale, and follows a sent message until it is answered', async () => {
    let t = 1_000_000
    const source = createChatGptSource({ hub: () => ({ base: new URL(hub.url), token: 'example-admin-token' }), now: () => t })
    // The first list is read behind the answer.
    expect(source.sessions()).toEqual([])
    await settle()
    expect(source.sessions().map((s) => [s.id, s.status])).toEqual([[SID, 'idle']])
    const lists = () => hub.seen.filter((s) => s.path.startsWith('/api/chatgpt/conversations?')).length
    expect(lists()).toBe(1)
    expect(hub.seen[0]!.auth).toBe('Bearer example-admin-token')
    t += LIST_FRESH_MS + 1
    source.sessions()
    await settle()
    expect(lists()).toBe(2)

    await source.send(SID, 'And three plus three?')
    expect(JSON.parse(hub.seen.at(-1)!.body)).toEqual({ text: 'And three plus three?' })
    expect(source.sessions()[0]).toMatchObject({ status: 'working', activity: 'Thinking' })
    // While it runs, each list reads the conversation again; once answered it is idle.
    hub.setState('idle')
    await settle()
    expect(source.sessions()[0]).toMatchObject({ status: 'idle' })
  })

  test('a hub with ChatGPT off lists none and is asked again only after a while', async () => {
    const off = fakeHub()
    off.off()
    let t = 5_000_000
    const source = createChatGptSource({ hub: () => ({ base: new URL(off.url), token: '' }), now: () => t })
    source.sessions()
    await settle()
    expect(source.sessions()).toEqual([])
    t += LIST_FRESH_MS + 1
    source.sessions()
    await settle()
    expect(off.seen.length).toBe(1)
    t += RETRY_MS
    source.sessions()
    await settle()
    expect(off.seen.length).toBe(2)
    off.stop()
  })
})

describe('ChatGPT through the bridge routes', () => {
  const PLUGIN = join(import.meta.dir, '..', '..', 'src', 'plugins', '10-bridge.ts')
  const temps: string[] = []
  const servers: DeskServer[] = []
  const fakes: FakeHydra[] = []
  const savedHome = process.env.HYDRA_DESK_HOME
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop()
    for (const f of fakes.splice(0)) await f.stop()
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
    if (savedHome === undefined) delete process.env.HYDRA_DESK_HOME
    else process.env.HYDRA_DESK_HOME = savedHome
  })

  test('lists, reads, sends only from the window, and stops', async () => {
    const hub = fakeHub()
    const f = await startFakeHydra()
    fakes.push(f)
    const chatgpt = createChatGptSource({ hub: () => ({ base: new URL(hub.url), token: '' }) })
    const home = mkdtempSync(join(tmpdir(), 'desk-chatgpt-home-'))
    const plugins = mkdtempSync(join(tmpdir(), 'desk-chatgpt-plugins-'))
    temps.push(home, plugins)
    writeFileSync(join(plugins, '10-bridge.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
    process.env.HYDRA_DESK_HOME = home
    const desk = await createServer({ port: 0, home, pluginsDir: plugins, deps: { bridge: createBridge({ url: f.url, chatgpt }), bridgePollMs: 50 } })
    servers.push(desk)
    const get = async (path: string) => (await fetch(desk.url + path)).json()
    const send = (path: string, headers: Record<string, string> = {}) =>
      fetch(desk.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ text: 'Hello' }) })

    await get('/api/external/sessions')
    await settle()
    const listed = (await get('/api/external/sessions')) as { id: string; source: string }[]
    expect(listed.filter((s) => s.source === 'chatgpt').map((s) => s.id)).toEqual([SID])

    const items = (await get(`/api/external/sessions/${encodeURIComponent(SID)}/items`)) as { kind: string; text: string }[]
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ['user', 'What is two plus two?'],
      ['assistant_text', 'Four.'],
    ])
    expect((await fetch(`${desk.url}/api/external/sessions/${encodeURIComponent(`chatgpt:${OTHER}`)}/items`)).status).toBe(404)

    const before = hub.seen.length
    // An agent, the orchestrator or a script never writes to ChatGPT.
    expect((await send(`/api/external/sessions/${encodeURIComponent(SID)}/message`)).status).toBe(403)
    expect(hub.seen.length).toBe(before)
    const sent = await send(`/api/external/sessions/${encodeURIComponent(SID)}/message`, { 'X-Desk-Caller': 'window' })
    expect(sent.status).toBe(200)
    expect(await sent.json()).toMatchObject({ ok: true, route: 'chatgpt' })
    expect(hub.seen.at(-1)).toMatchObject({ method: 'POST', path: `/api/chatgpt/conversations/${ID}/messages` })

    const stopped = await fetch(`${desk.url}/api/external/sessions/${encodeURIComponent(SID)}/stop`, { method: 'POST' })
    expect(await stopped.json()).toEqual({ ok: true })
    hub.stop()
  })
})
