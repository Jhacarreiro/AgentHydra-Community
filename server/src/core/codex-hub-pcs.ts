// server/src/core/codex-hub-pcs.ts — which PC a Codex hub lets act as which, and how a PC gets its token.
//
// Each PC holds a token of its own (codex-hub-ids.ts), made on the PC by its tray, or on the hub by the command line
// for a PC without one (scripts/codex-hub-pcs.ts). The hub is sent the token's id and SHA-256 and keeps those in
// `<CONFIG_DIR>/codex-hub/.pcs.json` (mode 600), one record per PC key, bound to one install id: never the token.
// A token is checked by its id, then its hash in constant time; the id is not secret. Re-pairing a key replaces its
// token in place, so the old one is unknown at once; revoking keeps the record, so the old one answers `revoked`.
//
// The store is read once per root and cached; each write updates the file and the cache in the same synchronous
// call, so two requests never interleave. The daemon is its only writer: the command line goes through the admin
// API, and an owner who edits the file by hand restarts the hub. A store that will not parse, or has another
// version, fails closed: every PC token is refused with 503, the migration window counts as closed, nothing is
// written, and the file is never overwritten.
//
// Pairing (routes/codex-hub.ts, the page behind the owner's sign-in) hands the tray a one-time code, kept here in
// memory with the key it is for and the credential it may replace; the tray redeems it with its new token's id and
// hash. Replacing a PC that has a token takes a confirmation the page hands out first. A hub restart forgets both.
//
// The migration window (legacyWindow) lets the PCs that pushed with the one shared token of before move by
// themselves: while it is open, that token acts only for a pending key (pendingKeys), with that key's own install
// id, until its tray exchanges it for a token of its own (exchangeLegacy). Pending is worked out at each request from
// the folders and the store; only `legacy.since` and `legacy.claimed` are kept. Every function takes the hub's
// folder as `root` and the time as `now`, so tests give each its own.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { appEnv } from '../config'
import {
  CODEX_HUB_DIR,
  codexHubHomes,
  codexHubToken,
  type HubManifest,
  hubInstallId,
  hubPcKey,
  legacyToken,
  readCodexHubManifest,
} from './codex-hub'
import { isHubPcKey, pcTokenHash, pcTokenId } from './codex-hub-ids'
import { closeRelayUnless, relayPcs } from './codex-hub-relay'

export type PairedBy = 'page' | 'cli' | 'exchange'

/** One key's entry in the store. An optional field is left out while it is unset. */
export interface HubPcRecord {
  /** The PC's name as it was paired, which the hub writes when a push names it otherwise. */
  pc: string
  /** Absent on a placeholder: what revoking a key with no token writes. A placeholder never matches a token. */
  tokenId?: string
  /** The SHA-256 of the whole token, lowercase hex. */
  tokenHash?: string
  /** The install id bound to the token; absent only on a token from the command line that has not been used. */
  install?: string
  pairedAt?: string
  pairedBy?: PairedBy
  /** The address the proxy said the pairing came from: informational only. */
  pairedFrom?: string
  firstUsedAt?: string
  revokedAt?: string
  revokedWhy?: string
  /** When an exchange for this PC's install arrived after it had moved (exchangeLegacy). */
  contestedAt?: string
}

interface PcStore {
  version: 1
  pcs: Record<string, HubPcRecord>
  /** `since`: when the hub first saw the legacy token. `claimed`: install ids that can no longer be pending. */
  legacy?: { since?: string; claimed?: string[] }
}

/** The codes of a refusal (routes/codex-hub.ts adds hub-off and too-large). */
export type HubPcCode =
  | 'bad-request'
  | 'install-required'
  | 'bad-key'
  | 'unauthorized'
  | 'unknown-token'
  | 'revoked'
  | 'pair-code'
  | 'not-found'
  | 'install-mismatch'
  | 'name-taken'
  | 'name-changed'
  | 'id-taken'
  | 'name-paired'
  | 'store-unwritable'
  | 'store-unreadable'

export interface HubRefusal {
  ok: false
  status: 400 | 401 | 404 | 409 | 500 | 503
  code: HubPcCode
  /** A sentence for a log. */
  error: string
}

const STORE = '.pcs.json'
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** A pairing code's and a confirmation's longest life; never past the tray's listener either. */
const PAIR_CODE_MS = 20 * MINUTE
/** How many codes, and how many confirmations, may be outstanding; making one more drops the oldest. */
const PAIR_CODES_MAX = 32
/** The migration window's default length, from `legacy.since`. */
const WINDOW_MS = 7 * DAY
/** A folder last pushed this long before `legacy.since` is too old to move by itself. */
const PENDING_FLOOR_MS = 30 * DAY
/** A PC is online now when its relay is live, or it pushed this recently. */
const ONLINE_MS = 10 * MINUTE
const CLAIMED_MAX = 256
const TOKEN_ID = /^[0-9a-f]{16}$/
const TOKEN_HASH = /^[0-9a-f]{64}$/
const PAIR_CODE = /^[0-9a-f]{64}$/
/** An ISO 8601 date or date-time, the shapes AGENTHYDRA_CODEX_HUB_LEGACY_UNTIL may take. */
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/

