/**
 * The always-on helpers (server/src/helpers.ts): /api/helpers lists them with HSwarm's sidecar,
 * /api/helpers/:id/restart ends one so the next check starts it fresh, and /api/helpers/stop and
 * /api/helpers/start end every helper and hold them off, or let them run again.
 */

import { helpersView, restartHelper, startAllHelpers, stopAllHelpers } from '../helpers'
import { app } from '../http-app'

app.get('/api/helpers', (c) => c.json(helpersView()))

app.post('/api/helpers/stop', async (c) => {
  await stopAllHelpers()
  return c.json(helpersView())
})

app.post('/api/helpers/start', async (c) => {
  await startAllHelpers()
  return c.json(helpersView())
})

app.post('/api/helpers/:id/restart', async (c) => {
  if (!(await restartHelper(c.req.param('id'))))
    return c.json({ error: 'no helper has that id' }, 404)
  return c.json(helpersView())
})
