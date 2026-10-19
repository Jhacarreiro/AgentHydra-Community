// The Codex hub (server/src/core/codex-hub.ts) over HTTP: other PCs push their Codex chat lists and
// rollouts here, and keep a relay socket open so Desk can continue their chats (core/codex-hub-relay.ts).
// 404 unless AGENTHYDRA_CODEX_HUB_TOKEN is set.
//
// Only /api/codex-hub/ is meant to be reachable from other machines (the PCs), and there each PC's own token is the
// authentication (core/codex-hub-pcs.ts): it acts for that PC alone, from the install id bound to it, whatever a
// request names. The admin token is refused there, and the shared token of before acts only within the migration
// window. Desk's end of a relay and the admin API are /api/codex-relay/, outside it, and take the admin token only,
// so a proxy that exposes the hub's prefix never exposes a way to drive a PC or to manage the PCs.
import type { ServerWebSocket } from 'bun'
import type { Context, Next } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import type { WSContext } from 'hono/ws'
import {
  acceptCodexHubPush,
  CODEX_HUB_DIR,
  codexHubHomes,
  codexHubToken,
  HUB_INSTALL_HEADER,
  HUB_PLATFORMS,
  hubBearer,
  hubBuildFile,
  hubInstallId,
  hubNameRefused,
  hubNameTaken,
  hubPcKey,
  hubTokenMatches,
  isPcToken,
  legacyToken,
  pusherRelease,
  ROLLOUT_UNPACKED_MAX,
} from '../core/codex-hub'
import { CONTROL, pcTokenId, plainJson } from '../core/codex-hub-ids'
import {
  bindPcInstall,
  exchangeLegacy,
  forgetPc,
  type HubPcCode,
  type HubPcRecord,
  type HubRefusal,
  hubPcRows,
  hubWhen,
  installName,
  inUse,
  legacyWindow,
  linkCredentialValid,
  markPcUsed,
  mintConfirm,
  mintPairCode,
  onlineNow,
  type PairTarget,
  pairTarget,
  pcByToken,
  pcStoreReadable,
  pendingKeyFor,
  pendingKeys,
  redeemPairCode,
  registerPcToken,
  retirePc,
  revokePc,
  takeConfirm,
  tokenName,
} from '../core/codex-hub-pcs'
import {
  closeRelayUnless,
  openRelaySession,
  type PcLink,
  RELAY_REFUSED,
  type RelaySession,
  relayFromPc,
  relayPcConnected,
  relayPcGone,
  relayPcs,
  relayPcToken,
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

/**
 * Tests reach into the relay's open here: `beforeRelayOpen` runs first in a PC socket's onOpen, after the checks
 * made before its upgrade, so a test can change the PC's credential in between. Nothing sets it outside tests.
 */
export const codexHubTestHooks: {
  beforeRelayOpen?: (key: string, tokenId: string) => void | Promise<void>
} = {}

// --- answers and the refusal log ----------------------------------------------------------------

type HubCode = HubPcCode | 'hub-off' | 'too-large'
type Status = 400 | 401 | 404 | 409 | 413 | 500 | 503

const fail = (c: Context, status: Status, code: HubCode, error: string) =>
  c.json({ error, code }, status)
const refusal = (c: Context, r: HubRefusal) => fail(c, r.status, r.code, r.error)
const hubOff = (c: Context) =>
  fail(c, 404, 'hub-off', 'the Codex hub is off (AGENTHYDRA_CODEX_HUB_TOKEN is not set)')
/** The one answer for a bearer that is not a PC token, whatever it is: the reason goes to the log only. */
const unauthorized = (c: Context) => fail(c, 401, 'unauthorized', 'unauthorized')

const refusalsLogged = new Map<string, number>()

/** `[codex-hub] refused <route> (<reason>)`, once a minute for each route and reason. No reason holds a secret. */
function logRefusal(c: Context, why: string, now = Date.now()): void {
  const id = `${c.req.method} ${c.req.path} ${why}`
  const last = refusalsLogged.get(id)
  if (last !== undefined && now - last < 60_000) return
  if (refusalsLogged.size > 1000)
    for (const [k, at] of refusalsLogged) if (now - at >= 60_000) refusalsLogged.delete(k)
  refusalsLogged.set(id, now)
  console.log(`[codex-hub] refused ${c.req.method} ${c.req.path} (${why})`)
}

/** The address the proxy in front of the hub says a request came from, for a record's `pairedFrom`. */
function proxyAddress(c: Context): string | null {
  const said =
    c.req.header('cf-connecting-ip')?.trim() ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    ''
  return /^[0-9A-Fa-f:.]{2,64}$/.test(said) ? said : null
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return undefined
  }
}

