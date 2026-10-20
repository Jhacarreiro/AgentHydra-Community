import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { chatGptHub, chatGptRoutes } from '../src/chatgpt-proxy'

const ID = '11111111-2222-3333-4444-555555555555'
const KEYS = ['AGENTHYDRA_CHATGPT_HUB_URL', 'AGENTHYDRA_CHATGPT_HUB_TOKEN'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
const seen: { method: string; path: string; auth: string | null; body: string }[] = []
let hub: ReturnType<typeof Bun.serve>

beforeAll(() => {
  hub = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      seen.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.get('authorization'), body: await req.text() })
      if (url.pathname.endsWith('/stop')) return Response.json({ code: 'CHATGPT_NOT_OPEN' }, { status: 409 })
      if (req.method === 'POST') return Response.json({ id: ID }, { status: 202 })
      return Response.json({ conversations: [] })
    },
  })
  process.env.AGENTHYDRA_CHATGPT_HUB_URL = `http://127.0.0.1:${hub.port}`
  process.env.AGENTHYDRA_CHATGPT_HUB_TOKEN = 'example-admin-token'
})
afterAll(() => {
  hub.stop(true)
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function desk() {
  const app = new Hono()
  chatGptRoutes(app)
  return app
}

describe('Desk ChatGPT proxy', () => {
  test('forwards the fixed routes to the hub with its admin token', async () => {
    const app = desk()
    expect((await app.request('/api/chatgpt/conversations?limit=500')).status).toBe(200)
    const posted = await app.request(`/api/chatgpt/conversations/${ID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', url: 'https://example.test' }),
    })
    expect(posted.status).toBe(202)
    expect(await posted.json()).toEqual({ id: ID })
    expect(seen.map((s) => [s.method, s.path, s.auth])).toEqual([
      ['GET', '/api/chatgpt/conversations?limit=100&offset=0', 'Bearer example-admin-token'],
      ['POST', `/api/chatgpt/conversations/${ID}/messages`, 'Bearer example-admin-token'],
    ])
    // Only the text goes on.
    expect(JSON.parse(seen[1]!.body)).toEqual({ text: 'Hello' })
  })

  test('refuses what is not a conversation id or a message before reaching the hub', async () => {
    const app = desk()
    const before = seen.length
    expect((await app.request('/api/chatgpt/conversations/..%2F..%2Fapi%2Fhealth')).status).toBe(404)
    expect((await app.request('/api/chatgpt/conversations', { method: 'POST', body: '{"text":"  "}' })).status).toBe(400)
    expect(seen.length).toBe(before)
  })

  test("passes on the hub's reason", async () => {
    const response = await desk().request(`/api/chatgpt/conversations/${ID}/stop`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: 'CHATGPT_NOT_OPEN' })
  })

  test('takes only an http(s) hub without credentials in its address', () => {
    expect(chatGptHub({ AGENTHYDRA_CHATGPT_HUB_URL: 'file:///x' })).toBeNull()
    expect(chatGptHub({ AGENTHYDRA_CHATGPT_HUB_URL: 'http://a:b@example.test' })).toBeNull()
    expect(chatGptHub({ HYDRA_URL: 'http://127.0.0.1:7787', AGENTHYDRA_CODEX_HUB_TOKEN: 't' })).toEqual({
      base: new URL('http://127.0.0.1:7787'),
      token: 't',
    })
  })
})
