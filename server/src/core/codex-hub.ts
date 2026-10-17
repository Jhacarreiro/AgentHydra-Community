// server/src/core/codex-hub.ts — Codex chats from OTHER PCs, pushed here by their own AgentHydra.
//
// A Codex chat lives on the PC that ran it: its rollout under that PC's CODEX_HOME, its place in the
// sidebar in that PC's state database. A daemon on a server (or on another PC) never sees it. Codex's
// own remote control does not help: it pairs one PC with the ChatGPT app over OpenAI's encrypted relay
// and offers no API to anything else. So each PC asks its own Codex app-server for its chat list
// (codex-hub-push.ts) and pushes the list, plus every rollout that changed, to one hub daemon.
//
// The hub keeps each PC's copy as a Codex home of its own under <CONFIG_DIR>/codex-hub/<pc>/:
// `sessions/` holds the rollouts at the same relative paths as on the PC, `session_index.jsonl`
// the titles, and `manifest.json` the list as that PC's app-server last answered it. Because it is
// shaped like a Codex home, codexInstanceStores() serves it to the transcript index unchanged, so
// listing, reading and search treat a pushed chat like a local one. The analytics kit leaves it out
// (kit/ingest-foreign.ts): it is the other PC's usage, which kit sync would count twice. Read-only:
// nothing here can start a turn on, rename or archive a chat on the PC it came from.
//
// Off unless AGENTHYDRA_CODEX_HUB_TOKEN is set; then every push must carry it as a bearer token.
// Any number of PCs may push with the same token; each is kept apart by the name it sends, and two
// that send one name by the install id each sends with it (hubNameRefused).

import { timingSafeEqual } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { appEnv, CONFIG_DIR } from '../config'
import { relayPcInstall } from './codex-hub-relay'
import { HUB_PLATFORMS } from './codex-hub-signature'

/** One chat as the PC's app-server listed it (the subset of its `Thread` the hub keeps). */
export interface HubThread {
  id: string
  name: string | null
  preview: string
  cwd: string | null
  /** Unix seconds, as app-server reports it. */
  updatedAt: number
  /** `cli`, `vscode`, ... (app-server's SessionSource; an object source is sent as its key). */
  source: string
  /** The rollout's path relative to the PC's CODEX_HOME (`sessions/2026/10/14/rollout-...jsonl`). */
  path: string | null
}

export interface HubFile {
  path: string
  updatedAt: number
  /** The rollout, gzipped, base64. */
  gz: string
}

export interface HubPush {
  pc: string
  /** How long its pusher waits between pushes; its name is held for three of them (hubNameHoldMs). */
  intervalMs?: number
  threads: HubThread[]
  files?: HubFile[]
}

export interface HubManifest {
  pc: string
  /** The install id of the pusher that sent it (HUB_INSTALL_HEADER); absent when it sent none. */
  install?: string
  /** The interval its pusher sent, up to HUB_PUSH_INTERVAL_MAX_MS; absent when it sent none. */
  intervalMs?: number
  pushedAt: string
  threads: HubThread[]
  /** Relative rollout path -> the `updatedAt` of the thread row it was copied for. */
  files: Record<string, number>
}

export const CODEX_HUB_DIR = join(CONFIG_DIR, 'codex-hub')
const MANIFEST = 'manifest.json'
const PC_MAX = 63
/** Only paths a rollout can have: under sessions/, no `..`, a .jsonl file. */
const ROLLOUT_PATH = /^sessions\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.jsonl$/
/**
 * What one push's rollouts may unpack to, alone or together. A long chat's rollout runs to tens
 * of MB, and the pusher sends up to 6 MiB of them per push or one bigger file on its own, so only
 * a gzip bomb comes near this.
 */
export const ROLLOUT_UNPACKED_MAX = 256 * 1024 * 1024
/** The year 10000 in Unix seconds: a chat's time is from 1970 up to here. */
const TIME_END = 253_402_300_800

/**
 * The header a pusher names its install with, on every push and on its relay socket (codex-hub-push.ts). A PC is
 * kept by its name, and two can send one: WSL beside the Windows PC it runs on, two Linux boxes called `ubuntu`, the
 * daemon's pusher beside a standalone one. They replaced each other's relay socket every few seconds, which ended
 * every Desk session on it, and each push deleted the other's rollouts. The id tells them apart.
 */