// --- who is calling -------------------------------------------------------------------------------

/** A request on a PC's route, once its bearer is known: a PC token (its key), or the legacy token in the window. */
type HubCaller =
  | { kind: 'pc'; key: string; record: HubPcRecord; token: string; install: string | null }
  | { kind: 'legacy'; install: string | null }

/**
 * Works out who a request on a PC's route is: a PC token, checked against its record and its install id (and bound
 * to the install id it is first used with), or the legacy token while the window is open. Everything else, the
 * admin token included, is a bare 401.
 */
function hubCaller(
  c: Context,
  root: string,
  opts: { install: 'required' | 'optional' },
): HubCaller | Response {
  const admin = codexHubToken()
  if (!admin) return hubOff(c)
  const header = c.req.header('authorization')
  const bearer = hubBearer(header)
  const install = hubInstallId(c.req.header(HUB_INSTALL_HEADER))
  if (!bearer) {
    logRefusal(c, 'no bearer token')
    return unauthorized(c)
  }
  if (isPcToken(bearer)) {
    const name = tokenName(pcTokenId(bearer)!)
    const found = pcByToken(bearer, root)
    if (!found.ok) {
      logRefusal(c, `${name}: ${found.code}`)
      return refusal(c, found)
    }
    const { key, record } = found
    if (!install && opts.install === 'required') {
      logRefusal(c, `${name}: no install id`)
      return fail(
        c,
        400,
        'install-required',
        `a PC token is sent with this PC's install id in ${HUB_INSTALL_HEADER}`,
      )
    }
    if (record.install && install && record.install !== install) {
      logRefusal(c, `${name}: install ${installName(install)}, not its own`)
      return fail(
        c,
        409,
        'install-mismatch',
        `this token belongs to another install of ${record.pc}'s pusher`,
      )
    }
    const failed =
      (!record.install && install ? bindPcInstall(key, record.tokenId!, install, root) : null) ??
      (record.firstUsedAt ? null : markPcUsed(key, record.tokenId!, root))
    if (failed) return refusal(c, failed)
    const now = pcByToken(bearer, root)
    if (!now.ok) return refusal(c, now)
    return { kind: 'pc', key, record: now.record, token: bearer, install }
  }
  const legacy = legacyToken()
  if (legacy && legacy !== admin && hubTokenMatches(header, legacy)) {
    if (legacyWindow(root).open) return { kind: 'legacy', install }
    logRefusal(c, 'the legacy token, while the migration window is not open')
    return unauthorized(c)
  }
  logRefusal(
    c,
    hubTokenMatches(header, admin) ? 'the admin token' : 'a bearer token the hub does not know',
  )
  return unauthorized(c)
}

/**
 * Whether `caller` may still act for key `key`, checked again just before the write or registration it guards, with
 * no await in between: its token still the key's and unrevoked, or the key still pending with its install id.
 */
function stillValid(caller: HubCaller, key: string, root: string): HubRefusal | null {
  if (caller.kind === 'pc') {
    const now = pcByToken(caller.token, root)
    if (!now.ok) return now
    return now.key === key
      ? null
      : { ok: false, status: 401, code: 'unknown-token', error: 'unknown-token' }
  }
  return pendingKeyFor(caller.install, root) === key
    ? null
    : { ok: false, status: 401, code: 'unauthorized', error: 'unauthorized' }
}

