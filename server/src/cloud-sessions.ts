// server/src/cloud-sessions.ts - Claude Code sessions that run in the cloud or over Remote Control.
//
// WHY THIS EXISTS. Every other source AgentHydra reads is a store on this disk. Claude Code's cloud
// sessions (`environment_kind: anthropic_cloud`) and Remote Control sessions (`bridge`) have no local
// store at all: the only list of them is the one claude.ai's own sessions page reads, and that list
// is exactly the "which of my sessions are waiting on me" view a person wants from AgentHydra. Local
// Desktop "Code" tab sessions are NOT in it; those are already read from disk.
//
// HOW IT FITS THE REST. The network stays in this file. What it learns lands in the two places the
// rest of the app already reads:
//   * a per-account cache under `<root>/<account>/` (sessions.json plus one `<id>.jsonl` per session
//     whose events were streamed), which the `claude-cloud` foreign adapter lists and reads like any
//     other store, so the list, search and the transcript view need nothing new;
//   * the live status store (agent-status.ts), as `claude-cloud` rows, so "working / waiting on you /
//     done" reads the same for a cloud session as for a local one.
//
// THREE CHANNELS, CHEAPEST FIRST.
//   1. Discovery: `GET /v1/code/sessions` per account, on a timer. `unread` + `status_bucket` is what
//      claude.ai itself shows as waiting on you; `worker_status` says whether a turn is running.
//   2. Live: a WebSocket per session that is WORKING, so a finished turn or a question shows at once
//      instead of at the next poll. Idle sessions get no socket: nothing will happen on them until
//      someone writes to them, and that someone shows up in the next poll.
//   3. `GET /v1/code/sessions/watch` (SSE) replaces the polling when the server offers it. It answers
//      404 "endpoint not enabled" on accounts that do not have it yet, so it is retried rarely and
//      the poll keeps running until it connects.
//
// CREDENTIALS. Value-blind, same discipline as usage-api.ts: the CLI's own OAuth access token goes
// into a request header and nowhere else - never persisted, logged or sent to the browser - and is
// never refreshed here (rotating the refresh token would log the user's real CLI out). An account
// whose token has expired is skipped until the CLI refreshes it. The token needs the
// `user:sessions:claude_code` scope; a `claude setup-token` token can be given in
// CLAUDE_CODE_OAUTH_TOKEN for a machine that never runs the CLI interactively.
//
// OPT-IN. Nothing here runs unless AGENTHYDRA_CLOUD_SESSIONS=1.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentStatusEvent } from './agent-status'
import { recordAgentStatus, releaseCloudStatus } from './agent-status'
import { type CloudSessionRow, writeCloudSnapshot } from './cloud-sessions-cache'
import { claudeUserAgent } from './usage-api'

export { cloudSessionsRoot } from './cloud-sessions-cache'
export type { CloudSessionRow }

export const CLOUD_SESSIONS_ENV = 'AGENTHYDRA_CLOUD_SESSIONS'
/** The scope the sessions endpoints require. A token without it is skipped, not retried. */
export const SESSIONS_SCOPE = 'user:sessions:claude_code'

const ANTHROPIC_VERSION = '2023-06-01'
/**
 * Hosts tried in order; the first that answers the list with a 200 is kept for that account.
 * api.anthropic.com serves both the list and the socket to a CLI OAuth token with no beta header
 * (checked 2026-10-14). claude.ai serves the same paths to its own web page, but answers a
 * non-browser client with a Cloudflare 403, so it is not tried.
 */
const DEFAULT_BASES = ['https://api.anthropic.com']
const POLL_MS = 60_000
/** With the watch stream connected the poll is only a safety net. */
const POLL_WITH_WATCH_MS = 10 * 60_000
/** How often to ask again whether the watch stream has been enabled for this account. */
const WATCH_RETRY_MS = 30 * 60_000
const LIST_LIMIT = 100

// --- response shape (only the fields we read) --------------------------------