export const HUB_INSTALL_HEADER = 'x-codex-hub-install'
/** The least an install keeps its name from another one after its last push: five pushes at the default interval. */
const HUB_NAME_HOLD_MS = 10 * 60_000
/** The longest a pusher waits between pushes (codex-hub-push.ts); three of them, a day, is the longest hold. */
export const HUB_PUSH_INTERVAL_MAX_MS = 8 * 60 * 60_000
const INSTALL_ID = /^[A-Za-z0-9_-]{8,64}$/

export function codexHubToken(): string | null {
  return appEnv('CODEX_HUB_TOKEN')?.trim() || null
}

export function hubTokenMatches(header: string | undefined, token: string): boolean {
  const presented = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!presented) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** An install id as a pusher sent it, or null for none, or for what is not one (taken as none). */
export function hubInstallId(raw: string | null | undefined): string | null {
  const id = raw?.trim()
  return id && INSTALL_ID.test(id) ? id : null
}

/** The request headers that name install `id` to the hub; none for no id. */
export function hubInstallHeaders(id: string | null | undefined): Record<string, string> {
  return id ? { [HUB_INSTALL_HEADER]: id } : {}
}

/**
 * What a pusher refused its name is told, and logs. A name of its own is for another machine: two pushers on one
 * PC (the daemon's and a standalone one) push the same chats, and another name for one lists each twice on the hub.
 */
export function hubNameTaken(pc: string): string {
  return (
    `another PC already pushes as ${pc}; set AGENTHYDRA_CODEX_HUB_PC to give this one a name of its own; ` +
    'if both pushers run on this PC, stop one of them instead'
  )
}

/** A pusher's interval as it sent it, up to HUB_PUSH_INTERVAL_MAX_MS, or null for none or for what is not one. */
function cleanInterval(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.min(raw, HUB_PUSH_INTERVAL_MAX_MS)
    : null
}

/**
 * How long a push holds its PC's name: three of its pusher's intervals, so one that pushes every half hour with its
 * relay off still holds it at its next push, and HUB_NAME_HOLD_MS at least, the hold for one that sent none.
 */
function hubNameHoldMs(intervalMs: unknown): number {
  return Math.max(HUB_NAME_HOLD_MS, 3 * (cleanInterval(intervalMs) ?? 0))
}

/**
 * Whether install `claim` is refused PC `key`'s name. Another install holds it while its relay socket is open, and
 * for hubNameHoldMs after its last push; once it has gone (the PC set up again, with a new id) the name passes to
 * the next. A pusher that sends no id, as the first ones did, is never refused and holds its name against no one.
 */
export function hubNameRefused(
  key: string,
  claim: string | null,
  root: string = CODEX_HUB_DIR,
): boolean {
  if (!claim) return false
  const live = relayPcInstall(key)
  if (live && live !== claim) return true
  const last = readCodexHubManifest(join(root, key))
  return (
    !!last?.install &&
    last.install !== claim &&
    Date.now() - Date.parse(last.pushedAt) < hubNameHoldMs(last.intervalMs)
  )
}

/** The folder name for a PC: its name lowercased to letters, digits and dashes. */
export function hubPcKey(pc: string): string | null {
  const key = pc
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PC_MAX)
  return key || null
}

/** A rollout path from another machine, relative to its CODEX_HOME: the part from `sessions/` on. */
export function relativeRolloutPath(path: string | null | undefined): string | null {
  if (!path) return null
  const parts = path.split(/[\\/]+/)
  const at = parts.lastIndexOf('sessions')
  if (at === -1) return null
  const rel = parts.slice(at).join('/')
  return ROLLOUT_PATH.test(rel) && !rel.split('/').includes('..') ? rel : null
}

/** The list a PC last pushed into this hub folder, or null for a folder that is not a hub copy. */
export function readCodexHubManifest(dir: string): HubManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as HubManifest
    return parsed && Array.isArray(parsed.threads) && parsed.files ? parsed : null
  } catch {
    return null
  }
}

function writeAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

const isTime = (t: number): boolean => Number.isFinite(t) && t >= 0 && t < TIME_END

/** The rollout unpacked, or null when it would pass `room` bytes. Throws on what is not gzip. */
function gunzipWithin(gz: Buffer, room: number): Buffer | null {
  try {
    const bytes = gunzipSync(gz, { maxOutputLength: Math.max(room, 1) })
    return bytes.length <= room ? bytes : null
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') return null
    throw error
  }
}