/** Why the legacy token may not act for `key`, for the log. */
const notPending = (key: string, install: string | null) =>
  `the legacy token for ${key}, which is not pending with install ${install ? installName(install) : 'none'}`

// --- the push -----------------------------------------------------------------------------------

/** Keys whose token pushed under another PC's name: logged once each. */
const namedOther = new Set<string>()
const PUSH_CODE: Record<400 | 409 | 413, HubCode> = {
  400: 'bad-request',
  409: 'name-taken',
  413: 'too-large',
}

app.post('/api/codex-hub/push', async (c) => {
  const caller = hubCaller(c, CODEX_HUB_DIR, { install: 'required' })
  if (caller instanceof Response) return caller
  const body = await jsonBody(c)
  if (body === undefined) return fail(c, 400, 'bad-request', 'body must be JSON')
  const push = (body && typeof body === 'object' ? body : {}) as { pc?: unknown }
  const named = typeof push.pc === 'string' ? push.pc.trim() : ''
  let result: ReturnType<typeof acceptCodexHubPush>
  if (caller.kind === 'pc') {
    const { key, record } = caller
    const late = stillValid(caller, key, CODEX_HUB_DIR)
    if (late) {
      logRefusal(c, `${tokenName(record.tokenId!)}: ${late.code} after its body arrived`)
      return refusal(c, late)
    }
    // The token is the PC: a name with its key, and no control character, only sets how it is written.
    const pc = named && !CONTROL.test(named) && hubPcKey(named) === key ? named : record.pc
    if (named && pc !== named && !namedOther.has(key)) {
      namedOther.add(key)
      console.log(
        `[codex-hub] ${record.pc}'s token pushed as ${plainJson(named.slice(0, 64))}; kept as ${record.pc}`,
      )
    }
    result = acceptCodexHubPush(
      { ...push, pc },
      CODEX_HUB_DIR,
      ROLLOUT_UNPACKED_MAX,
      caller.install,
      { hold: false, key },
    )
  } else {
    const key = named ? hubPcKey(named) : null
    if (!key) return fail(c, 400, 'bad-request', 'pc is required')
    if (stillValid(caller, key, CODEX_HUB_DIR)) {
      logRefusal(c, notPending(key, caller.install))
      return unauthorized(c)
    }
    result = acceptCodexHubPush(body, CODEX_HUB_DIR, ROLLOUT_UNPACKED_MAX, caller.install)
  }
  if (!result.ok) return fail(c, result.status, PUSH_CODE[result.status], result.error)
  return c.json({ pc: result.pc, stored: result.stored, want: result.want })
})

// --- builds -------------------------------------------------------------------------------------

// The builds PCs keep themselves at: the pusher (core/codex-hub-update.ts) and the tray app that runs it
// (codex-hub-tray/). Each: its hash and size, with the signature from `<build>.sig` when there is one
// (core/codex-hub-signature.ts; the operator signs builds away from the hub), then the file, for the platform in
// `?platform=` (none is Windows). A platform with no build here is a 404 like a hub with none, which the PC takes
// as nothing to update. They hold nothing secret, but a PC token is asked for: revoking a PC stops its updates. The
// legacy token gets them while any PC is pending, since an old tray fetches the tray that can move with it.
async function requireBuildCaller(c: Context, next: Next) {
  const caller = hubCaller(c, CODEX_HUB_DIR, { install: 'optional' })
  if (caller instanceof Response) return caller
  if (caller.kind === 'legacy' && pendingKeys().length === 0) {
    logRefusal(c, 'the legacy token, with no PC pending')
    return unauthorized(c)
  }
  await next()
}

const badPlatform = `platform must be one of ${HUB_PLATFORMS.join(', ')}`
for (const name of ['pusher', 'tray'] as const) {
  const none = `this hub hands out no ${name} build`
  app.get(`/api/codex-hub/${name}`, requireBuildCaller, async (c) => {
    const file = hubBuildFile(name, c.req.query('platform'))
    if (!file) return fail(c, 400, 'bad-request', badPlatform)
    const release = await pusherRelease(file)
    return release ? c.json(release) : fail(c, 404, 'not-found', none)
  })
  app.get(`/api/codex-hub/${name}/download`, requireBuildCaller, async (c) => {
    const file = hubBuildFile(name, c.req.query('platform'))
    if (!file) return fail(c, 400, 'bad-request', badPlatform)
    if (!(await pusherRelease(file))) return fail(c, 404, 'not-found', none)
    return new Response(Bun.file(file), { headers: { 'content-type': 'application/octet-stream' } })
  })
}