/** One item of `GET /v1/code/sessions` `data[]`. */
export interface ApiCloudSession {
  id?: string
  title?: string | null
  status?: string | null
  /** 'working' | 'blocked' | 'review_ready' | 'completed' | 'failed' as seen so far. */
  status_bucket?: string | null
  /** 'idle' when no turn is running. */
  worker_status?: string | null
  connection_status?: string | null
  /** 'anthropic_cloud' | 'bridge' (Remote Control). */
  environment_kind?: string | null
  unread?: boolean | null
  last_event_at?: string | null
  updated_at?: string | null
  created_at?: string | null
  user_message_count?: number | null
  tags?: string[] | null
}

interface ApiList {
  data?: ApiCloudSession[]
  next_cursor?: string | null
}

export interface CloudAccount {
  /** Stable, filesystem-safe key for the cache directory. Never the address. */
  key: string
  token: string
  orgUuid: string
}

// --- mapping -----------------------------------------------------------------

export function toCloudRow(s: ApiCloudSession): CloudSessionRow | null {
  if (!s?.id) return null
  const last = s.last_event_at || s.updated_at || s.created_at
  if (!last) return null
  return {
    id: s.id,
    title: s.title?.trim() || 'Claude Code session',
    environment_kind: s.environment_kind || 'unknown',
    status_bucket: s.status_bucket || 'unknown',
    worker_status: s.worker_status || 'unknown',
    unread: s.unread === true,
    created_at: s.created_at ?? null,
    last_event_at: last,
    tags: Array.isArray(s.tags) ? s.tags.filter((t) => typeof t === 'string') : [],
  }
}

/**
 * A cloud session's state, in the status store's own terms.
 *
 * A running turn is working whatever else is true. Otherwise the session waits on the person when
 * claude.ai would show it so: a reply nobody has read, or a bucket that means "your move". Anything
 * else is a finished turn that has been seen.
 *
 * A Project thread is read in the Project, not on the sessions page, so its `unread` stays set and
 * says nothing. There only the bucket counts: `blocked` and `review_ready` wait on the person.
 */
export function cloudStatusEvent(r: CloudSessionRow): AgentStatusEvent {
  const running = r.worker_status !== 'idle' && r.worker_status !== 'unknown'
  const base = { sessionId: r.id, source: 'claude-cloud' as const, at: r.last_event_at }
  if (running || r.status_bucket === 'working') return { ...base, event: 'cloud-working' }
  if (r.status_bucket === 'blocked')
    return { ...base, event: 'cloud-blocked', notificationType: 'input' }
  if (r.tags?.includes('hearth-thread')) {
    return r.status_bucket === 'review_ready'
      ? { ...base, event: 'cloud-blocked', notificationType: 'review' }
      : { ...base, event: 'cloud-done' }
  }
  if (r.unread) return { ...base, event: 'cloud-blocked', notificationType: 'unread' }
  return { ...base, event: 'cloud-done' }
}

// --- accounts ----------------------------------------------------------------

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

interface StoredOauth {
  accessToken?: unknown
  expiresAt?: unknown
  scopes?: unknown
}

/**
 * The account a CLI config dir is logged in as, or null when it cannot reach the sessions endpoints
 * right now (no login, expired token, a token without the sessions scope, no org on record).
 * `userConfigPath` is where that login keeps `.claude.json`: inside the config dir for an isolated
 * CLAUDE_CONFIG_DIR, `~/.claude.json` for the default one.
 */
export function cliCloudAccount(
  configDir: string,
  userConfigPath: string,
  now = Date.now(),
): CloudAccount | null {
  const oauth = readJson<{ claudeAiOauth?: StoredOauth }>(
    join(configDir, '.credentials.json'),
  )?.claudeAiOauth
  const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : ''
  if (!token) return null
  const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : 0
  if (expiresAt > 0 && expiresAt <= now) return null
  const scopes = Array.isArray(oauth?.scopes) ? oauth.scopes : []
  if (!scopes.includes(SESSIONS_SCOPE)) return null
  const orgUuid = readJson<{ oauthAccount?: { organizationUuid?: unknown } }>(userConfigPath)
    ?.oauthAccount?.organizationUuid
  if (typeof orgUuid !== 'string' || !orgUuid) return null
  return { key: `org-${orgUuid}`, token, orgUuid }
}

