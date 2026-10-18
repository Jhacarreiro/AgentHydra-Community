// server/src/routes/completions.ts — HTTP face of the completion registry (completions.ts).
// The MCP tools register a wait and mark a result seen; Desk posts `finished` when a chat's turn ends.

import { join } from 'node:path'
import { climaytePing, climaytePingState, originFor } from '../climayte'
import { type Completions, createCompletions, finishFromBody, waitFromBody } from '../completions'
import { app } from '../http-app'
import { POINTER_DIR } from '../instance'
import { requestCallerOrigin } from '../request-caller'
import { jsonBody } from '../route-helpers'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const SWEEP_MS = 30_000

const registry: Completions = createCompletions({
  file: join(POINTER_DIR, 'completions', 'completions.json'),
  resolve: (origin) => originFor(origin) ?? origin,
  emit: (origin, events) => climaytePing()?.emit(origin, events) ?? false,
  ready: () => climaytePing() !== null,
  off: () => climaytePingState().on === false,
  now: Date.now,
})
setInterval(() => {
  try {
    registry.sweep()
  } catch {
    // the next sweep tries again; a throw here would end the daemon
  }
}, SWEEP_MS).unref()

app.post('/api/completions/wait', async (c) => {
  const body = await jsonBody(c)
  const input = waitFromBody(body)
  if (!input) return c.json({ error: 'ticket, label, read and after (epoch ms) are required' }, 400)
  // The caller is the request's own chat, never a body field: no chat gets another chat's results sent to it.
  const traced = await requestCallerOrigin(c)
  if (!traced.origin) return c.json({ error: traced.why }, 409)
  registry.waitFor({ ...input, origin: traced.origin })
  return c.json({ ok: true })
})

app.post('/api/completions/seen', async (c) => {
  const body = await jsonBody(c)
  const ticket = typeof body.ticket === 'string' ? body.ticket : ''
  if (!ticket) return c.json({ error: 'ticket is required' }, 400)
  const traced = await requestCallerOrigin(c)
  if (!traced.origin) return c.json({ error: traced.why }, 409)
  registry.seen(ticket, traced.origin.sessionId)
  return c.json({ ok: true })
})

app.post('/api/completions/finished', async (c) => {
  const server = c.env as { requestIP?: (r: Request) => { address?: string } | null } | null
  if (!LOOPBACK.has(server?.requestIP?.(c.req.raw)?.address ?? ''))
    return c.json({ error: 'loopback only' }, 403)
  const input = finishFromBody(await jsonBody(c), Date.now())
  if (!input)
    return c.json({ error: 'ticket and outcome (done, failed or cancelled) are required' }, 400)
  registry.finished(input)
  return c.json({ ok: true })
})
