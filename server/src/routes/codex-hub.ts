// The Codex hub (server/src/core/codex-hub.ts) over HTTP: other PCs push their Codex chat lists and
// rollouts here. 404 unless AGENTHYDRA_CODEX_HUB_TOKEN is set, then a bearer token is required.
import {
  acceptCodexHubPush,
  codexHubHomes,
  codexHubToken,
  hubTokenMatches,
} from '../core/codex-hub'
import { app } from '../http-app'

app.post('/api/codex-hub/push', async (c) => {
  const token = codexHubToken()
  if (!token)
    return c.json({ error: 'the Codex hub is off (AGENTHYDRA_CODEX_HUB_TOKEN is not set)' }, 404)
  if (!hubTokenMatches(c.req.header('authorization'), token))
    return c.json({ error: 'unauthorized' }, 401)
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'body must be JSON' }, 400)
  }
  const result = acceptCodexHubPush(body)
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json({ pc: result.pc, stored: result.stored, want: result.want })
})

// Which PCs have pushed and when: enough to tell a PC that stopped pushing from one with no new chats.
app.get('/api/codex-hub/pcs', (c) =>
  c.json(
    codexHubHomes().map((h) => ({
      id: h.id,
      pc: h.name,
      pushedAt: h.manifest.pushedAt,
      chats: new Set(h.manifest.threads.map((t) => t.id)).size,
    })),
  ),
)