const refuse = (status: HubRefusal['status'], code: HubPcCode, error: string): HubRefusal => ({
  ok: false,
  status,
  code,
  error,
})
const unreadable = (): HubRefusal =>
  refuse(503, 'store-unreadable', `the hub cannot read codex-hub/${STORE}; restore it and restart`)
const installRequired = (): HubRefusal =>
  refuse(400, 'install-required', 'send the install id in x-codex-hub-install')
const unwritable = (): HubRefusal =>
  refuse(500, 'store-unwritable', `the hub could not write codex-hub/${STORE}`)
const iso = (now: number): string => new Date(now).toISOString()

/** How a log names a token: by its id, never more. */
export const tokenName = (id: string): string => `chp_${id}`
/** How a log names an install id: its first 8 characters. */
export const installName = (install: string): string => `${install.slice(0, 8)}…`

/** A time as the page, the logs and the command line write it: `2026-10-18 09:00 UTC`. */
export function hubWhen(at: string | number | undefined): string {
  const t = typeof at === 'number' ? at : Date.parse(at ?? '')
  return Number.isFinite(t)
    ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : String(at ?? 'never')
}

// --- the store -----------------------------------------------------------------------------------

interface Loaded {
  /** Null when the file could not be read: everything fails closed. */
  store: PcStore | null
  /** Token id -> key, for every record that has one. */
  byId: Map<string, string>
}

const stores = new Map<string, Loaded>()

function indexOf(store: PcStore): Map<string, string> {
  const byId = new Map<string, string>()
  for (const [key, r] of Object.entries(store.pcs)) if (r.tokenId) byId.set(r.tokenId, key)
  return byId
}

/** Why `raw` is not a store this version reads, or null when it is one. */
function badStore(raw: unknown): string | null {
  const s = raw as Partial<PcStore> | null
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'it is not a JSON object'
  if (s.version !== 1) return `its version is ${JSON.stringify(s.version)}, not 1`
  if (!s.pcs || typeof s.pcs !== 'object' || Array.isArray(s.pcs)) return 'it has no pcs object'
  const ids = new Set<string>()
  for (const [key, r] of Object.entries(s.pcs)) {
    if (!isHubPcKey(key)) return `${JSON.stringify(key)} is not a PC's key`
    if (!r || typeof r !== 'object' || typeof r.pc !== 'string') return `${key} has no pc`
    if (r.tokenId !== undefined && !TOKEN_ID.test(r.tokenId)) return `${key} has a bad tokenId`
    if (r.tokenHash !== undefined && !TOKEN_HASH.test(r.tokenHash))
      return `${key} has a bad tokenHash`
    if (!r.tokenId !== !r.tokenHash) return `${key} has a tokenId without a tokenHash`
    if (r.tokenId && ids.has(r.tokenId)) return `two records have the token id ${r.tokenId}`
    if (r.tokenId) ids.add(r.tokenId)
  }
  const legacy = s.legacy
  if (legacy !== undefined) {
    if (!legacy || typeof legacy !== 'object') return 'its legacy entry is not an object'
    if (legacy.since !== undefined && !Number.isFinite(Date.parse(legacy.since)))
      return 'legacy.since is not a time'
    if (
      legacy.claimed !== undefined &&
      !(Array.isArray(legacy.claimed) && legacy.claimed.every((c) => typeof c === 'string'))
    )
      return 'legacy.claimed is not a list of install ids'
  }
  return null
}

/** The store under `root`, read at its first use. A missing file is an empty store. */
function load(root: string): Loaded {
  const known = stores.get(root)
  if (known) return known
  const file = join(root, STORE)
  let loaded: Loaded = { store: { version: 1, pcs: {} }, byId: new Map() }
  let raw: string | null = null
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      loaded = { store: null, byId: new Map() }
      console.error(
        `[codex-hub] ${file} cannot be read (${code}): every PC token is refused until it is restored and the ` +
          'hub restarts; it is never written over',
      )
    }
  }
  if (raw !== null) {
    let why: string | null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
      why = badStore(parsed)
    } catch {
      why = 'it is not JSON'
    }
    if (why) {
      loaded = { store: null, byId: new Map() }
      console.error(
        `[codex-hub] ${file} cannot be read (${why}): every PC token is refused until it is restored and the ` +
          'hub restarts; it is never written over',
      )
    } else {
      const store = parsed as PcStore
      loaded = { store, byId: indexOf(store) }
    }
  }
  stores.set(root, loaded)
  return loaded
}

/** Writes `next` as the temporary file at 0600, then renames it over the store, then caches it. */
function save(root: string, next: PcStore): boolean {
  const file = join(root, STORE)
  try {
    // Made here only when the hub has never kept a PC: then it is the hub's to make private.
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    // A temporary file left by an earlier run keeps its mode through writeFileSync: this sets it either way.
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  } catch (error) {
    console.error(
      `[codex-hub] could not write ${file}: ${error instanceof Error ? error.message : error}`,
    )
    return false
  }
  stores.set(root, { store: next, byId: indexOf(next) })
  return true
}

/** Read, change, write, rename, in one synchronous call; null when it was written. */
function change(root: string, edit: (store: PcStore) => void): HubRefusal | null {
  const { store } = load(root)
  if (!store) return unreadable()
  const next = structuredClone(store)
  edit(next)
  return save(root, next) ? null : unwritable()
}

