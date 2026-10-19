import { app } from '../http-app'

/** Deliberately unavailable until a restricted, authenticated Dark transport is configured.
 * Do not expose CDP, SSH, cookies, or arbitrary browser evaluation through an HTTP endpoint.
 */
app.get('/api/chatgpt/visible', (c) =>
  c.json({ error: 'ChatGPT browser transport is not configured', code: 'CHATGPT_TRANSPORT_UNAVAILABLE' }, 503),
)