function cleanThread(raw: unknown): HubThread | null {
  const t = raw as Partial<HubThread> | null
  if (!t || typeof t.id !== 'string' || !t.id.trim() || typeof t.updatedAt !== 'number') return null
  return {
    id: t.id.trim(),
    name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : null,
    preview: typeof t.preview === 'string' ? t.preview : '',
    cwd: typeof t.cwd === 'string' && t.cwd ? t.cwd : null,
    updatedAt: t.updatedAt,
    source: typeof t.source === 'string' ? t.source : 'unknown',
    path: relativeRolloutPath(t.path),
  }
}

export type HubPushResult =
  | { ok: true; pc: string; stored: number; want: string[] }
  | { ok: false; status: 400 | 409 | 413; error: string }

/**
 * Takes one PC's push: its whole chat list (which replaces the last one) and any rollouts it sent.
 * Answers the rollout paths the hub still lacks at the version listed, so the PC sends those next;
 * a rollout no listed chat names any more (archived or deleted there) is removed here.
 * A refused push writes nothing: every time is checked and every rollout unpacked first.
 * `install` is the pusher's install id: a name another install holds is refused (hubNameRefused).
 */
export function acceptCodexHubPush(
  body: unknown,
  root: string = CODEX_HUB_DIR,
  maxUnpacked: number = ROLLOUT_UNPACKED_MAX,
  install: string | null = null,
): HubPushResult {
  const push = body as Partial<HubPush> | null
  const pc = typeof push?.pc === 'string' ? push.pc.trim() : ''
  const key = pc ? hubPcKey(pc) : null
  if (!key) return { ok: false, status: 400, error: 'pc is required' }
  if (hubNameRefused(key, install, root)) return { ok: false, status: 409, error: hubNameTaken(pc) }
  if (!Array.isArray(push?.threads))
    return { ok: false, status: 400, error: 'threads must be a list' }
  const threads = push.threads.map(cleanThread).filter((t): t is HubThread => t !== null)
  // Each is printed as an ISO time, in the index below and in the chat list (codex-chat-list.ts),
  // and toISOString throws for a time no Date can hold: refused before anything is written.
  const badThread = threads.find((t) => !isTime(t.updatedAt))
  if (badThread)
    return {
      ok: false,
      status: 400,
      error: `thread ${badThread.id}: updatedAt ${badThread.updatedAt} is not a time in Unix seconds`,
    }
  // Titles where the transcript index looks for them (transcript.ts parseCodexSessionIndex), built
  // before anything is written: a new manifest is never left beside the old index.
  const index = threads
    .filter((t) => t.name)
    .map((t) =>
      JSON.stringify({
        id: t.id,
        thread_name: t.name,
        updated_at: new Date(t.updatedAt * 1000).toISOString(),
      }),
    )

  const incoming: { rel: string; updatedAt: number; bytes: Buffer }[] = []
  let unpacked = 0
  for (const f of Array.isArray(push.files) ? push.files : []) {
    const rel = relativeRolloutPath(f?.path)
    if (!rel || typeof f.gz !== 'string' || typeof f.updatedAt !== 'number') continue
    if (!isTime(f.updatedAt))
      return {
        ok: false,
        status: 400,
        error: `${rel}: updatedAt ${f.updatedAt} is not a time in Unix seconds`,
      }
    let bytes: Buffer | null
    try {
      bytes = gunzipWithin(Buffer.from(f.gz, 'base64'), maxUnpacked - unpacked)
    } catch {
      continue
    }
    // 413, as for a body over the limit: the pusher then sends one file per push, and leaves out
    // one that is too big on its own.
    if (!bytes)
      return {
        ok: false,
        status: 413,
        error: unpacked
          ? `${rel} takes this push's rollouts past ${maxUnpacked} bytes unpacked; send it on its own`
          : `${rel} unpacks to more than ${maxUnpacked} bytes, more than the hub keeps of one rollout`,
      }
    unpacked += bytes.length
    incoming.push({ rel, updatedAt: f.updatedAt, bytes })
  }

  const dir = join(root, key)
  const previous = readCodexHubManifest(dir)
  const files: Record<string, number> = { ...(previous?.files ?? {}) }

  // Rollouts first, so a manifest never names a file that is not there yet.
  for (const f of incoming) {
    writeAtomic(join(dir, ...f.rel.split('/')), f.bytes)
    files[f.rel] = f.updatedAt
  }
  const stored = incoming.length

  // A rollout of each listed version per path: an older row for the same file never asks for it again.
  const listed = new Map<string, number>()
  for (const t of threads)
    if (t.path) listed.set(t.path, Math.max(listed.get(t.path) ?? 0, t.updatedAt))
  for (const rel of Object.keys(files)) {
    if (listed.has(rel)) continue
    rmSync(join(dir, ...rel.split('/')), { force: true })
    delete files[rel]
  }
  const want = [...listed]
    .filter(
      ([rel, at]) =>
        !(rel in files) || files[rel]! < at || !existsSync(join(dir, ...rel.split('/'))),
    )
    .map(([rel]) => rel)

  const intervalMs = cleanInterval(push.intervalMs)
  const manifest: HubManifest = {
    pc,
    ...(install ? { install } : {}),
    ...(intervalMs ? { intervalMs } : {}),
    pushedAt: new Date().toISOString(),
    threads,
    files,
  }
  writeAtomic(join(dir, MANIFEST), JSON.stringify(manifest))
  writeAtomic(join(dir, 'session_index.jsonl'), index.length ? `${index.join('\n')}\n` : '')
  return { ok: true, pc, stored, want }
}