/** Adds an install id to `legacy.claimed`, once, dropping the oldest past CLAIMED_MAX. */
function claim(store: PcStore, install: string | undefined): void {
  if (!install) return
  const claimed = [...(store.legacy?.claimed ?? [])]
  if (claimed.includes(install)) return
  claimed.push(install)
  store.legacy = { ...store.legacy, claimed: claimed.slice(-CLAIMED_MAX) }
}

const idInUse = (root: string, id: string): boolean => load(root).byId.has(id)

/** Whether the store under `root` could be read; when not, everything that needs it is refused with 503. */
export function pcStoreReadable(root: string = CODEX_HUB_DIR): boolean {
  return load(root).store !== null
}

// --- the migration window and pending keys -------------------------------------------------------

export interface LegacyWindow {
  open: boolean
  /** When the hub first saw the legacy token; set once the token is. */
  since?: string
  /** When the window ends (or ended). */
  until?: string
}

let untilWarned: string | null = null

/** When a window that opened at `since` ends: AGENTHYDRA_CODEX_HUB_LEGACY_UNTIL, or `since` plus 7 days. */
function windowEnd(since: string): number {
  const raw = appEnv('CODEX_HUB_LEGACY_UNTIL')?.trim()
  if (raw) {
    const at = ISO_TIME.test(raw) ? Date.parse(raw) : Number.NaN
    if (Number.isFinite(at)) return at
    if (untilWarned !== raw) {
      untilWarned = raw
      console.error(
        `[codex-hub] AGENTHYDRA_CODEX_HUB_LEGACY_UNTIL=${raw} is not an ISO 8601 date or date-time; ` +
          'the window ends 7 days after the hub first saw the legacy token',
      )
    }
  }
  return Date.parse(since) + WINDOW_MS
}

/**
 * The migration window. Open while the hub is on, the legacy token is set and is not the admin token, the store
 * reads, and the end has not passed. The first time it sees the legacy token set it writes `legacy.since`, and
 * never moves it: setting the token again after the window has closed reopens nothing unless the end moves too.
 */
export function legacyWindow(root: string = CODEX_HUB_DIR, now: number = Date.now()): LegacyWindow {
  const admin = codexHubToken()
  const legacy = legacyToken()
  if (!admin || !legacy || legacy === admin) return { open: false }
  const { store } = load(root)
  if (!store) return { open: false }
  let since = store.legacy?.since
  if (!since) {
    const first = iso(now)
    if (
      change(root, (s) => {
        s.legacy = { ...s.legacy, since: first }
      })
    )
      return { open: false }
    since = first
  }
  const end = windowEnd(since)
  return { open: now < end, since, until: iso(end) }
}

/** The store, the folders and the window, worked out once for one request. */
interface Survey {
  root: string
  store: PcStore
  window: LegacyWindow
  /** Every folder with a manifest, by key. */
  homes: Map<string, HubManifest>
  /** The pending keys and their manifests. */
  pending: Map<string, HubManifest>
  /** Why each folder without a record is not pending (2.5's `why`). */
  why: Map<string, string>
}

const pushedAt = (m: HubManifest): number => Date.parse(m.pushedAt) || 0

function survey(root: string, now: number): Survey | null {
  const window = legacyWindow(root, now)
  const { store } = load(root)
  if (!store) return null
  const homes = new Map<string, HubManifest>()
  for (const h of codexHubHomes(root)) homes.set(h.id.slice('hub:'.length), h.manifest)
  const claimed = new Set(store.legacy?.claimed ?? [])
  for (const r of Object.values(store.pcs)) if (r.install) claimed.add(r.install)
  const since = store.legacy?.since
  const floor = since ? Date.parse(since) - PENDING_FLOOR_MS : null
  const why = new Map<string, string>()
  const byInstall = new Map<string, [string, HubManifest][]>()
  for (const [key, m] of homes) {
    if (store.pcs[key]) continue
    const install = hubInstallId(m.install)
    if (!install) why.set(key, 'no-install')
    else if (floor !== null && !(Date.parse(m.pushedAt) >= floor)) why.set(key, 'old')
    else if (claimed.has(install)) why.set(key, 'claimed')
    else byInstall.set(install, [...(byInstall.get(install) ?? []), [key, m]])
  }
  const pending = new Map<string, HubManifest>()
  for (const folders of byInstall.values()) {
    // The newest push wins; on a tie, the lowest key.
    folders.sort(([a, ma], [b, mb]) => pushedAt(mb) - pushedAt(ma) || (a < b ? -1 : 1))
    const [[newest, manifest], ...older] = folders as [
      [string, HubManifest],
      ...[string, HubManifest][],
    ]
    for (const [key] of older) why.set(key, `duplicate:${newest}`)
    if (window.open) pending.set(newest, manifest)
    else why.set(newest, 'window-closed')
  }
  return { root, store, window, homes, pending, why }
}

/** The keys the legacy token may act for now, sorted. Empty while the window is not open. */
export function pendingKeys(root: string = CODEX_HUB_DIR, now: number = Date.now()): string[] {
  return [...(survey(root, now)?.pending.keys() ?? [])].sort()
}

/** The pending key whose manifest carries `install`, or null; there is at most one. */
export function pendingKeyFor(
  install: string | null,
  root: string = CODEX_HUB_DIR,
  now: number = Date.now(),
): string | null {
  if (!install) return null
  for (const [key, m] of survey(root, now)?.pending ?? []) if (m.install === install) return key
  return null
}

