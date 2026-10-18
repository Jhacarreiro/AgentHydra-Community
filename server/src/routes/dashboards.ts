import { DashboardError, listDashboards, readDashboard, writeDashboard } from '../dashboards'
import { app } from '../http-app'

function failure(c: { json: (body: unknown, status: number) => Response }, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err)
  return c.json({ error: message }, err instanceof DashboardError ? 400 : 500)
}

app.get('/api/dashboards', async (c) => {
  try {
    return c.json({ dashboards: await listDashboards() })
  } catch (err) {
    return failure(c, err)
  }
})

app.get('/api/dashboards/workspace', async (c) => {
  const cwd = c.req.query('cwd')
  if (!cwd?.trim()) return c.json({ error: 'cwd is required: a folder inside the project' }, 400)
  try {
    return c.json(await readDashboard(cwd, c.req.query('path') || undefined))
  } catch (err) {
    return failure(c, err)
  }
})

app.post('/api/dashboards/workspace', async (c) => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'the body must be JSON' }, 400)
  }
  if (typeof body?.cwd !== 'string' || !body.cwd.trim())
    return c.json({ error: 'cwd is required: a folder inside the project' }, 400)
  try {
    return c.json(await writeDashboard(body.cwd, body))
  } catch (err) {
    return failure(c, err)
  }
})