// --- a PC's token: whoami, redeem, exchange, retire ----------------------------------------------

// What the hub has a PC token under: the tray confirms a token it is not sure the hub took, and fills in its name.
app.get('/api/codex-hub/whoami', (c) => {
  const caller = hubCaller(c, CODEX_HUB_DIR, { install: 'optional' })
  if (caller instanceof Response) return caller
  if (caller.kind !== 'pc') {
    logRefusal(c, 'the legacy token')
    return unauthorized(c)
  }
  const { key, record } = caller
  return c.json({
    pc: record.pc,
    key,
    id: record.tokenId,
    ...(record.install ? { install: record.install } : {}),
  })
})

// The tray redeems the pairing page's code with the id and hash of a token it made: no bearer, the code is the
// credential. No token travels either way.
app.post('/api/codex-hub/redeem', async (c) => {
  if (!codexHubToken()) return hubOff(c)
  const body = (await jsonBody(c)) as Record<string, unknown> | null | undefined
  const r = redeemPairCode(
    {
      code: body?.code as string,
      id: body?.id as string,
      hash: body?.hash as string,
      install: hubInstallId(c.req.header(HUB_INSTALL_HEADER)),
      from: proxyAddress(c),
    },
    CODEX_HUB_DIR,
  )
  if (!r.ok) {
    logRefusal(c, r.code)
    return refusal(c, r)
  }
  return c.json({ pc: r.pc, key: r.key, id: r.id })
})

// A pending PC's tray trades the legacy token for a token of its own, once, while the window is open.
app.post('/api/codex-hub/exchange', async (c) => {
  const admin = codexHubToken()
  if (!admin) return hubOff(c)
  if (!pcStoreReadable())
    return fail(c, 503, 'store-unreadable', 'the hub cannot read its list of PCs')
  const header = c.req.header('authorization')
  const legacy = legacyToken()
  const isLegacy = !!legacy && legacy !== admin && hubTokenMatches(header, legacy)
  if (!isLegacy || !legacyWindow().open) {
    logRefusal(
      c,
      isLegacy
        ? 'the legacy token, while the migration window is not open'
        : 'not the legacy token',
    )
    return unauthorized(c)
  }
  const body = (await jsonBody(c)) as Record<string, unknown> | null | undefined
  const r = exchangeLegacy(
    {
      id: body?.id as string,
      hash: body?.hash as string,
      install: hubInstallId(c.req.header(HUB_INSTALL_HEADER)),
      from: proxyAddress(c),
    },
    CODEX_HUB_DIR,
  )
  if (!r.ok) {
    logRefusal(c, `the exchange: ${r.code}`)
    return refusal(c, r)
  }
  return c.json({ pc: r.pc, key: r.key, id: r.id })
})

// A PC token retires itself, once its tray has paired the PC under a new name.
app.post('/api/codex-hub/retire', async (c) => {
  const caller = hubCaller(c, CODEX_HUB_DIR, { install: 'required' })
  if (caller instanceof Response) return caller
  if (caller.kind !== 'pc') {
    logRefusal(c, 'the legacy token')
    return unauthorized(c)
  }
  const text = await c.req.text()
  let body: unknown = {}
  try {
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return fail(c, 400, 'bad-request', 'body must be JSON')
  }
  const renamedTo = (body as { renamedTo?: unknown } | null)?.renamedTo
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    (renamedTo !== undefined &&
      (typeof renamedTo !== 'string' ||
        !renamedTo.trim() ||
        renamedTo.length > 64 ||
        CONTROL.test(renamedTo)))
  )
    return fail(
      c,
      400,
      'bad-request',
      'renamedTo, when sent, is a PC name of up to 64 characters and no control characters',
    )
  const r = retirePc(
    caller.key,
    caller.record.tokenId!,
    typeof renamedTo === 'string' ? renamedTo.trim() : null,
    CODEX_HUB_DIR,
  )
  if (!r.ok) return refusal(c, r)
  return c.json({ pc: r.pc, key: r.key, state: r.state })
})

