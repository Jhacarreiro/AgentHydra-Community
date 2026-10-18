// server/src/core/codex-hub-push.ts — this PC's side of the Codex hub (codex-hub.ts).
//
// Asks this PC's own Codex app-server for its chat list (thread/list: the same list, titles and order
// the Codex app shows) and pushes it to the hub, then sends each rollout the hub answers it lacks.
// Runs inside the daemon when AGENTHYDRA_CODEX_HUB_URL is set, and on its own as
// `bun server/src/codex-hub-push-main.ts` on a PC that does not run AgentHydra from source.
//
// It pushes with this PC's own token (AGENTHYDRA_CODEX_HUB_TOKEN: the Codex Hub app's, or one from
// scripts/codex-hub-pcs.ts add on the hub). The hub takes the PC from the token, whatever name a push sends, and
// takes the token only from the install id bound to it (codex-hub-pcs.ts): AGENTHYDRA_CODEX_HUB_INSTALL when the
// tray passes one, else the pusher's own file. A pusher never trades the shared token of before for a token of its
// own: it pushes with it while the hub's migration window lets it, and says what to do once the hub refuses it.

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { appEnv, CODEX_HOME, CONFIG_DIR } from '../config'
import type { HubFile, HubThread } from './codex-hub'
import {
  HUB_PUSH_INTERVAL_MAX_MS,
  hubInstallHeaders,
  hubInstallId,
  hubNameTaken,
  isPcToken,
  relativeRolloutPath,
} from './codex-hub'
import { startCodexHubRelay } from './codex-hub-relay-pc'
import { type CodexRpc, connectCodexRpc } from './codex-rpc'

/** What thread/list answers per row; only the fields pushed are named. */
interface AppServerThread {
  id: string
  name?: string | null
  preview?: string
  cwd?: string | null
  path?: string | null
  updatedAt: number
  source?: unknown
}

export interface CodexHubPushConfig {
  url: string
  /** This PC's own token (chp_…), or the shared token of before while the hub's migration window lets it push. */
  token: string
  /** The name this PC is listed under on the hub. A PC token's key is its own: this only sets how it is written. */
  pc: string
  /**
   * This pusher's install id (AGENTHYDRA_CODEX_HUB_INSTALL, else pusherInstallId), sent with each request to the hub;
   * none when absent or null, which the hub refuses a PC token.
   */
  install?: string | null
  /** Extra request headers, e.g. a Cloudflare Access service token in front of the hub. */
  headers: Record<string, string>
  /** Sent with each push too: the hub holds this PC's name for three of them after it (codex-hub.ts hubNameHoldMs). */
  intervalMs: number
}

/** A push request's rollouts stay under this many raw bytes, well inside the hub's 16 MiB body limit. */
const BATCH_BYTES = 6 * 1024 * 1024

/** A Mac's Bonjour name (Sharing's "Local hostname"), which stays the same on every network; undefined if unread. */
function macLocalHostName(): string | undefined {
  try {
    const r = Bun.spawnSync(['/usr/sbin/scutil', '--get', 'LocalHostName'], { stderr: 'ignore' })
    return (r.success && r.stdout.toString().trim()) || undefined
  } catch {
    return undefined
  }
}

/**
 * The name a PC is listed under when AGENTHYDRA_CODEX_HUB_PC is unset. A Mac's hostname changes with the network
 * (`Example-Mac.lan` on one, `Example-Mac.local` on another, `Example-Mac.home.arpa`, `Example-Mac.fritz.box`, or
 * whatever name the network's DNS has for it), and hubPcKey keeps all of it (`example-mac-lan`), so one Mac showed
 * up as two PCs: on a Mac it is the Bonjour name (`scutil --get LocalHostName`), else the hostname's first label.
 * Elsewhere it is the computer's name less a trailing `.local`, `.lan`, `.home` or `.localdomain`; a Windows computer
 * name has none, so the PCs already on a hub keep their key.
 */