/**
 * Every account this machine can read cloud sessions for, one per organization.
 *
 * CLAUDE_CODE_OAUTH_TOKEN (a `claude setup-token` token) comes first, with the org from
 * AGENTHYDRA_CLOUD_ORG or the default login's `.claude.json`; then the default CLI login; then each
 * CLI instance AgentHydra manages. Two logins into the same org would list the same sessions twice,
 * so the first one wins.
 */
export function cloudAccounts(
  instanceDirs: string[],
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): CloudAccount[] {
  const out = new Map<string, CloudAccount>()
  const add = (a: CloudAccount | null) => {
    if (a && !out.has(a.key)) out.set(a.key, a)
  }
  const defaultDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
  const defaultUserConfig = env.CLAUDE_CONFIG_DIR?.trim()
    ? join(defaultDir, '.claude.json')
    : join(home, '.claude.json')
  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  if (envToken) {
    const org =
      env.AGENTHYDRA_CLOUD_ORG?.trim() ||
      readJson<{ oauthAccount?: { organizationUuid?: string } }>(defaultUserConfig)?.oauthAccount
        ?.organizationUuid
    if (org) add({ key: `org-${org}`, token: envToken, orgUuid: org })
  }
  add(cliCloudAccount(defaultDir, defaultUserConfig))
  for (const dir of instanceDirs) add(cliCloudAccount(dir, join(dir, '.claude.json')))
  return [...out.values()]
}

// --- HTTP --------------------------------------------------------------------

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

function headers(a: CloudAccount): Record<string, string> {
  return {
    Authorization: `Bearer ${a.token}`,
    Accept: 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'x-organization-uuid': a.orgUuid,
    'user-agent': claudeUserAgent(),
  }
}

export type ListResult =
  | { ok: true; base: string; rows: CloudSessionRow[] }
  | { ok: false; status: number; error: string }

/**
 * Tags that take a session out of the default list. The list answers untagged sessions only, and a
 * session started from a claude.ai Project (`hearth-thread`) or from Cowork (`cowork-*`) carries a
 * tag, so those need a second query that asks for them by tag.
 */
export const LISTED_TAGS = ['hearth-thread', 'cowork-remote', 'cowork-local']

type PageResult =
  | { ok: true; rows: CloudSessionRow[] }
  | { ok: false; status: number; error: string }