// --- the pairing page ---------------------------------------------------------------------------

// A PC's tray app (codex-hub-tray/) gets a token of its own here. It listens on its own loopback port and opens this
// page; the page hands it a one-time code (core/codex-hub-pcs.ts), posted to that port and nowhere else, which the
// tray redeems with the id and hash of a token it made. A name already in use is offered as `<name>-N` first;
// replacing that PC's token takes a second page, reached only from this one. Outside /api/codex-hub/: serve it only
// behind the operator's sign-in (the inbox's proxy), never to the home network.
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

// The page is outside /api/*, so it runs the loopback guard's check (loopback-guard.mjs) itself, in the default
// any-loopback-port mode rather than the exact-origin one /api/* uses: a Host that is not loopback is a DNS-rebinding
// page reading a code, an Origin that is not loopback a cross-site fetch. A fetch from another loopback port is
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

const PAGE_STYLE = `body{font:16px system-ui,sans-serif;margin:0;padding:48px 16px;background:#f6f6f4;color:#222}
main{max-width:440px;margin:auto}button{font:inherit;padding:10px 22px;border:0;border-radius:8px;background:#2d6a4f;
color:#fff;cursor:pointer}button.other{background:#deded8;color:#222}form{margin:18px 0}p{line-height:1.5}
small{color:#666}@media (prefers-color-scheme:dark){body{background:#1b1b1a;color:#eee}small{color:#aaa}
button.other{background:#3a3a37;color:#eee}}`

const PAIR_NOTE =
  'Only use this when you opened it from the Codex Hub app on the PC you are setting up. If the app answers that ' +
  'the token has a shape it cannot use, it is older than this hub: install the current Codex Hub app on that PC, ' +
  'then choose Connect this PC again.'

/** A page: its title and paragraphs as text (escaped here), and its forms as HTML already escaped. */
function pairPage(title: string, paragraphs: string[], forms: string[] = []): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
${forms.join('\n')}${forms.length ? `\n<p><small>${escapeHtml(PAIR_NOTE)}</small></p>` : ''}</main></body></html>`
}

const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`

const HOW: Record<string, string> = {
  page: 'through this page',
  cli: 'on the command line',
  exchange: 'moved from the old shared token',
}

/** How a key in use came to be: when and how it was paired, or that it pushes with the old shared token. */
const pairedHow = (t: PairTarget): string =>
  t.state === 'pending'
    ? 'it pushes with the old shared token'
    : `paired ${hubWhen(t.record?.pairedAt)} (${HOW[t.record?.pairedBy ?? 'page']})`