export function defaultPcName(
  host: string = hostname(),
  platform: string = process.platform,
  localHostName: () => string | undefined = macLocalHostName,
): string {
  if (platform === 'darwin') return localHostName() || host.split('.')[0] || host
  return host.replace(/(?:\.(?:local|lan|home|localdomain))+$/i, '') || host
}

/**
 * Where each pusher keeps its install id: the daemon's and the standalone one's apart, so the two on one PC are two
 * installs, not one whose sockets replace each other.
 */
export const PUSHER_INSTALL_FILES = {
  daemon: join(CONFIG_DIR, 'codex-hub-install'),
  standalone: join(CONFIG_DIR, 'codex-hub-push-install'),
} as const

/** How long a pusher waits for another one to write the install file it has just made, before it takes it as empty. */
const INSTALL_WAIT_MS = 500

/** Makes `file` 0600 where it is not (the first pushers wrote it 0644); a file it cannot change is left as it is. */
function keepPrivate(file: string): void {
  if (process.platform === 'win32') return
  try {
    if ((statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600)
  } catch {
    // another user's file, or gone: the id in it still serves
  }
}

/**
 * This pusher's install id, made at random once and kept in `file`, one id and a newline at mode 0600: the hub binds
 * this PC's token to it (codex-hub-pcs.ts), so the token alone opens nothing from another install. The file is
 * created exclusively, so two pushers that start at once end with one id: the one that loses takes the winner's. An
 * empty file is another pusher between its create and its write, and is waited for a moment; one that holds no id
 * after that is replaced. Null when the file can be neither read nor made: the pusher then sends none, and the hub
 * answers install-required, which hubRefusal words.
 */
export function pusherInstallId(file: string): string | null {
  const deadline = Date.now() + INSTALL_WAIT_MS
  let raced = false
  for (;;) {
    let raw: string | null = null
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      // not made yet, or not readable: making it says which
    }
    const kept = hubInstallId(raw)
    if (kept) {
      keepPrivate(file)
      return kept
    }
    if (raw === '' && Date.now() < deadline) {
      Bun.sleepSync(20)
      continue
    }
    const id = randomUUID()
    if (raw !== null) {
      // There, and no id in it: replaced whole, so no reader sees half of it.
      const tmp = `${file}.${process.pid}.tmp`
      try {
        writeFileSync(tmp, `${id}\n`, { mode: 0o600 })
        chmodSync(tmp, 0o600)
        renameSync(tmp, file)
        return id
      } catch {
        rmSync(tmp, { force: true })
        return null
      }
    }
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const fd = openSync(file, 'wx', 0o600)
      try {
        writeSync(fd, `${id}\n`)
      } finally {
        closeSync(fd)
      }
      return id
    } catch (error) {
      // Another pusher made it first: its id is the one to keep. Once only: a file there that cannot be read is
      // no install id.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || raced) return null
      raced = true
    }
  }
}

/** The install id AGENTHYDRA_CODEX_HUB_INSTALL sets, in place of the pusher's file; undefined when it is unset. */
function installFromEnv(): string | undefined {
  const raw = appEnv('CODEX_HUB_INSTALL')?.trim()
  if (!raw) return undefined
  const id = hubInstallId(raw)
  if (!id)
    throw new Error(
      'AGENTHYDRA_CODEX_HUB_INSTALL must be 8 to 64 letters, digits, dashes or underscores.',
    )
  return id
}

/**
 * What this PC's pusher says when the hub refused it, by the code in the hub's answer (routes/codex-hub.ts); null
 * for an answer it has no words of its own for. The hub answers a bearer that is not a PC token with a bare 401
 * whatever the reason, so a token of before that is refused is told the one fix there is: a token of its own.
 */
export function hubRefusal(status: number, body: string, token: string): string | null {
  let code: unknown
  try {
    code = (JSON.parse(body) as { code?: unknown } | null)?.code
  } catch {
    // not the hub's error body
  }
  if (code === 'revoked') return "the hub revoked this PC's token; pair it again"
  if (code === 'unknown-token')
    return "the hub does not know this PC's token (it was paired again elsewhere, or forgotten); pair it again"
  if (code === 'install-mismatch')
    return 'this token belongs to another install of the pusher; pair this PC on its own'
  if (code === 'install-required')
    return `this pusher has no install id: ${CONFIG_DIR} cannot be written; fix that, or set AGENTHYDRA_CODEX_HUB_INSTALL`
  if (status === 401 && !isPcToken(token))
    return 'the hub no longer takes the shared token: pair this PC with the Codex Hub app, or put a token from `scripts/codex-hub-pcs.ts add` in AGENTHYDRA_CODEX_HUB_TOKEN'
  return null
}