// --- the state of a key --------------------------------------------------------------------------

export type HubPcState = 'token' | 'pending' | 'revoked' | 'unpaired' | 'free'

export interface PairTarget {
  state: HubPcState
  /** The credential a pairing would replace: a token id, 'legacy' for a pending key, or null. */
  replaces: string | null
  record?: HubPcRecord
  manifest?: HubManifest
  /** Why an unpaired key is not pending. */
  why?: string
}

function targetOf(s: Survey, key: string): PairTarget {
  const record = s.store.pcs[key]
  const manifest = s.homes.get(key)
  const m = manifest ? { manifest } : {}
  if (record)
    return record.tokenId && !record.revokedAt
      ? { state: 'token', replaces: record.tokenId, record, ...m }
      : { state: 'revoked', replaces: null, record, ...m }
  if (!manifest) return { state: 'free', replaces: null }
  if (s.pending.has(key)) return { state: 'pending', replaces: 'legacy', manifest }
  return { state: 'unpaired', replaces: null, manifest, why: s.why.get(key) ?? 'window-closed' }
}

/**
 * What key `key` is now, and what a pairing for it would replace: the one answer the page, redeem, `add`, the list
 * and Desk's directory all use. Null when the store cannot be read.
 */
export function pairTarget(
  key: string,
  root: string = CODEX_HUB_DIR,
  now: number = Date.now(),
): PairTarget | null {
  const s = survey(root, now)
  return s ? targetOf(s, key) : null
}

/** Whether a key is in use: a pairing for it replaces something, so the page asks first. */
export const inUse = (t: PairTarget): boolean => t.state === 'token' || t.state === 'pending'

/** Whether a key is online now: its relay is live, or it pushed in the last ten minutes. */
export function onlineNow(key: string, t: PairTarget, now: number = Date.now()): boolean {
  return relayPcs().has(key) || (!!t.manifest && now - Date.parse(t.manifest.pushedAt) < ONLINE_MS)
}

// --- tokens --------------------------------------------------------------------------------------

export type PcLookup = { ok: true; key: string; record: HubPcRecord } | HubRefusal

/** The record a PC token belongs to: found by its id, then its hash compared in constant time. */
export function pcByToken(token: string, root: string = CODEX_HUB_DIR): PcLookup {
  const id = pcTokenId(token)
  const { store, byId } = load(root)
  if (!store) return unreadable()
  const key = id ? byId.get(id) : undefined
  const record = key ? store.pcs[key] : undefined
  const known =
    !!record?.tokenHash &&
    timingSafeEqual(Buffer.from(pcTokenHash(token), 'hex'), Buffer.from(record.tokenHash, 'hex'))
  if (!key || !record || !known)
    return refuse(401, 'unknown-token', 'the hub does not know this PC token')
  if (record.revokedAt) return refuse(401, 'revoked', `${record.pc} was revoked on the hub`)
  return { ok: true, key, record }
}

/** Binds an unbound token to the install id it was first used with. */
export function bindPcInstall(
  key: string,
  tokenId: string,
  install: string,
  root: string = CODEX_HUB_DIR,
): HubRefusal | null {
  return change(root, (s) => {
    const r = s.pcs[key]
    if (r && r.tokenId === tokenId && !r.install) r.install = install
  })
}

/** Notes a token's first use, once. */
export function markPcUsed(
  key: string,
  tokenId: string,
  root: string = CODEX_HUB_DIR,
  now: number = Date.now(),
): HubRefusal | null {
  return change(root, (s) => {
    const r = s.pcs[key]
    if (r && r.tokenId === tokenId && !r.firstUsedAt) r.firstUsedAt = iso(now)
  })
}

const closeWhy = (replaces: string | null): string =>
  replaces === 'legacy'
    ? 'This PC has a token of its own now.'
    : replaces
      ? 'This PC was paired again.'
      : "This PC's token is no longer valid on the hub."

interface Pairing {
  pc: string
  id: string
  hash: string
  install?: string | null
  by: PairedBy
  from?: string | null
}

/**
 * Writes key `key`'s record for a new token, in place of what it had. While the window is open, an install id the
 * key leaves behind (its record's, or a pending manifest's) is claimed, so no folder that carries it moves later.
 */
function writePairing(s: Survey, key: string, p: Pairing, now: number): HubRefusal | null {
  const target = targetOf(s, key)
  const previous =
    target.record?.install ?? (target.state === 'pending' ? target.manifest?.install : undefined)
  return change(s.root, (store) => {
    if (s.window.open && previous && previous !== p.install) claim(store, previous)
    store.pcs[key] = {
      pc: p.pc,
      tokenId: p.id,
      tokenHash: p.hash,
      ...(p.install ? { install: p.install } : {}),
      pairedAt: iso(now),
      pairedBy: p.by,
      ...(p.from ? { pairedFrom: p.from } : {}),
    }
  })
}

const badShape = (id: unknown, hash: unknown): boolean =>
  typeof id !== 'string' || !TOKEN_ID.test(id) || typeof hash !== 'string' || !TOKEN_HASH.test(hash)

export interface PcTokenRegistration {
  pc: string
  id: string
  hash: string
  /** Absent for a token from the command line: its first request with an install id binds it. */
  install?: string | null
  /** Replace a key that is in use; without it such a key is refused with name-paired. */
  replace?: boolean
}