app.get('/codex-hub/pair', pairGuard, (c) => {
  if (!codexHubToken())
    return c.text('The Codex hub is off (AGENTHYDRA_CODEX_HUB_TOKEN is not set).', 404)
  const now = Date.now()
  const port = Number(c.req.query('port'))
  const state = c.req.query('state') ?? ''
  const pc = (c.req.query('pc') ?? '').trim()
  const key = pc.length <= 64 ? hubPcKey(pc) : null
  const untilRaw = c.req.query('until')
  const until =
    untilRaw === undefined
      ? null
      : /^\d{1,12}$/.test(untilRaw)
        ? Number(untilRaw) * 1000
        : Number.NaN
  const from = c.req.query('from')?.trim() || null
  const confirm = c.req.query('confirm')
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !/^[0-9a-f]{32}$/.test(state) ||
    !key ||
    CONTROL.test(pc) ||
    Number.isNaN(until) ||
    (from && (from.length > 64 || CONTROL.test(from)))
  )
    return c.text('Open this page from the Codex Hub app on the PC (Connect this PC).', 400)
  const target = `http://127.0.0.1:${port}/paired`
  c.header('cache-control', 'no-store')
  c.header('referrer-policy', 'no-referrer')
  c.header('x-frame-options', 'DENY')
  c.header(
    'content-security-policy',
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${target}; frame-ancestors 'none'`,
  )
  // The tray's until is by its own clock (one from before this hub's Date header was read, or one that got none).
  if (until !== null && until <= now)
    return c.html(
      pairPage('This link has expired', [
        'This pairing link has expired. Choose Connect this PC in the Codex Hub app again.',
        `If you chose it just now, the PC's clock is probably behind the hub's, which says ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC: set the PC's clock right, then choose Connect this PC again.`,
      ]),
      400,
    )
  const t = pairTarget(key, CODEX_HUB_DIR, now)
  if (!t)
    return c.html(
      pairPage('The hub cannot pair PCs now', [
        'The hub cannot read its list of PCs (codex-hub/.pcs.json). Restore it, restart the hub, then choose ' +
          'Connect this PC again.',
      ]),
      503,
    )
  /** The form that posts a code for `name` (key `codeKey`) to the tray. */
  const connect = (label: string, codeKey: string, name: string, replaces: string | null) =>
    `<form method="post" action="${target}">${hidden('state', state)}
${hidden('code', mintPairCode({ key: codeKey, pc: name, replaces, until }, CODEX_HUB_DIR, now))}<button type="submit">${escapeHtml(label)}</button></form>`

  if (confirm !== undefined) {
    const taken = /^[0-9a-f]{64}$/.test(confirm)
      ? takeConfirm(confirm, { key, state, port }, CODEX_HUB_DIR, now)
      : null
    if (!taken)
      return c.html(
        pairPage('This confirmation has expired', [
          'This confirmation was used already or has expired. Choose Connect this PC in the Codex Hub app again.',
        ]),
        400,
      )
    // Unchanged since the page asked: replace it. Changed (paired or revoked meanwhile): the page for it as it is.
    if (taken.replaces === t.replaces && inUse(t)) {
      const online = onlineNow(key, t, now)
      return c.html(
        pairPage(
          `Replace ${pc}'s token`,
          [
            `${t.state === 'pending' ? `${pc} pushes with the old shared token` : `${pc} was ${pairedHow(t)}`}. ` +
              `${t.manifest ? `Its last push was ${hubWhen(t.manifest.pushedAt)}` : 'It has not pushed yet'}, ` +
              `and it is ${online ? 'online now' : 'offline'}.`,
            `Connect and replace gives this PC ${pc}'s place on the hub. ${pc}'s current token stops working at once` +
              (online ? ', its relay closes, and any Desk session on it ends.' : '.'),
            `${pc}'s copies on the hub stay, and this PC's pushes replace them.`,
          ],
          [connect('Connect and replace', key, pc, t.replaces)],
        ),
      )
    }
  }

  if (!inUse(t)) {
    const said =
      t.state === 'revoked'
        ? `${pc} was revoked on ${hubWhen(t.record?.revokedAt)} (${t.record?.revokedWhy ?? 'revoked'}). Connect gives it a new token.`
        : t.state === 'unpaired'
          ? `${pc} has copies here from before (last push ${hubWhen(t.manifest?.pushedAt)}) and no token. Connect gives it a token, and its first push replaces those copies.`
          : `The Codex Hub app on this PC gets a token of its own for ${pc}.`
    const rename =
      from && hubPcKey(from) !== key
        ? [
            `This renames ${from} to ${pc} on the hub. The app retires ${from}'s token once it has connected; ${from}'s copies stay until you forget them.`,
          ]
        : []
    return c.html(pairPage(`Connect ${pc}`, [said, ...rename], [connect('Connect', key, pc, null)]))
  }

  // In use: another PC under the same name comes first; this PC being that one, set up again, is a second step.
  const taken = new Set((hubPcRows(CODEX_HUB_DIR, now)?.pcs ?? []).map((r) => r.key))
  const base = pc.slice(0, 58)
  let other: { name: string; key: string } | null = null
  for (let n = 2; n <= 99 && !other; n++) {
    const name = `${base}-${n}`
    const k = hubPcKey(name)
    if (k && !taken.has(k)) other = { name, key: k }
  }
  const again =
    `<form method="get" action="">${hidden('port', String(port))}${hidden('state', state)}${hidden('pc', pc)}` +
    `${untilRaw !== undefined ? hidden('until', untilRaw) : ''}${from ? hidden('from', from) : ''}` +
    `${hidden('confirm', mintConfirm({ key, state, port, replaces: t.replaces, until }, CODEX_HUB_DIR, now))}` +
    `<button type="submit" class="other">${escapeHtml(`This is ${pc} itself, set up again: replace its token…`)}</button></form>`
  const last = t.manifest ? `last push ${hubWhen(t.manifest.pushedAt)}` : 'no push yet'
  return c.html(
    pairPage(
      `Connect ${pc}`,
      [
        `${pc} is already on this hub: ${pairedHow(t)}; ${last}; ${onlineNow(key, t, now) ? 'online now' : 'offline'}.`,
        other
          ? `If this is another PC, connect it as ${other.name}.`
          : `Every name from ${base}-2 to ${base}-99 is taken: set AGENTHYDRA_CODEX_HUB_PC on this PC to give it a name of its own, then choose Connect this PC again.`,
      ],
      [
        ...(other
          ? [
              connect(
                `This is another PC: connect it as ${other.name}`,
                other.key,
                other.name,
                null,
              ),
            ]
          : []),
        again,
      ],
    ),
  )
})

