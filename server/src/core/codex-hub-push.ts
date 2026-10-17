// server/src/core/codex-hub-push.ts — this PC's side of the Codex hub (codex-hub.ts).
//
// Asks this PC's own Codex app-server for its chat list (thread/list: the same list, titles and order
// the Codex app shows) and pushes it to the hub, then sends each rollout the hub answers it lacks.
// Runs inside the daemon when AGENTHYDRA_CODEX_HUB_URL is set, and on its own as
// `bun server/src/codex-hub-push-main.ts` on a PC that does not run AgentHydra from source.

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { appEnv, CODEX_HOME, CONFIG_DIR } from '../config'
import type { HubFile, HubThread } from './codex-hub'
import {
  HUB_PUSH_INTERVAL_MAX_MS,
  hubInstallHeaders,
  hubInstallId,
  hubNameTaken,
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
  token: string
  /** The name this PC is listed under on the hub. */
  pc: string
  /** This pusher's install id (pusherInstallId), sent with each push and relay connect; none when absent or null. */
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
 * (`Mac.lan` at home, `Mac.local` elsewhere, `Mac.home.arpa`, `Mac.fritz.box`, or whatever name the network's DNS
 * has for it), and hubPcKey keeps all of it (`mac-lan`), so one Mac showed up as two PCs: on a Mac it is the
 * Bonjour name (`scutil --get LocalHostName`), else the hostname's first label. Elsewhere it is the computer's name
 * less a trailing `.local`, `.lan`, `.home` or `.localdomain`; a Windows computer name has none, so the PCs already
 * on a hub keep their key.
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

/**
 * This pusher's install id, made at random once and kept in `file`: the hub tells two PCs that send one name apart
 * by it (codex-hub.ts hubNameRefused). Null when the file can be neither read nor made: the pusher then sends none,
 * as the first pushers did, rather than a new one at each start that its own last push would hold the name against.
 */
export function pusherInstallId(file: string): string | null {
  try {
    const kept = hubInstallId(readFileSync(file, 'utf8'))
    if (kept) return kept
  } catch {
    // not made yet
  }
  const id = randomUUID()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${id}\n`)
    return id
  } catch {
    return null
  }
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
    install: pusherInstallId(PUSHER_INSTALL_FILES[pusher]),
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
    // Another PC holds this name on the hub; the next round asks again, and gets it once that PC has gone.
    if (res.status === 409) throw new Error(hubNameTaken(cfg.pc))
    if (!res.ok)
      throw new Error(`Codex hub answered ${res.status} ${(await res.text()).slice(0, 200)}`)
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