export type PcRegistered = { ok: true; pc: string; key: string; id: string } | HubRefusal

/**
 * Registers a token the command line made (the admin API's `add`): its id and hash, under the name as typed. A key
 * in use is replaced only with `replace`; its relay closes, and a code the page made for it before is name-changed.
 */
export function registerPcToken(
  reg: PcTokenRegistration,
  root: string = CODEX_HUB_DIR,
  now: number = Date.now(),
): PcRegistered {
  const pc = typeof reg.pc === 'string' ? reg.pc.trim() : ''
  const key = pc.length <= 64 ? hubPcKey(pc) : null
  if (!key) return refuse(400, 'bad-request', 'pc is required, as a name of up to 64 characters')
  if (badShape(reg.id, reg.hash))
    return refuse(400, 'bad-request', 'id must be 16 hex and hash 64 hex')
  const s = survey(root, now)
  if (!s) return unreadable()
  const target = targetOf(s, key)
  if (inUse(target) && !reg.replace)
    return refuse(
      409,
      'name-paired',
      `${pc} is in use on this hub; replace it to give it a new token`,
    )
  if (idInUse(root, reg.id)) return refuse(409, 'id-taken', 'that token id is in use')
  const failed = writePairing(
    s,
    key,
    { pc, id: reg.id, hash: reg.hash, install: reg.install, by: 'cli' },
    now,
  )
  if (failed) return failed
  closeRelayUnless(key, reg.id, closeWhy(target.replaces))
  console.log(`[codex-hub] ${pc} was given a token on the command line (${tokenName(reg.id)})`)
  return { ok: true, pc, key, id: reg.id }
}

// --- pairing codes and confirmations (in memory) --------------------------------------------------

interface PairCodeEntry {
  root: string
  key: string
  pc: string
  replaces: string | null
  expiresAt: number
  redeemed?: { id: string; hash: string; install: string }
}

interface ConfirmEntry {
  root: string
  key: string
  state: string
  port: number
  replaces: string | null
  expiresAt: number
}

/** Both kept by the SHA-256 of what was handed out, never by the value itself. */
const codes = new Map<string, PairCodeEntry>()
const confirms = new Map<string, ConfirmEntry>()
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

function keep<T extends { expiresAt: number }>(map: Map<string, T>, value: T, now: number): string {
  for (const [k, v] of map) if (v.expiresAt <= now) map.delete(k)
  const secret = randomBytes(32).toString('hex')
  map.set(sha256(secret), value)
  while (map.size > PAIR_CODES_MAX) map.delete(map.keys().next().value!)
  return secret
}

const expiry = (now: number, until?: number | null): number =>
  Math.min(now + PAIR_CODE_MS, until ?? Number.POSITIVE_INFINITY)

/**
 * A one-time pairing code for key `key`, under the name `pc`, that may replace `replaces` and nothing else. It lasts
 * 20 minutes, and never past `until` (milliseconds: the tray's listener's end).
 */
export function mintPairCode(
  p: { key: string; pc: string; replaces: string | null; until?: number | null },
  root: string = CODEX_HUB_DIR,
  now: number = Date.now(),
): string {
  return keep(
    codes,
    { root, key: p.key, pc: p.pc, replaces: p.replaces, expiresAt: expiry(now, p.until) },
    now,
  )
}

/** A confirmation that the page's "replace" step hands itself: bound to the key, the tray's state and its port. */
export function mintConfirm(
  p: { key: string; state: string; port: number; replaces: string | null; until?: number | null },
  root: string = CODEX_HUB_DIR,
  now: number = Date.now(),
): string {
  return keep(
    confirms,
    {
      root,
      key: p.key,
      state: p.state,
      port: p.port,
      replaces: p.replaces,
      expiresAt: expiry(now, p.until),
    },
    now,
  )
}

/** Uses a confirmation up: what it was for, or null for one unknown, used, expired or made for another pairing. */
export function takeConfirm(
  confirm: string,
  p: { key: string; state: string; port: number },
  root: string = CODEX_HUB_DIR,
  now: number = Date.now(),
): { replaces: string | null } | null {
  const id = sha256(confirm)
  const entry = confirms.get(id)
  confirms.delete(id)
  if (
    !entry ||
    entry.root !== root ||
    entry.expiresAt <= now ||
    entry.key !== p.key ||
    entry.state !== p.state ||
    entry.port !== p.port
  )
    return null
  return { replaces: entry.replaces }
}

/** Drops every code and confirmation for key `key` (revoke, retire, forget). */
function dropPairing(key: string, root: string): void {
  for (const map of [codes, confirms] as Map<string, { root: string; key: string }>[])
    for (const [k, v] of map) if (v.root === root && v.key === key) map.delete(k)
}

export interface PairRedemption {
  code: string
  id: string
  hash: string
  /** The install id the tray sent; null for none, which is refused. */
  install: string | null
  /** The address the proxy said the request came from. */
  from?: string | null
}

export type PairAnswer = { ok: true; pc: string; key: string; id: string } | HubRefusal

const pairCodeRefused = (): HubRefusal =>
  refuse(401, 'pair-code', 'this pairing code is unknown, expired, or was used by another token')

/**
 * The tray redeems the page's code with its new token's id and hash, from its install id. Safe to repeat: the same
 * id, hash and install get the same answer until the code expires; anything else is refused.
 */