/** One query on one host, following `next_cursor`. Never throws. */
async function listPages(
  a: CloudAccount,
  base: string,
  extra: [string, string][],
  fetchFn: Fetch,
): Promise<PageResult> {
  const rows: CloudSessionRow[] = []
  let cursor: string | null = null
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams([
      ['statuses', 'active'],
      ['statuses', 'paused'],
      ['limit', String(LIST_LIMIT)],
      ...extra,
    ])
    if (cursor) q.set('cursor', cursor)
    try {
      const res = await fetchFn(`${base}/v1/code/sessions?${q}`, {
        headers: headers(a),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok)
        return { ok: false, status: res.status, error: `HTTP ${res.status} from ${base}` }
      const body = (await res.json()) as ApiList
      for (const item of body.data ?? []) {
        const row = toCloudRow(item)
        if (row) rows.push(row)
      }
      cursor = body.next_cursor || null
      if (!cursor) break
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return { ok: true, rows }
}

/**
 * Every active and paused session of one account: the default (untagged) list, plus the tagged
 * sessions in LISTED_TAGS. The default list decides whether the account listed at all; a tagged
 * query the server refuses only costs those sessions. Never throws.
 */
export async function listCloudSessions(
  a: CloudAccount,
  bases: string[],
  fetchFn: Fetch = fetch,
): Promise<ListResult> {
  let last: ListResult = { ok: false, status: 0, error: 'no host tried' }
  for (const base of bases) {
    const main = await listPages(a, base, [], fetchFn)
    if (!main.ok) {
      last = main
      // A refused token is refused on every host; only "not here" is worth trying elsewhere.
      if (main.status === 401 || main.status === 403) return main
      continue
    }
    const tagged = await listPages(
      a,
      base,
      LISTED_TAGS.map((t) => ['tags', t] as [string, string]),
      fetchFn,
    )
    const seen = new Set(main.rows.map((r) => r.id))
    const rows = [...main.rows]
    if (tagged.ok) {
      for (const r of tagged.rows) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        rows.push(r)
      }
    }
    return { ok: true, base, rows }
  }
  return last
}

// --- live: one WebSocket per working session ---------------------------------

/** The SDK-style message the subscribe socket sends. Only routing fields are read here. */
interface StreamMessage {
  type?: string
  subtype?: string
}

function subscribeUrl(a: CloudAccount, base: string, sessionId: string): string {
  const wsBase = base.replace(/^http/, 'ws')
  return `${wsBase}/v1/sessions/ws/${encodeURIComponent(sessionId)}/subscribe?organization_uuid=${encodeURIComponent(a.orgUuid)}&replay=true`
}

/** The history arrives in one burst on connect; this long with nothing new means it has all come. */
const REPLAY_QUIET_MS = 3_000
/** A replay that never goes quiet (a turn started meanwhile) is cut here; the next pass redoes it. */
const REPLAY_MAX_MS = 60_000
/** Replays run this many at a time, so a first pass over a long list does not open fifty sockets. */
const REPLAY_PARALLEL = 3

/**
 * One session's whole history, read once off a short-lived subscribe socket into its event cache, for
 * a session that is not working and so has no live socket: without it every idle session opened onto
 * an empty transcript. Written to a temporary file and renamed, so a reader never sees half of it.
 * Answers whether any turn came.
 */
export function replaySession(
  a: CloudAccount,
  base: string,
  root: string,
  sessionId: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const dir = join(root, a.key)
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `${sessionId}.jsonl.tmp`)
    writeFileSync(tmp, '')
    let turns = 0
    let settled = false
    let quiet: ReturnType<typeof setTimeout> | null = null
    let ws: WebSocket | null = null
    const finish = () => {
      if (settled) return
      settled = true
      if (quiet) clearTimeout(quiet)
      clearTimeout(cap)
      try {
        ws?.close()
      } catch {
        // already closed
      }
      if (turns > 0) renameSync(tmp, join(dir, `${sessionId}.jsonl`))
      else rmSync(tmp, { force: true })
      resolve(turns > 0)
    }
    const cap = setTimeout(finish, REPLAY_MAX_MS)
    try {
      ws = new WebSocket(subscribeUrl(a, base, sessionId), { headers: headers(a) })
    } catch {
      finish()
      return
    }
    ws.onmessage = (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data)
      try {
        const msg = JSON.parse(text) as StreamMessage
        if (msg?.type === 'user' || msg?.type === 'assistant') {
          writeFileSync(tmp, `${text}\n`, { flag: 'a' })
          turns++
        }
      } catch {
        // not a message
      }
      if (quiet) clearTimeout(quiet)
      quiet = setTimeout(finish, REPLAY_QUIET_MS)
    }
    ws.onclose = finish
    ws.onerror = finish
  })
}

/** Whether a session's event cache is missing or older than its last event. */
function needsReplay(root: string, a: CloudAccount, r: CloudSessionRow): boolean {
  try {
    return statSync(join(root, a.key, `${r.id}.jsonl`)).mtimeMs < Date.parse(r.last_event_at)
  } catch {
    return true
  }
}