export function codexHubPushConfig(
  pusher: keyof typeof PUSHER_INSTALL_FILES = 'daemon',
): CodexHubPushConfig | null {
  const url = appEnv('CODEX_HUB_URL')?.trim()
  const token = appEnv('CODEX_HUB_TOKEN')?.trim()
  if (!url || !token) return null
  let headers: Record<string, string> = {}
  const raw = appEnv('CODEX_HUB_HEADERS')?.trim()
  if (raw) {
    try {
      headers = JSON.parse(raw) as Record<string, string>
    } catch {
      throw new Error(
        'AGENTHYDRA_CODEX_HUB_HEADERS must be a JSON object of header names to values.',
      )
    }
  }
  const minutes = Number(appEnv('CODEX_HUB_INTERVAL_MIN') ?? '2')
  return {
    url: url.replace(/\/+$/, ''),
    token,
    pc: appEnv('CODEX_HUB_PC')?.trim() || defaultPcName(),
    // The file is not touched when the tray, or the owner, names the id.
    install: installFromEnv() ?? pusherInstallId(PUSHER_INSTALL_FILES[pusher]),
    headers,
    // Eight hours at most: the hub holds this PC's name for three intervals after a push (codex-hub.ts
    // hubNameHoldMs), and for a day at most.
    intervalMs: Math.min(
      Math.max(1, Number.isFinite(minutes) ? minutes : 2) * 60_000,
      HUB_PUSH_INTERVAL_MAX_MS,
    ),
  }
}

const sourceName = (s: unknown): string =>
  typeof s === 'string'
    ? s
    : s && typeof s === 'object'
      ? (Object.keys(s)[0] ?? 'unknown')
      : 'unknown'

