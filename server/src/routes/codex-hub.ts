// The Codex hub (server/src/core/codex-hub.ts) over HTTP: other PCs push their Codex chat lists and
// rollouts here, and keep a relay socket open so Desk can continue their chats (core/codex-hub-relay.ts).
// 404 unless AGENTHYDRA_CODEX_HUB_TOKEN is set, then a bearer token is required.
//
// Only /api/codex-hub/ is meant to be reachable from other machines (the PCs). Desk's end of a relay is
// /api/codex-relay/, outside it, so a proxy that exposes the hub's prefix never exposes a way to drive a PC.
import type { Context, Next } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import {
  acceptCodexHubPush,
  codexHubHomes,
  codexHubToken,
  hubPcKey,
  hubTokenMatches,
} from '../core/codex-hub'
import {
  openRelaySession,
  type PcLink,
  type RelaySession,
  relayFromPc,
  relayPcConnected,
  relayPcGone,
  relayPcs,
} from '../core/codex-hub-relay'
import { app } from '../http-app'

/** WebSocket close reasons are capped at 123 bytes. */
const reason = (why: string): string => why.slice(0, 120)

/** A relay frame is one JSON-RPC line, and one line can carry a whole chat (thread/read) or a pasted image: far past
 *  Bun's 16 MiB default, which drops the socket with 1006. The same ceiling as desk2/server/src/host/serve.ts. */
const RELAY_MAX_FRAME = 512 * 1024 * 1024

/** Bun.serve's `websocket` for the daemon (index.ts): the relay sockets below are the only ones it serves. */
export const relayWebSocket = { ...websocket, maxPayloadLength: RELAY_MAX_FRAME }

async function requireHubToken(c: Context, next: Next) {
  const token = codexHubToken()
  if (!token)
    return c.json({ error: 'the Codex hub is off (AGENTHYDRA_CODEX_HUB_TOKEN is not set)' }, 404)
  if (!hubTokenMatches(c.req.header('authorization'), token))
    return c.json({ error: 'unauthorized' }, 401)
  await next()
}

app.post('/api/codex-hub/push', requireHubToken, async (c) => {
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

// Which PCs have pushed and when, and which have a relay open now (their chats can be continued).
app.get('/api/codex-relay/pcs', (c) => {
  const live = relayPcs()
  return c.json(
    codexHubHomes().map((h) => ({
      id: h.id,
      pc: h.name,
      pushedAt: h.manifest.pushedAt,
      chats: new Set(h.manifest.threads.map((t) => t.id)).size,
      relay: live.has(h.id.slice('hub:'.length)),
    })),
  )
})

// A PC's relay socket: open while its pusher runs. The PC is named the way it names its pushes.
app.get(
  '/api/codex-hub/relay',
  requireHubToken,
  upgradeWebSocket((c) => {
    const key = hubPcKey(c.req.query('pc') ?? '')
    let link: PcLink | null = null
    return {
      onOpen(_event, ws) {
        if (!key) return ws.close(4400, 'pc is required')
        link = {
          send: (msg) => ws.send(JSON.stringify(msg)),
          close: (why) => ws.close(1000, reason(why)),
        }
        relayPcConnected(key, link)
      },
      onMessage(event) {
        if (link) relayFromPc(link, String(event.data))
      },
      onClose() {
        if (key && link) relayPcGone(key, link)
      },
    }
  }),
)

// Desk's end: one app-server on PC `key` (its hub id without `hub:`), as raw JSON-RPC lines.
app.get(
  '/api/codex-relay/:key/app-server',
  requireHubToken,
  upgradeWebSocket((c) => {
    const key = c.req.param('key') ?? ''
    let session: RelaySession | null = null
    return {
      onOpen(_event, ws) {
        session = openRelaySession(key, {
          line: (line) => ws.send(line),
          closed: (why) => ws.close(4000, reason(why)),
        })
        if (!session) ws.close(4004, 'That PC is not connected to the Codex hub now.')
      },
      onMessage(event) {
        session?.write(String(event.data))
      },
      onClose() {
        session?.close()
      },
    }
  }),
)