// --- Desk's directory, Desk's end, and the admin API (loopback only) ------------------------------

/** Desk's end and the admin API take the admin token, and nothing else: no PC token, and not the legacy token. */
async function requireHubOwner(c: Context, next: Next) {
  const admin = codexHubToken()
  if (!admin) return hubOff(c)
  const header = c.req.header('authorization')
  if (!hubTokenMatches(header, admin)) {
    const bearer = hubBearer(header)
    logRefusal(
      c,
      !bearer
        ? 'no bearer token'
        : isPcToken(bearer)
          ? `${tokenName(pcTokenId(bearer)!)}, a PC token`
          : 'not the admin token',
    )
    return unauthorized(c)
  }
  await next()
}

// Which PCs have pushed and when, which have a relay open now (their chats can be continued), and how each is paired.
app.get('/api/codex-relay/pcs', (c) => {
  const live = relayPcs()
  const states = new Map((hubPcRows()?.pcs ?? []).map((r) => [r.key, r.state]))
  return c.json(
    codexHubHomes().map((h) => {
      const key = h.id.slice('hub:'.length)
      const state = states.get(key)
      return {
        id: h.id,
        pc: h.name,
        pushedAt: h.manifest.pushedAt,
        chats: new Set(h.manifest.threads.map((t) => t.id)).size,
        relay: live.has(key),
        ...(state ? { state } : {}),
      }
    }),
  )
})

// A PC's relay socket: open while its pusher runs. Every refusal is an HTTP answer before the upgrade, so the PC
// never sees the socket open; checked again in onOpen, a credential that changed in between is closed with
// RELAY_REFUSED and never registered.
const relayCallers = new WeakMap<Request, { key: string; caller: HubCaller }>()

async function relayGate(c: Context, next: Next) {
  const caller = hubCaller(c, CODEX_HUB_DIR, { install: 'required' })
  if (caller instanceof Response) return caller
  let key: string
  if (caller.kind === 'pc')
    key = caller.key // ?pc= is the token's to say, and is ignored
  else {
    const named = (c.req.query('pc') ?? '').trim()
    const k = hubPcKey(named)
    if (!k) return fail(c, 400, 'bad-request', 'pc is required')
    if (stillValid(caller, k, CODEX_HUB_DIR)) {
      logRefusal(c, notPending(k, caller.install))
      return unauthorized(c)
    }
    // Only the manifest's own install gets this far, so this cannot fire; kept as the hold always was.
    if (hubNameRefused(k, caller.install)) return fail(c, 409, 'name-taken', hubNameTaken(named))
    key = k
  }
  relayCallers.set(c.req.raw, { key, caller })
  await next()
}