export function redeemPairCode(
  r: PairRedemption,
  root: string = CODEX_HUB_DIR,
  now: number = Date.now(),
): PairAnswer {
  if (typeof r.code !== 'string' || !PAIR_CODE.test(r.code) || badShape(r.id, r.hash))
    return refuse(400, 'bad-request', 'code must be 64 hex, id 16 hex and hash 64 hex')
  if (!r.install) return installRequired()
  const install = r.install
  if (!load(root).store) return unreadable()
  const hashed = sha256(r.code)
  const entry = codes.get(hashed)
  if (!entry || entry.root !== root || entry.expiresAt <= now) return pairCodeRefused()
  const s = survey(root, now)
  if (!s) return unreadable()
  if (entry.redeemed) {
    const { id, hash, install: redeemedBy } = entry.redeemed
    const record = s.store.pcs[entry.key]
    return id === r.id &&
      hash === r.hash &&
      redeemedBy === install &&
      record?.tokenId === id &&
      !record.revokedAt
      ? { ok: true, pc: entry.pc, key: entry.key, id }
      : pairCodeRefused()
  }
  const target = targetOf(s, entry.key)
  if (target.replaces !== entry.replaces) {
    codes.delete(hashed)
    return refuse(409, 'name-changed', `${entry.pc} changed on the hub since the page opened`)
  }
  // The code stays: the tray makes a new token and tries again.
  if (idInUse(root, r.id)) return refuse(409, 'id-taken', 'that token id is in use')
  const failed = writePairing(
    s,
    entry.key,
    { pc: entry.pc, id: r.id, hash: r.hash, install, by: 'page', from: r.from },
    now,
  )
  if (failed) return failed
  entry.redeemed = { id: r.id, hash: r.hash, install }
  closeRelayUnless(entry.key, r.id, closeWhy(entry.replaces))
  const replaced =
    entry.replaces === 'legacy'
      ? 'the old shared token'
      : entry.replaces
        ? tokenName(entry.replaces)
        : 'nothing'
  console.log(
    `[codex-hub] ${entry.pc} paired through the page (${tokenName(r.id)}; replaced ${replaced}` +
      `${r.from ? `; from ${r.from}` : ''})`,
  )
  return { ok: true, pc: entry.pc, key: entry.key, id: r.id }
}

// --- the exchange --------------------------------------------------------------------------------

export interface LegacyExchange {
  id: string
  hash: string
  /** The install id the tray sent; null for none, which is refused. */
  install: string | null
  from?: string | null
}

const PAIRED_BY: Record<PairedBy, string> = {
  page: 'the page',
  cli: 'the command line',
  exchange: 'an exchange',
}

/**
 * A pending PC's tray trades the legacy token for a token it made itself, once: the install id it sends finds the
 * key, and only the pending folder whose manifest carries that install id can move. A repeat with the same id, hash
 * and install gets the same answer. The caller has checked the legacy token and the window (routes/codex-hub.ts).
 */
export function exchangeLegacy(
  x: LegacyExchange,
  root: string = CODEX_HUB_DIR,
  now: number = Date.now(),
): PairAnswer {
  if (!x.install) return installRequired()
  const install = x.install
  if (badShape(x.id, x.hash)) return refuse(400, 'bad-request', 'id must be 16 hex and hash 64 hex')
  const s = survey(root, now)
  if (!s) return unreadable()
  const unauthorized = refuse(401, 'unauthorized', 'unauthorized')
  // A repeat after a lost answer. A record of another install's with this id is not one: that is id-taken below.
  const repeat = Object.entries(s.store.pcs).find(
    ([, r]) => r.tokenId === x.id && r.install === install,
  )
  if (repeat) {
    const [key, r] = repeat
    return r.tokenHash === x.hash && !r.revokedAt
      ? { ok: true, pc: r.pc, key, id: x.id }
      : unauthorized
  }
  const key = [...s.pending].find(([, m]) => m.install === install)?.[0]
  if (!key) {
    const moved = Object.entries(s.store.pcs).find(
      ([, r]) => r.install === install && r.tokenId && !r.revokedAt,
    )
    if (moved) {
      const [movedKey, r] = moved
      if (!r.contestedAt)
        change(root, (store) => {
          const it = store.pcs[movedKey]
          if (it && !it.contestedAt) it.contestedAt = iso(now)
        })
      console.warn(
        `[codex-hub] an exchange for ${r.pc}'s install arrived after ${r.pc} moved to ${tokenName(r.tokenId!)} ` +
          `(paired ${hubWhen(r.pairedAt)} by ${PAIRED_BY[r.pairedBy ?? 'page']}, from ${r.pairedFrom ?? 'an unknown address'}). ` +
          `If ${r.pc} did not send it, pair ${r.pc} again through the page and change the legacy token.`,
      )
    } else console.log(`[codex-hub] no PC is pending for install ${installName(install)}`)
    return unauthorized
  }
  if (idInUse(root, x.id)) return refuse(409, 'id-taken', 'that token id is in use')
  const manifest = s.pending.get(key)!
  const pc = manifest.pc || key
  const failed = writePairing(
    s,
    key,
    { pc, id: x.id, hash: x.hash, install: install, by: 'exchange', from: x.from },
    now,
  )
  if (failed) return failed
  closeRelayUnless(key, x.id, 'This PC moved to a token of its own.')
  const left = pendingKeys(root, now)
  console.log(
    `[codex-hub] ${pc} moved to a token of its own (${tokenName(x.id)}); ` +
      (left.length
        ? `${left.length} PC(s) still on the old shared token: ${left.join(', ')}`
        : 'every pending PC has a token of its own; remove AGENTHYDRA_CODEX_HUB_LEGACY_TOKEN and restart the hub'),
  )
  return { ok: true, pc, key, id: x.id }
}

