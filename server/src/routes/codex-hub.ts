// The Codex hub (server/src/core/codex-hub.ts) over HTTP: other PCs push their Codex chat lists and
// rollouts here, and keep a relay socket open so Desk can continue their chats (core/codex-hub-relay.ts).
// 404 unless AGENTHYDRA_CODEX_HUB_TOKEN is set, then a bearer token is required.
//
// Only /api/codex-hub/ is meant to be reachable from other machines (the PCs). Desk's end of a relay is
// /api/codex-relay/, outside it, so a proxy that exposes the hub's prefix never exposes a way to drive a PC.
import type { ServerWebSocket } from 'bun'
import type { Context, Next } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import {
  acceptCodexHubPush,
  CODEX_HUB_DIR,
  codexHubHomes,
  codexHubToken,
  HUB_INSTALL_HEADER,
  HUB_PLATFORMS,
  hubBuildFile,
  hubInstallId,
  hubNameRefused,
  hubNameTaken,
  hubPcKey,
  hubTokenMatches,
  pusherRelease,
  ROLLOUT_UNPACKED_MAX,
} from '../core/codex-hub'
import {
  openRelaySession,
  type PcLink,
  RELAY_NAME_TAKEN,
  type RelaySession,
  relayFromPc,
  relayPcConnected,
  relayPcGone,
  relayPcs,
} from '../core/codex-hub-relay'
import { app } from '../http-app'
import { evaluateRequest } from '../loopback-guard.mjs'

/** WebSocket close reasons are capped at 123 bytes. */
const reason = (why: string): string => why.slice(0, 120)

/** A relay frame is one JSON-RPC line, and one line can carry a whole chat (thread/read) or a pasted image: far past
 *  Bun's 16 MiB default, which drops the socket with 1006. The same ceiling as desk2/server/src/host/serve.ts. */
const RELAY_MAX_FRAME = 512 * 1024 * 1024

/**
 * Bun.serve's `websocket` for the daemon (index.ts): the relay sockets below are the only ones it serves. Bun drops a
 * frame sent while more than backpressureLimit (16 MiB by default) waits to go out, so one big frame to a peer on the
 * WAN cost the lines behind it: room for two of the biggest. One that still does not fit ends its socket (below).
 */
export const relayWebSocket = {
  ...websocket,
  maxPayloadLength: RELAY_MAX_FRAME,
  backpressureLimit: 2 * RELAY_MAX_FRAME,
}

/** Bun's send gives 0 for a frame it dropped. A socket already closed gives 0 too, and its own close says why. */
const dropped = (ws: { raw?: unknown }, data: string): boolean => {
  const raw = ws.raw as ServerWebSocket<unknown>
  return raw.send(data) === 0 && raw.readyState === WebSocket.OPEN
}

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
  const result = acceptCodexHubPush(
    body,
    CODEX_HUB_DIR,
    ROLLOUT_UNPACKED_MAX,
    hubInstallId(c.req.header(HUB_INSTALL_HEADER)),
  )
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json({ pc: result.pc, stored: result.stored, want: result.want })
})

// The builds PCs keep themselves at: the pusher (core/codex-hub-update.ts) and the tray app that runs it
// (codex-hub-tray/). Each: its hash and size, with the signature from `<build>.sig` when there is one
// (core/codex-hub-signature.ts; the operator signs builds away from the hub), then the file, for the platform in
// `?platform=` (none is Windows). A platform with no build here is a 404 like a hub with none, which the PC takes
// as nothing to update.
const badPlatform = `platform must be one of ${HUB_PLATFORMS.join(', ')}`
for (const name of ['pusher', 'tray'] as const) {
  app.get(`/api/codex-hub/${name}`, requireHubToken, async (c) => {
    const file = hubBuildFile(name, c.req.query('platform'))
    if (!file) return c.json({ error: badPlatform }, 400)
    const release = await pusherRelease(file)
    return release ? c.json(release) : c.json({ error: `this hub hands out no ${name} build` }, 404)
  })
  app.get(`/api/codex-hub/${name}/download`, requireHubToken, async (c) => {
    const file = hubBuildFile(name, c.req.query('platform'))
    if (!file) return c.json({ error: badPlatform }, 400)
    if (!(await pusherRelease(file)))
      return c.json({ error: `this hub hands out no ${name} build` }, 404)
    return new Response(Bun.file(file), { headers: { 'content-type': 'application/octet-stream' } })
  })
}