/** Bring the event cache of every session without a live socket up to date, a few at a time. */
async function backfill(
  a: CloudAccount,
  s: AccountState,
  rows: CloudSessionRow[],
  opts: CloudPollerOptions,
) {
  if (!s.base || s.backfilling) return
  const base = s.base
  const todo = rows.filter(
    (r) =>
      !s.sockets.has(r.id) &&
      s.replayed.get(r.id) !== r.last_event_at &&
      needsReplay(opts.root, a, r),
  )
  if (todo.length === 0) return
  s.backfilling = true
  try {
    for (let i = 0; i < todo.length; i += REPLAY_PARALLEL) {
      await Promise.all(
        todo.slice(i, i + REPLAY_PARALLEL).map(async (r) => {
          await replaySession(a, base, opts.root, r.id)
          // Tried once per last event, turns or not: a session with no turns is not asked again.
          s.replayed.set(r.id, r.last_event_at)
        }),
      )
    }
  } catch (err) {
    opts.log?.(`[cloud-sessions] replay: ${err instanceof Error ? err.message : err}`)
  } finally {
    s.backfilling = false
  }
}

/**
 * Keep the session's event cache in step with its socket. `replay=true` sends the whole history on
 * every connect, so a (re)connect starts the file over instead of appending a second copy.
 */
function openSessionSocket(
  a: CloudAccount,
  base: string,
  root: string,
  sessionId: string,
  onChange: () => void,
  onClosed: () => void,
): { close(): void } {
  const file = join(root, a.key, `${sessionId}.jsonl`)
  mkdirSync(join(root, a.key), { recursive: true })
  writeFileSync(file, '')
  // Bun's WebSocket takes request headers as an option; a browser's cannot, which is why this runs
  // in the daemon and not in the page.
  const ws = new WebSocket(subscribeUrl(a, base, sessionId), { headers: headers(a) })
  ws.onmessage = (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : String(ev.data)
    let msg: StreamMessage | null = null
    try {
      msg = JSON.parse(text) as StreamMessage
    } catch {
      return
    }
    if (msg?.type === 'user' || msg?.type === 'assistant')
      writeFileSync(file, `${text}\n`, { flag: 'a' })
    // A status change or a finished turn is the moment worth a fresh list read.
    if (msg?.type === 'system' || msg?.type === 'result') onChange()
  }
  ws.onclose = () => {
    onClosed()
    onChange()
  }
  return { close: () => ws.close() }
}

// --- the poller --------------------------------------------------------------

interface AccountState {
  base: string | null
  sockets: Map<string, { close(): void }>
  /** Per session: no new socket before this time. A socket that keeps being refused (a token the
   *  socket endpoint will not take) must not turn the kick on close into a reconnect loop. */
  socketRetryAt: Map<string, number>
  watching: boolean
  nextWatchTry: number
  /** Per session: the last_event_at its history was last replayed for. */
  replayed: Map<string, string>
  backfilling: boolean
}

export interface CloudPollerOptions {
  accounts: () => CloudAccount[]
  root: string
  bases?: string[]
  fetchFn?: Fetch
  /** Off in tests: they drive one cycle at a time and open no sockets. */
  live?: boolean
  log?: (line: string) => void
}

/**
 * One discovery pass over every account: list, cache, status, and the set of open sockets brought
 * in line with which sessions are working. Answers the rows written per account key.
 */
export async function syncCloudSessions(
  opts: CloudPollerOptions,
  state = new Map<string, AccountState>(),
): Promise<Map<string, CloudSessionRow[]>> {
  const written = new Map<string, CloudSessionRow[]>()
  let allListed = true
  const bases = opts.bases ?? DEFAULT_BASES
  for (const a of opts.accounts()) {
    let s = state.get(a.key)
    if (!s) {
      s = {
        base: null,
        sockets: new Map(),
        socketRetryAt: new Map(),
        watching: false,
        nextWatchTry: 0,
        replayed: new Map(),
        backfilling: false,
      }
      state.set(a.key, s)
    }
    const res = await listCloudSessions(a, s.base ? [s.base] : bases, opts.fetchFn)
    if (!res.ok) {
      opts.log?.(`[cloud-sessions] ${a.key}: ${res.error}`)
      allListed = false
      if (s.base) s.base = null
      continue
    }
    s.base = res.base
    writeCloudSnapshot(opts.root, a.key, res.rows)
    for (const r of res.rows) recordAgentStatus(cloudStatusEvent(r))
    written.set(a.key, res.rows)
    if (opts.live !== false) {
      reconcileSockets(a, s, res.rows, opts)
      void backfill(a, s, res.rows, opts)
    }
  }
  if (allListed && written.size > 0)
    releaseCloudStatus([...written.values()].flat().map((r) => r.id))
  return written
}

