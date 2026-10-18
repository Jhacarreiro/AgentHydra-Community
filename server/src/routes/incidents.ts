// Failure incidents (server/src/incidents.ts) - list/ack/resolve over HTTP, for the web UI's
// Incidents panel. Same shape as routes/queue.ts's other small resource routes.
import { app } from '../http-app'
import {
  ackIncident,
  deliverIncidentNotification,
  getIncident,
  INCIDENT_STATES,
  type IncidentState,
  listIncidents,
  recordIncident,
  resolveIncident,
  resolveIncidentsFor,
} from '../incidents'

function parseState(raw: string | undefined): IncidentState | undefined {
  if (raw === undefined) return undefined
  return INCIDENT_STATES.includes(raw as IncidentState) ? (raw as IncidentState) : undefined
}

app.get('/api/incidents', (c) => {
  const state = c.req.query('state')
  if (state !== undefined && parseState(state) === undefined) {
    return c.json({ error: `state must be one of: ${INCIDENT_STATES.join(', ')}` }, 400)
  }
  return c.json(listIncidents(parseState(state)))
})

app.get('/api/incidents/:id', (c) => {
  const incident = getIncident(c.req.param('id'))
  if (!incident) return c.json({ error: 'incident not found' }, 404)
  return c.json(incident)
})

app.post('/api/incidents/:id/ack', (c) => {
  const id = c.req.param('id')
  if (!getIncident(id)) return c.json({ error: 'incident not found' }, 404)
  return c.json({ ok: ackIncident(id), incident: getIncident(id) })
})

app.post('/api/incidents/:id/resolve', (c) => {
  const id = c.req.param('id')
  if (!getIncident(id)) return c.json({ error: 'incident not found' }, 404)
  return c.json({ ok: resolveIncident(id), incident: getIncident(id) })
})

/** Open an incident for a stuck job and ping the owner - the "Help" button for scripts and
 *  agents (MCP: ask_owner_help). A repeat while the incident is still open records a count, not a ping. */
app.post('/api/incidents', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  const key = typeof body?.key === 'string' ? body.key.trim() : ''
  const message = typeof body?.message === 'string' ? body.message.trim() : ''
  const scope = typeof body?.scope === 'string' && body.scope.trim() ? body.scope.trim() : 'routine'
  if (!key || !message) return c.json({ error: 'key and message are required' }, 400)
  const opts = { scope, key, error: message }
  const result = await recordIncident(opts)
  const delivered = await deliverIncidentNotification(result, opts)
  return c.json({ id: result.id, notified: delivered.desktop.ok || delivered.email.ok })
})

/** Resolve every open incident for one (scope, key) - a routine's next ok run calls this. */
app.post('/api/incidents/resolve-by-key', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  const key = typeof body?.key === 'string' ? body.key.trim() : ''
  const scope = typeof body?.scope === 'string' ? body.scope.trim() : ''
  if (!key || !scope) return c.json({ error: 'scope and key are required' }, 400)
  return c.json({ resolved: resolveIncidentsFor(scope, key) })
})