export interface CodexHubHome {
  /** `hub:<pc key>`, the instance id its chats carry. */
  id: string
  /** The PC's name as it sent it. */
  name: string
  codexHome: string
  manifest: HubManifest
}

/** Every PC that has pushed here, by folder. Empty when the hub has never been used. */
export function codexHubHomes(root: string = CODEX_HUB_DIR): CodexHubHome[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const homes: CodexHubHome[] = []
  for (const key of entries.sort()) {
    const codexHome = join(root, key)
    const manifest = readCodexHubManifest(codexHome)
    if (manifest) homes.push({ id: `hub:${key}`, name: manifest.pc || key, codexHome, manifest })
  }
  return homes
}

/**
 * The pusher build this hub hands out (codex-hub-update.ts): each PC's pusher fetches it when its own differs, so a
 * PC is installed once. `.pusher` can never be a PC's folder: hubPcKey makes no dots. Absent: PCs keep what they have.
 * This is the Windows build; hubBuildFile names the others.
 */
export const PUSHER_EXE = join(CODEX_HUB_DIR, '.pusher', 'codex-hub-push.exe')
/** The Windows tray app that keeps the pusher running and both builds current (codex-hub-tray/). */
export const TRAY_EXE = join(CODEX_HUB_DIR, '.pusher', 'codex-hub-tray.exe')

/** The platforms a build is handed out for (codex-hub-signature.ts, which the signing script reads too). */
export { HUB_PLATFORMS }

/**
 * The file the hub hands out for one build and platform, or null for a platform it does not know. No platform is
 * windows-x64: the pushers and trays installed before there were other builds ask without one. An empty one is not:
 * a PC that meant to name its platform is refused, not handed the Windows build. The Windows builds keep their
 * first names (PUSHER_EXE, TRAY_EXE); every other is `codex-hub-push-<platform>`, with no extension.
 */
export function hubBuildFile(name: 'pusher' | 'tray', platform?: string): string | null {
  const p = platform ?? 'windows-x64'
  if (!(HUB_PLATFORMS as readonly string[]).includes(p)) return null
  if (p === 'windows-x64') return name === 'pusher' ? PUSHER_EXE : TRAY_EXE
  return join(CODEX_HUB_DIR, '.pusher', `codex-hub-${name === 'pusher' ? 'push' : 'tray'}-${p}`)
}

const pusherHashes = new Map<string, { mtimeMs: number; size: number; sha256: string }>()

/**
 * The build's SHA-256 and size, hashed again only when the file changed, and its signature (codex-hub-signature.ts)
 * when `<build>.sig` is beside it; null when there is no build.
 */
export async function pusherRelease(
  path: string = PUSHER_EXE,
): Promise<{ sha256: string; size: number; signature?: string } | null> {
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(path)
  } catch {
    return null
  }
  let known = pusherHashes.get(path)
  if (!known || known.mtimeMs !== st.mtimeMs || known.size !== st.size) {
    known = { mtimeMs: st.mtimeMs, size: st.size, sha256: await sha256File(path) }
    pusherHashes.set(path, known)
  }
  const signature = buildSignature(path)
  return { sha256: known.sha256, size: known.size, ...(signature ? { signature } : {}) }
}

/** What scripts/codex-hub-sign.ts wrote beside the build, read at each request; undefined without it. */
function buildSignature(path: string): string | undefined {
  try {
    return readFileSync(`${path}.sig`, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  for await (const chunk of createReadStream(path)) hasher.update(chunk as Buffer)
  return hasher.digest('hex')
}
