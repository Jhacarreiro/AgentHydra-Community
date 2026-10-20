import type { Context, Next } from 'hono'
import { ChatGptBridgeError, createChatGptBridge, MAX_SEND } from '../core/chatgpt-bridge'
import { readChatGptLocally } from '../core/chatgpt-transport'
import { codexHubToken, hubTokenMatches } from '../core/codex-hub'
import { app } from '../http-app'

/** ChatGPT for Desk, off unless AGENTHYDRA_CHATGPT_ENABLED=1. The same API origin guard as other local Desk
 * requests applies; on a hub (AGENTHYDRA_CODEX_HUB_TOKEN set) every route also takes the hub's admin token only,
 * as Desk's end of the Codex relay does. No browser credentials, URLs or code are accepted from HTTP clients:
 * each route is one fixed operation of core/chatgpt-bridge.ts, and only these POSTs send anything to ChatGPT.
 */
const bridge = createChatGptBridge()
const ERROR_STATUS = {
  CHATGPT_BRIDGE_UNAVAILABLE: 503,
  CHATGPT_SIGNED_OUT: 503,
  CHATGPT_COMPOSER_UNAVAILABLE: 502,
  CHATGPT_NOT_FOUND: 404,
  CHATGPT_NOT_OPEN: 409,
} as const

function privateJson(c: Context, body: unknown, status: 200 | 202 = 200) {
  c.header('Cache-Control', 'no-store, private')
  c.header('Pragma', 'no-cache')
  c.header('X-Content-Type-Options', 'nosniff')
  return c.json(body, status)
}

function failed(c: Context, error: unknown) {
  // Never log browser output, private conversation contents, or tool errors.
  if (error instanceof ChatGptBridgeError)
    return c.json({ error: error.message, code: error.code }, ERROR_STATUS[error.code])
  return c.json(
    { error: 'ChatGPT browser bridge unavailable', code: 'CHATGPT_BRIDGE_UNAVAILABLE' },
    503,
  )
}

async function chatGptGate(c: Context, next: Next) {
  if (process.env.AGENTHYDRA_CHATGPT_ENABLED !== '1')
    return c.json(
      { error: 'ChatGPT is disabled on this AgentHydra', code: 'CHATGPT_TRANSPORT_UNAVAILABLE' },
      503,
    )
  const admin = codexHubToken()
  if (admin && !hubTokenMatches(c.req.header('authorization'), admin))
    return c.json({ error: 'unauthorized', code: 'CHATGPT_UNAUTHORIZED' }, 401)
  await next()
}
app.use('/api/chatgpt/*', chatGptGate)

app.get('/api/chatgpt/visible', async (c) => {
  try {
    return privateJson(c, await readChatGptLocally())
  } catch {
    return c.json(
      { error: 'ChatGPT browser reader unavailable', code: 'CHATGPT_READER_UNAVAILABLE' },
      503,
    )
  }
})

app.get('/api/chatgpt/conversations', async (c) => {
  try {
    const limit = Number(c.req.query('limit') ?? 50) || 50
    const offset = Number(c.req.query('offset') ?? 0) || 0
    return privateJson(c, { conversations: await bridge.list(limit, offset) })
  } catch (error) {
    return failed(c, error)
  }
})

app.get('/api/chatgpt/conversations/:id', async (c) => {
  try {
    return privateJson(c, await bridge.read(c.req.param('id')))
  } catch (error) {
    return failed(c, error)
  }
})

async function messageText(c: Context): Promise<string | null> {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  return text && text.length <= MAX_SEND ? text : null
}

// A person's own message from Desk, sent once. A new conversation's id comes back when ChatGPT has made it.
app.post('/api/chatgpt/conversations', async (c) => {
  const text = await messageText(c)
  if (!text) return c.json({ error: 'text is required', code: 'CHATGPT_BAD_MESSAGE' }, 400)
  try {
    return privateJson(c, await bridge.send(null, text), 202)
  } catch (error) {
    return failed(c, error)
  }
})

app.post('/api/chatgpt/conversations/:id/messages', async (c) => {
  const text = await messageText(c)
  if (!text) return c.json({ error: 'text is required', code: 'CHATGPT_BAD_MESSAGE' }, 400)
  try {
    return privateJson(c, await bridge.send(c.req.param('id'), text), 202)
  } catch (error) {
    return failed(c, error)
  }
})

app.post('/api/chatgpt/conversations/:id/stop', async (c) => {
  try {
    return privateJson(c, { stopped: await bridge.stop(c.req.param('id')) })
  } catch (error) {
    return failed(c, error)
  }
})
