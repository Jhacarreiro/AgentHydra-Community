import type { Context, Hono } from 'hono'
import { DEFAULT_HYDRA_URL } from './bridge/client'

/** Desk's ChatGPT screen talks to the AgentHydra that holds the browser bridge: AGENTHYDRA_CHATGPT_HUB_URL (a hub
 * on another machine) or this PC's own daemon (HYDRA_URL). Only these fixed routes go on, with the hub's admin
 * token from this PC's environment; never a URL, a browser command or ChatGPT credentials from the window.
 */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function chatGptHub(env: Record<string, string | undefined> = process.env): { base: URL; token: string } | null {
  try {
    const base = new URL((env.AGENTHYDRA_CHATGPT_HUB_URL?.trim() || env.HYDRA_URL || DEFAULT_HYDRA_URL).replace(/\/+$/, ''))
    if ((base.protocol !== 'http:' && base.protocol !== 'https:') || base.username || base.password) return null
    const token = (env.AGENTHYDRA_CHATGPT_HUB_TOKEN ?? env.AGENTHYDRA_CODEX_HUB_TOKEN ?? '').trim()
    return { base, token }
  } catch {
    return null
  }
}

async function forward(c: Context, path: string, init: { method: 'GET' | 'POST'; body?: string; timeout: number }) {
  const hub = chatGptHub()
  if (!hub) return c.json({ code: 'CHATGPT_TRANSPORT_UNAVAILABLE' }, 503)
  c.header('Cache-Control', 'private, no-store')
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (hub.token) headers.authorization = `Bearer ${hub.token}`
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(new URL(path, `${hub.base.toString().replace(/\/+$/, '')}/`), {
      method: init.method,
      headers,
      body: init.body,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(init.timeout),
    })
    const data: unknown = await response.json().catch(() => null)
    const code = (data as { code?: unknown } | null)?.code
    if (!response.ok)
      return c.json({ code: typeof code === 'string' ? code : 'CHATGPT_READER_UNAVAILABLE' }, response.status === 404 || response.status === 409 || response.status === 400 ? response.status : 503)
    return c.json(data, response.status === 202 ? 202 : 200)
  } catch {
    return c.json({ code: 'CHATGPT_READER_UNAVAILABLE' }, 503)
  }
}

async function textBody(c: Context): Promise<string | null> {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null
  return typeof body?.text === 'string' && body.text.trim() ? JSON.stringify({ text: body.text }) : null
}

export function chatGptRoutes(app: Hono): void {
  app.get('/api/chatgpt/visible', (c) => forward(c, 'api/chatgpt/visible', { method: 'GET', timeout: 12_000 }))
  app.get('/api/chatgpt/conversations', (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100)
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
    return forward(c, `api/chatgpt/conversations?limit=${limit}&offset=${offset}`, { method: 'GET', timeout: 45_000 })
  })
  app.get('/api/chatgpt/conversations/:id', (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ code: 'CHATGPT_NOT_FOUND' }, 404)
    return forward(c, `api/chatgpt/conversations/${id}`, { method: 'GET', timeout: 45_000 })
  })
  app.post('/api/chatgpt/conversations', async (c) => {
    const body = await textBody(c)
    if (!body) return c.json({ code: 'CHATGPT_BAD_MESSAGE' }, 400)
    return forward(c, 'api/chatgpt/conversations', { method: 'POST', body, timeout: 120_000 })
  })
  app.post('/api/chatgpt/conversations/:id/messages', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ code: 'CHATGPT_NOT_FOUND' }, 404)
    const body = await textBody(c)
    if (!body) return c.json({ code: 'CHATGPT_BAD_MESSAGE' }, 400)
    return forward(c, `api/chatgpt/conversations/${id}/messages`, { method: 'POST', body, timeout: 120_000 })
  })
  app.post('/api/chatgpt/conversations/:id/stop', (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ code: 'CHATGPT_NOT_FOUND' }, 404)
    return forward(c, `api/chatgpt/conversations/${id}/stop`, { method: 'POST', body: '{}', timeout: 45_000 })
  })
}