/** Every unarchived chat, as the PC's Codex app lists it (one row per rollout file). */
export async function listLocalThreads(rpc: CodexRpc): Promise<AppServerThread[]> {
  const out: AppServerThread[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  do {
    const page: { data: AppServerThread[]; nextCursor: string | null } = await rpc.call(
      'thread/list',
      {
        archived: false,
        limit: 100,
        cursor,
        modelProviders: [],
        sortKey: 'updated_at',
      },
    )
    out.push(...page.data)
    cursor = page.nextCursor
    if (cursor && seen.has(cursor)) break
    if (cursor) seen.add(cursor)
  } while (cursor)
  return out
}

export function toHubThread(t: AppServerThread): HubThread {
  return {
    id: t.id,
    name: t.name ?? null,
    preview: t.preview ?? '',
    cwd: t.cwd ?? null,
    updatedAt: t.updatedAt,
    source: sourceName(t.source),
    path: relativeRolloutPath(t.path),
  }
}

interface PushDeps {
  /** Opens this PC's app-server; tests pass a stand-in. */
  connect?: (codexHome: string) => Promise<CodexRpc>
  fetch?: typeof fetch
  codexHome?: string
}

export interface PushOutcome {
  threads: number
  sent: number
  missing: number
}

/** One round: list, push the list, send what the hub wants in batches, until it wants nothing it can be sent. */
export async function pushCodexHubOnce(
  cfg: CodexHubPushConfig,
  deps: PushDeps = {},
): Promise<PushOutcome> {
  const codexHome = deps.codexHome ?? CODEX_HOME
  const doFetch = deps.fetch ?? fetch
  const rpc = await (deps.connect ?? ((home) => connectCodexRpc(home)))(codexHome)
  let rows: AppServerThread[]
  try {
    rows = await listLocalThreads(rpc)
  } finally {
    await rpc.close()
  }
  const threads = rows.map(toHubThread)
  const versionOf = new Map<string, number>()
  for (const t of threads)
    if (t.path) versionOf.set(t.path, Math.max(versionOf.get(t.path) ?? 0, t.updatedAt))

  const post = async (files: HubFile[]): Promise<string[] | 'too-large'> => {
    const res = await doFetch(`${cfg.url}/api/codex-hub/push`, {
      method: 'POST',
      headers: {
        ...cfg.headers,
        ...hubInstallHeaders(cfg.install),
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({ pc: cfg.pc, intervalMs: cfg.intervalMs, threads, files }),
    })
    if (res.status === 413 && files.length) return 'too-large'
    if (!res.ok) {
      const body = await res.text()
      const refused = hubRefusal(res.status, body, cfg.token)
      if (refused) throw new Error(refused)
      // Another PC holds this name on the hub (the shared token of before only); the next round asks again, and
      // gets it once that PC has gone.
      if (res.status === 409) throw new Error(hubNameTaken(cfg.pc))
      throw new Error(`Codex hub answered ${res.status} ${body.slice(0, 200)}`)
    }
    return ((await res.json()) as { want?: string[] }).want ?? []
  }

  let want = (await post([])) as string[]
  let sent = 0
  // Paths that cannot be sent this round: gone from disk, or too large for one request on their own.
  const unsendable = new Set<string>()
  let oneAtATime = false
  while (want.some((rel) => !unsendable.has(rel))) {
    const batch: HubFile[] = []
    let bytes = 0
    for (const rel of want) {
      if (unsendable.has(rel)) continue
      const file = join(codexHome, ...rel.split('/'))
      let raw: Buffer
      try {
        if (batch.length && (oneAtATime || bytes + statSync(file).size > BATCH_BYTES)) continue
        raw = readFileSync(file)
      } catch {
        unsendable.add(rel) // gone since the list was read; the next round's list will not name it
        continue
      }
      bytes += raw.length
      batch.push({
        path: rel,
        updatedAt: versionOf.get(rel) ?? 0,
        gz: Buffer.from(Bun.gzipSync(new Uint8Array(raw))).toString('base64'),
      })
    }
    if (!batch.length) break
    const answer = await post(batch)
    if (answer === 'too-large') {
      if (batch.length === 1) unsendable.add(batch[0]!.path)
      oneAtATime = true
      continue
    }
    sent += batch.length
    want = answer
  }
  return { threads: threads.length, sent, missing: want.length }
}

/** How long after a turn ends on this PC its chats are pushed: the turn's last lines are written by then. */
const AFTER_TURN_MS = 3_000

/**
 * Pushes now and then every interval until stopped, and keeps the relay to the hub open
 * (codex-hub-relay-pc.ts) so Desk can continue this PC's chats; a turn that ends here is pushed at once.
 * A failed round is logged and retried next interval.
 */
export function startCodexHubPusher(cfg: CodexHubPushConfig, deps: PushDeps = {}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let running = false
  let again = false
  const relay = startCodexHubRelay(cfg, { onTurnDone: () => schedule(AFTER_TURN_MS) })
  // While Desk holds an app-server here, the chat list is read through it: a second one on this home could
  // refresh the login beside it.
  const roundDeps: PushDeps = {
    ...deps,
    connect: deps.connect ?? (async (home) => relay?.localRpc() ?? connectCodexRpc(home)),
  }
  const round = async () => {
    timer = null
    if (running) {
      again = true
      return
    }
    running = true
    try {
      const r = await pushCodexHubOnce(cfg, roundDeps)
      if (r.sent)
        console.log(`[codex-hub] pushed ${r.threads} chats, sent ${r.sent} rollouts to ${cfg.url}`)
    } catch (error) {
      console.error(
        `[codex-hub] push to ${cfg.url} failed:`,
        error instanceof Error ? error.message : error,
      )
    }
    running = false
    if (again) {
      again = false
      return schedule(0)
    }
    schedule(cfg.intervalMs)
  }
  function schedule(ms: number) {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(round, ms)
  }
  void round()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    relay?.stop()
  }
}