function reconcileSockets(
  a: CloudAccount,
  s: AccountState,
  rows: CloudSessionRow[],
  opts: CloudPollerOptions,
): void {
  if (!s.base) return
  const working = new Set(
    rows.filter((r) => cloudStatusEvent(r).event === 'cloud-working').map((r) => r.id),
  )
  for (const [id, sock] of s.sockets) {
    if (!working.has(id)) {
      sock.close()
      s.sockets.delete(id)
    }
  }
  for (const id of working) {
    if (s.sockets.has(id) || (s.socketRetryAt.get(id) ?? 0) > Date.now()) continue
    try {
      s.sockets.set(
        id,
        openSessionSocket(
          a,
          s.base,
          opts.root,
          id,
          () => kick(),
          () => {
            s.sockets.delete(id)
            s.socketRetryAt.set(id, Date.now() + POLL_MS)
          },
        ),
      )
    } catch (err) {
      opts.log?.(`[cloud-sessions] socket ${id}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

/**
 * Hold the account's watch stream open while the server offers it. Any event on it is a reason to
 * re-list; the stream's own payloads are not parsed, so a change in their shape cannot break this.
 */
async function watchAccount(a: CloudAccount, s: AccountState, log?: (l: string) => void) {
  if (!s.base || s.watching || Date.now() < s.nextWatchTry) return
  s.watching = true
  s.nextWatchTry = Date.now() + WATCH_RETRY_MS
  try {
    const res = await fetch(`${s.base}/v1/code/sessions/watch?exclude_tags=-`, {
      headers: { ...headers(a), Accept: 'text/event-stream' },
    })
    if (!res.ok || !res.body) return
    log?.(`[cloud-sessions] ${a.key}: watch stream connected`)
    const reader = res.body.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
      kick()
    }
  } catch {
    // A dropped stream falls back to the poll; the next retry window brings it back.
  } finally {
    s.watching = false
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
let running: Promise<unknown> | null = null
let kickPending = false
let pollerOpts: CloudPollerOptions | null = null
const pollerState = new Map<string, AccountState>()

function schedule(ms: number) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void cycle(), ms)
}

async function cycle() {
  if (!pollerOpts) return
  if (running) {
    kickPending = true
    return
  }
  running = syncCloudSessions(pollerOpts, pollerState).catch((err) =>
    pollerOpts?.log?.(`[cloud-sessions] ${err instanceof Error ? err.message : err}`),
  )
  await running
  running = null
  for (const a of pollerOpts.accounts()) {
    const s = pollerState.get(a.key)
    if (s) void watchAccount(a, s, pollerOpts.log)
  }
  const anyWatching = [...pollerState.values()].some((s) => s.watching)
  if (kickPending) {
    kickPending = false
    schedule(1_000)
  } else schedule(anyWatching ? POLL_WITH_WATCH_MS : POLL_MS)
}

/** Something changed on a socket or the watch stream: re-list soon, once. */
function kick() {
  if (pollerOpts) schedule(1_000)
}

export function cloudSessionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CLOUD_SESSIONS_ENV] === '1'
}

export function startCloudSessions(opts: CloudPollerOptions): void {
  if (pollerOpts) return
  pollerOpts = opts
  if (!existsSync(opts.root)) mkdirSync(opts.root, { recursive: true })
  schedule(0)
}

export function stopCloudSessions(): void {
  if (timer) clearTimeout(timer)
  timer = null
  for (const s of pollerState.values()) for (const sock of s.sockets.values()) sock.close()
  pollerState.clear()
  pollerOpts = null
}