// --- revoke, retire, forget ----------------------------------------------------------------------

const badKey = (key: string): HubRefusal | null =>
  isHubPcKey(key) ? null : refuse(400, 'bad-key', `${JSON.stringify(key)} is not a PC's key`)

export type PcRevoked =
  | { ok: true; pc: string; key: string; state: 'revoked'; relayClosed: boolean }
  | HubRefusal

/**
 * The owner revokes key `key`. A token is refused at once, and stays known so it answers `revoked`. A pending or
 * unpaired key gets a placeholder that claims its install id, so neither it nor a folder with that id can move.
 * Its relay closes and its codes go; no other PC is touched.
 */
export function revokePc(
  key: string,
  root: string = CODEX_HUB_DIR,
  now: number = Date.now(),
): PcRevoked {
  const bad = badKey(key)
  if (bad) return bad
  const s = survey(root, now)
  if (!s) return unreadable()
  const target = targetOf(s, key)
  if (target.state === 'free') return refuse(404, 'not-found', `no PC ${key} on this hub`)
  const pc = target.record?.pc ?? target.manifest?.pc ?? key
  if (target.state !== 'revoked') {
    const failed = change(root, (store) => {
      const record = store.pcs[key]
      if (record) {
        record.revokedAt = iso(now)
        record.revokedWhy = 'revoked by the owner'
        return
      }
      const install = hubInstallId(target.manifest?.install) ?? undefined
      store.pcs[key] = {
        pc,
        ...(install ? { install } : {}),
        revokedAt: iso(now),
        revokedWhy:
          target.state === 'pending'
            ? 'revoked by the owner before it moved'
            : 'revoked by the owner',
      }
    })
    if (failed) return failed
  }
  const relayClosed = closeRelayUnless(key, null, 'This PC was revoked on the hub.')
  dropPairing(key, root)
  console.log(`[codex-hub] ${pc} revoked`)
  return { ok: true, pc, key, state: 'revoked', relayClosed }
}

export type PcRetired = { ok: true; pc: string; key: string; state: 'revoked' } | HubRefusal

/**
 * A PC token retires itself, after its tray paired the PC again under a new name: only its own record, and only
 * while that record still has this token.
 */
export function retirePc(
  key: string,
  tokenId: string,
  renamedTo: string | null,
  root: string = CODEX_HUB_DIR,
  now: number = Date.now(),
): PcRetired {
  const { store } = load(root)
  if (!store) return unreadable()
  const record = store.pcs[key]
  if (!record || record.tokenId !== tokenId)
    return refuse(401, 'unknown-token', 'the hub does not know this PC token')
  if (record.revokedAt) return refuse(401, 'revoked', `${record.pc} was revoked on the hub`)
  const failed = change(root, (s) => {
    const r = s.pcs[key]!
    r.revokedAt = iso(now)
    r.revokedWhy = renamedTo ? `renamed to ${renamedTo}` : 'retired by the PC'
  })
  if (failed) return failed
  closeRelayUnless(
    key,
    null,
    renamedTo ? 'This PC was renamed on the hub.' : "This PC's token was retired.",
  )
  dropPairing(key, root)
  console.log(
    `[codex-hub] ${record.pc} retired its token${renamedTo ? ` (renamed to ${renamedTo})` : ''}`,
  )
  return { ok: true, pc: record.pc, key, state: 'revoked' }
}

export type PcForgotten = { ok: true; pc: string; key: string; removed: true } | HubRefusal

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The owner forgets key `key`: its record and its folder of copies go, its relay closes, its codes go. While the
 * window is open its install id is claimed, so no other folder that carries it can move.
 */
export function forgetPc(
  key: string,
  root: string = CODEX_HUB_DIR,
  now: number = Date.now(),
): PcForgotten {
  const bad = badKey(key)
  if (bad) return bad
  const s = survey(root, now)
  if (!s) return unreadable()
  const dir = join(root, key)
  const record = s.store.pcs[key]
  if (!record && !isDir(dir)) return refuse(404, 'not-found', `no PC ${key} on this hub`)
  const manifest = readCodexHubManifest(dir)
  const pc = record?.pc ?? manifest?.pc ?? key
  const install = record?.install ?? hubInstallId(manifest?.install) ?? undefined
  if (record || (s.window.open && install)) {
    const failed = change(root, (store) => {
      if (s.window.open) claim(store, install)
      delete store.pcs[key]
    })
    if (failed) return failed
  }
  closeRelayUnless(key, null, 'This PC was removed from the hub.')
  dropPairing(key, root)
  rmSync(dir, { recursive: true, force: true })
  console.log(`[codex-hub] ${pc} forgotten`)
  return { ok: true, pc, key, removed: true }
}

/**
 * Whether the credential a live relay link was let in with (relayPcToken) still holds: a token id the key's record
 * still has, unrevoked; or 'legacy' for a key still pending. Desk's end checks it before each session.
 */