app.get(
  '/api/codex-hub/relay',
  relayGate,
  upgradeWebSocket((c) => {
    const { key, caller } = relayCallers.get(c.req.raw)!
    const tokenId = caller.kind === 'pc' ? caller.record.tokenId! : 'legacy'
    let link: PcLink | null = null
    let closed = false
    const open = (ws: WSContext) => {
      if (closed) return
      if (stillValid(caller, key, CODEX_HUB_DIR))
        return ws.close(RELAY_REFUSED, reason("This PC's token is no longer valid on the hub."))
      const pcLink: PcLink = {
        // A dropped line leaves an app-server on the PC waiting for it: every session on this socket ends instead.
        send: (msg) => {
          if (dropped(ws, JSON.stringify(msg)))
            relayPcGone(key, pcLink, 'The hub could not keep up sending to the PC.')
        },
        close: (why, code = 1000) => ws.close(code, reason(why)),
      }
      link = pcLink
      relayPcConnected(key, link, caller.install, tokenId)
    }
    return {
      onOpen(_event, ws) {
        const wait = codexHubTestHooks.beforeRelayOpen?.(key, tokenId)
        if (wait) void wait.then(() => open(ws))
        else open(ws)
      },
      onMessage(event) {
        if (link) relayFromPc(link, String(event.data))
      },
      onClose() {
        closed = true
        if (link) relayPcGone(key, link)
      },
    }
  }),
)

// Desk's end: one app-server on PC `key` (its hub id without `hub:`), as raw JSON-RPC lines. Before each session the
// PC's live link must still hold its credential: a legacy link outlives the window's end, which nothing else closes.
app.get(
  '/api/codex-relay/:key/app-server',
  requireHubOwner,
  upgradeWebSocket((c) => {
    const key = c.req.param('key') ?? ''
    let session: RelaySession | null = null
    return {
      onOpen(_event, ws) {
        if (!linkCredentialValid(key, relayPcToken(key))) {
          closeRelayUnless(key, null, "This PC's token is no longer valid on the hub.")
          return ws.close(4004, 'That PC is not connected to the Codex hub now.')
        }
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

// The admin API, for scripts/codex-hub-pcs.ts: list the PCs, give one a token made on the command line, revoke one,
// forget one. Under /api/codex-relay/ with Desk's end, outside the forwarded /api/codex-hub/, and not under a name
// such as /api/codex-hub-admin/ that a proxy's `location /api/codex-hub` without the slash would forward.
app.get('/api/codex-relay/admin/pcs', requireHubOwner, (c) => {
  const list = hubPcRows()
  return list
    ? c.json(list)
    : fail(c, 503, 'store-unreadable', 'the hub cannot read its list of PCs')
})

app.post('/api/codex-relay/admin/pcs', requireHubOwner, async (c) => {
  const body = (await jsonBody(c)) as Record<string, unknown> | null | undefined
  const r = registerPcToken(
    {
      pc: body?.pc as string,
      id: body?.id as string,
      hash: body?.hash as string,
      replace: body?.replace === true,
    },
    CODEX_HUB_DIR,
  )
  if (!r.ok) return refusal(c, r)
  return c.json({ pc: r.pc, key: r.key, id: r.id })
})

app.post('/api/codex-relay/admin/pcs/:key/revoke', requireHubOwner, (c) => {
  const r = revokePc(c.req.param('key') ?? '', CODEX_HUB_DIR)
  if (!r.ok) return refusal(c, r)
  return c.json({ pc: r.pc, key: r.key, state: r.state, relayClosed: r.relayClosed })
})

app.delete('/api/codex-relay/admin/pcs/:key', requireHubOwner, (c) => {
  const r = forgetPc(c.req.param('key') ?? '', CODEX_HUB_DIR)
  if (!r.ok) return refusal(c, r)
  return c.json({ pc: r.pc, key: r.key, removed: true })
})