// A PC's tray app (codex-hub-tray/) gets the hub token here, so a PC is set up without copying it. The tray listens
// on its own loopback port and opens this page; one click posts the token to that port and nowhere else. Outside
// /api/codex-hub/: serve it only behind the operator's sign-in (the inbox's proxy), never to the home network.
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

// The page is outside /api/*, so it runs the loopback guard's check (loopback-guard.mjs) itself, in the default
// any-loopback-port mode rather than the exact-origin one /api/* uses: a Host that is not loopback is a DNS-rebinding
// page reading the token, an Origin that is not loopback a cross-site fetch. A fetch from another loopback port is
// answered, but with no CORS header, so that page cannot read it, and frame-ancestors keeps it out of a frame.
// Sec-Fetch-Site counts for a fetch but not for a navigation, which the sign-in's redirect makes cross-site. The
// inbox's proxy forwards the page with Host 127.0.0.1 and an empty Origin.
async function pairGuard(c: Context, next: Next) {
  const navigation = c.req.header('sec-fetch-mode') === 'navigate'
  const verdict = evaluateRequest({
    secFetchSite: navigation ? undefined : c.req.header('sec-fetch-site'),
    origin: c.req.header('origin'),
    host: c.req.header('host'),
  })
  if (!verdict.ok) return c.text(`forbidden: ${verdict.reason}`, 403)
  await next()
}

app.get('/codex-hub/pair', pairGuard, (c) => {
  const token = codexHubToken()
  if (!token) return c.text('The Codex hub is off (AGENTHYDRA_CODEX_HUB_TOKEN is not set).', 404)
  const port = Number(c.req.query('port'))
  const state = c.req.query('state') ?? ''
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[0-9a-f]{32}$/.test(state))
    return c.text('Open this page from the Codex Hub app on the PC (Connect this PC).', 400)
  const pc = escapeHtml((c.req.query('pc') ?? 'this PC').slice(0, 64))
  const target = `http://127.0.0.1:${port}/paired`
  c.header('cache-control', 'no-store')
  c.header('referrer-policy', 'no-referrer')
  c.header('x-frame-options', 'DENY')
  c.header(
    'content-security-policy',
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${target}; frame-ancestors 'none'`,
  )
  return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ${pc}</title>
<style>body{font:16px system-ui,sans-serif;margin:0;padding:48px 16px;background:#f6f6f4;color:#222}
main{max-width:440px;margin:auto}button{font:inherit;padding:10px 22px;border:0;border-radius:8px;background:#2d6a4f;
color:#fff;cursor:pointer}p{line-height:1.5}small{color:#666}
@media (prefers-color-scheme:dark){body{background:#1b1b1a;color:#eee}small{color:#aaa}}</style></head>
<body><main><h1>Connect ${pc}</h1>
<p>The Codex Hub app on ${pc} gets this hub's token, then keeps that PC's Codex chats here.</p>
<form method="post" action="${target}"><input type="hidden" name="state" value="${state}">
<input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Connect</button></form>
<p><small>Only use this when you opened it from the Codex Hub app on your own PC.</small></p></main></body></html>`)
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
    const pc = (c.req.query('pc') ?? '').trim()
    const key = hubPcKey(pc)
    const install = hubInstallId(c.req.header(HUB_INSTALL_HEADER))
    let link: PcLink | null = null
    return {
      onOpen(_event, ws) {
        if (!key) return ws.close(4400, 'pc is required')
        // Another PC holds this name: replacing its socket would end its Desk sessions, and it would replace this
        // one in turn a few seconds later.
        if (hubNameRefused(key, install))
          return ws.close(RELAY_NAME_TAKEN, reason(hubNameTaken(pc)))
        const pcLink: PcLink = {
          // A dropped line leaves an app-server on the PC waiting for it: every session on this socket ends instead.
          send: (msg) => {
            if (dropped(ws, JSON.stringify(msg)))
              relayPcGone(key, pcLink, 'The hub could not keep up sending to the PC.')
          },
          close: (why) => ws.close(1000, reason(why)),
        }
        link = pcLink
        relayPcConnected(key, link, install)
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
          // A dropped line is an answer or an event Desk waits for: the session ends instead.
          line: (line) => {
            if (dropped(ws, line)) ws.close(4000, 'The hub could not keep up sending to Desk.')
          },
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
