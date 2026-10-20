import { readChatGptLocally } from '../core/chatgpt-transport'
import { app } from '../http-app'

/** Opt-in operator-provided reader. Only the fixed read operation is supported.
 * The same API origin guard as other local Desk requests applies to this route.
 * No browser credentials or SSH parameters are accepted from HTTP clients.
 */
app.get('/api/chatgpt/visible', async (c) => {
  if (process.env.AGENTHYDRA_CHATGPT_ENABLED !== '1') {
    return c.json(
      { error: 'ChatGPT browser view is disabled', code: 'CHATGPT_TRANSPORT_UNAVAILABLE' },
      503,
    )
  }
  try {
    const view = await readChatGptLocally()
    c.header('Cache-Control', 'no-store, private')
    c.header('Pragma', 'no-cache')
    c.header('X-Content-Type-Options', 'nosniff')
    return c.json(view)
  } catch {
    return c.json(
      { error: 'ChatGPT browser reader unavailable', code: 'CHATGPT_READER_UNAVAILABLE' },
      503,
    )
  }
})