export function linkCredentialValid(
  key: string,
  tokenId: string | undefined,
  root: string = CODEX_HUB_DIR,
  now: number = Date.now(),
): boolean {
  if (!tokenId) return false
  if (tokenId === 'legacy') return pendingKeys(root, now).includes(key)
  const record = load(root).store?.pcs[key]
  return !!record && record.tokenId === tokenId && !record.revokedAt
}

// --- the list ------------------------------------------------------------------------------------

export interface HubPcRow {
  key: string
  pc: string
  state: Exclude<HubPcState, 'free'>
  /** Unpaired only: why the key is not pending. */
  why?: string
  tokenId?: string
  pairedAt?: string
  pairedBy?: PairedBy
  pairedFrom?: string
  firstUsedAt?: string
  revokedAt?: string
  revokedWhy?: string
  contestedAt?: string
  /** The record's, else the manifest's. */
  install?: string
  /** The manifest's. */
  pushedAt?: string
  chats: number
  relay: boolean
}

export interface HubPcList {
  legacy: { open: boolean; since?: string; until?: string; pending: number }
  pcs: HubPcRow[]
}

/** Every key with a record or a folder, sorted by key, and the window. Null when the store cannot be read. */
export function hubPcRows(
  root: string = CODEX_HUB_DIR,
  now: number = Date.now(),
): HubPcList | null {
  const s = survey(root, now)
  if (!s) return null
  const live = relayPcs()
  const keys = [...new Set([...Object.keys(s.store.pcs), ...s.homes.keys()])].sort()
  const pcs = keys.map((key): HubPcRow => {
    const t = targetOf(s, key)
    const r = t.record
    const m = t.manifest
    const install = r?.install ?? hubInstallId(m?.install) ?? undefined
    const own = <K extends keyof HubPcRecord>(name: K) => (r?.[name] ? { [name]: r[name] } : {})
    return {
      key,
      pc: r?.pc ?? m?.pc ?? key,
      state: t.state as HubPcRow['state'],
      ...(t.why ? { why: t.why } : {}),
      ...own('tokenId'),
      ...own('pairedAt'),
      ...own('pairedBy'),
      ...own('pairedFrom'),
      ...own('firstUsedAt'),
      ...own('revokedAt'),
      ...own('revokedWhy'),
      ...own('contestedAt'),
      ...(install ? { install } : {}),
      ...(m ? { pushedAt: m.pushedAt } : {}),
      chats: m ? new Set(m.threads.map((th) => th.id)).size : 0,
      relay: live.has(key),
    }
  })
  const { open, since, until } = s.window
  return {
    legacy: {
      open,
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      pending: s.pending.size,
    },
    pcs,
  }
}

// --- the start log -------------------------------------------------------------------------------

const STUCK: Record<string, (m: HubManifest) => string> = {
  'no-install': () => 'no install id',
  old: (m) => `no push since ${hubWhen(m.pushedAt)}`,
  claimed: () => 'its install id has a token already',
}

/**
 * What the hub says at start about its PCs and the window (index.ts, once the hub is on). It writes
 * `legacy.since` when that is due; an unreadable store has been logged by then.
 */
export function logCodexHubStart(root: string = CODEX_HUB_DIR, now: number = Date.now()): void {
  const admin = codexHubToken()
  if (!admin) return
  const legacy = legacyToken()
  if (legacy && legacy === admin)
    console.error(
      '[codex-hub] AGENTHYDRA_CODEX_HUB_LEGACY_TOKEN is the admin token; it is ignored. Give ' +
        'AGENTHYDRA_CODEX_HUB_TOKEN a new value',
    )
  const s = survey(root, now)
  if (!s) return
  if (s.window.open) {
    const pending = [...s.pending].map(
      ([key, m]) => `${m.pc || key} (last push ${hubWhen(m.pushedAt)})`,
    )
    console.log(
      `[codex-hub] legacy window open until ${hubWhen(s.window.until)}: ${pending.length} PC(s) still on the ` +
        `old shared token${pending.length ? `: ${pending.join(', ')}` : ''}`,
    )
    const stuck = [...s.why]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, why]) => {
        const m = s.homes.get(key)!
        const what = why.startsWith('duplicate:')
          ? `same install as ${why.slice('duplicate:'.length)}`
          : STUCK[why]?.(m)
        return what ? `${key} (${what})` : null
      })
    const named = stuck.filter((x): x is string => !!x)
    if (named.length)
      console.log(
        `[codex-hub] ${named.length} folder(s) cannot move by themselves: ${named.join(', ')}: pair them ` +
          'through the page, or forget them',
      )
  } else if (legacy && legacy !== admin) {
    console.log(
      `[codex-hub] the legacy window closed on ${hubWhen(s.window.until)}; remove ` +
        'AGENTHYDRA_CODEX_HUB_LEGACY_TOKEN from hub.env',
    )
  } else if (!legacy) {
    const bare = [...s.homes.keys()].filter((key) => !s.store.pcs[key])
    if (bare.length)
      console.log(
        `[codex-hub] ${bare.length} PC folder(s) have no token of their own (${bare.join(', ')}): pair them, ` +
          'or see docs/CODEX-HUB.md "Moving PCs to tokens of their own"',
      )
  }
}
