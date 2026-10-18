// server/src/climayte-effort.ts — the effort CliMayte launched each session at, for the Sessions list.
//
// CliMayte sets `--effort` per attempt and records it on the attempt (`requested.effort`) next to the
// session the attempt ran in (`sessionId`): in `corch/workers.json` for work in flight and
// `corch/done/<id>.json` for finished work. That is the one place the effort of a session CliMayte
// started was written down by the thing that chose it, so the list asks it before any guess.
//
// The same files say which chat dispatched each task (`origin`), so the list's offload counts come
// from here too.
//
// Read-only and cheap: a finished worker's file never changes, so each is parsed once and re-read
// only when its mtime or size moves, and done/ is looked through again only when its own mtime
// moves; the whole map is rebuilt at most every TTL_MS. When done/ moves, only the names it did not
// list before are read; the files it already had are re-checked (one stat each) at most every
// VERIFY_MS. Both passes over done/ run off the thread (scanDoneOff), so a finished worker shows a
// build or two after it is filed; only workers.json is read on the thread.
import { readFileSync, statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { POINTER_DIR } from './instance'

const TTL_MS = 5_000
/** How stale a finished file's cached parse can be: a rewrite under the same name is seen within this. */
const VERIFY_MS = 60_000

interface FileRecord {
  mtimeMs: number
  size: number
  efforts: Array<[sessionId: string, effort: string]>
  /** (worker id, the chat session that dispatched it), for every worker a chat sent. */
  origins: Array<[workerId: string, sessionId: string]>
}

const LIVE = join(POINTER_DIR, 'corch', 'workers.json')
const DONE_DIR = join(POINTER_DIR, 'corch', 'done')
const files = new Map<string, FileRecord>()
/** done/'s mtime when its names were last listed (null before the first pass), when every file was last
 *  re-checked, and those paths. */
const done: { at: number | null; verified: number; paths: string[] } = {
  at: null,
  verified: Number.NEGATIVE_INFINITY,
  paths: [],
}
let built: { at: number; map: Map<string, string>; dispatched: Map<string, number> } | null = null

/** (session id, effort) for every attempt of these workers that was launched with an effort. A null
 *  `requested.effort` is "the CLI's default", which is not a recorded effort, so it adds nothing. */
function effortsOf(workers: unknown): FileRecord['efforts'] {
  const out: FileRecord['efforts'] = []
  if (!Array.isArray(workers)) return out
  for (const w of workers) {
    const attempts = (w as { attempts?: unknown })?.attempts
    if (!Array.isArray(attempts)) continue
    for (const a of attempts) {
      const sid = a?.sessionId
      const effort = a?.requested?.effort
      if (typeof sid === 'string' && sid && typeof effort === 'string' && effort)
        out.push([sid, effort])
    }
  }
  return out
}

function originsOf(workers: unknown): FileRecord['origins'] {
  const out: FileRecord['origins'] = []
  if (!Array.isArray(workers)) return out
  for (const w of workers) {
    const id = (w as { id?: unknown })?.id
    const o = (w as { origin?: { kind?: unknown; sessionId?: unknown } })?.origin
    if (
      typeof id === 'string' &&
      o?.kind === 'chat' &&
      typeof o.sessionId === 'string' &&
      o.sessionId
    )
      out.push([id, o.sessionId])
  }
  return out
}

function recordOf(
  parsed: { workers?: unknown } | null,
  st: { mtimeMs: number; size: number },
): FileRecord {
  // workers.json holds `{workers: [...]}`; a finished worker's file is the worker itself.
  const workers = Array.isArray(parsed?.workers) ? parsed.workers : [parsed]
  return {
    mtimeMs: st.mtimeMs,
    size: st.size,
    efforts: effortsOf(workers),
    origins: originsOf(workers),
  }
}

/** workers.json, on the thread: one file, and the work in flight must show at once. */
function readRecord(path: string): FileRecord | null {
  try {
    const st = statSync(path)
    const have = files.get(path)
    if (have && have.mtimeMs === st.mtimeMs && have.size === st.size) return have
    const rec = recordOf(JSON.parse(readFileSync(path, 'utf8')), st)
    files.set(path, rec)
    return rec
  } catch {
    return null // unreadable or half-written: skip it, the next scan reads it again
  }
}

async function readRecordOff(path: string): Promise<void> {
  try {
    const st = await stat(path)
    const have = files.get(path)
    if (have && have.mtimeMs === st.mtimeMs && have.size === st.size) return
    files.set(path, recordOf(JSON.parse(await readFile(path, 'utf8')), st))
  } catch {
    // unreadable or half-written: the next pass reads it again
  }
}

let scanning: Promise<void> | null = null

/**
 * List done/ and read the files the cache does not have, or (`full`) re-check every one, through the thread pool;
 * then drop the built map so the next build takes them in. 8,417 finished files were a statSync each on the
 * thread once a minute (a 1.2 s daemon stall under a session open, 2026-10-11). One pass at a time: a caller
 * that comes while one runs gets that one.
 */
function scanDoneOff(doneAt: number, full: boolean): Promise<void> {
  scanning ??= (async () => {
    let names: string[] = []
    try {
      names = (await readdir(DONE_DIR)).filter((name) => name.endsWith('.json'))
    } catch {
      // no finished work yet, or gone meanwhile
    }
    const paths = names.map((name) => join(DONE_DIR, name))
    const todo = full ? paths : paths.filter((path) => !files.has(path))
    for (let i = 0; i < todo.length; i += 64)
      await Promise.all(todo.slice(i, i + 64).map(readRecordOff))
    const keep = new Set(paths)
    for (const path of files.keys()) if (path !== LIVE && !keep.has(path)) files.delete(path)
    done.paths = paths
    done.at = doneAt
    if (full) done.verified = Date.now()
    built = null
  })().finally(() => {
    scanning = null
  })
  return scanning
}

/**
 * Start a pass over done/ when one is due. Answers it when the map misses finished workers until it lands
 * (done/ moved since its names were last listed, the first pass included); null when only the once-a-minute
 * re-check is due, which nobody need wait for.
 */
function refreshDone(now: number): Promise<void> | null {
  let doneAt = Number.NaN
  try {
    doneAt = statSync(DONE_DIR).mtimeMs
  } catch {
    // no finished work yet
  }
  // A finished worker's file is written by renaming a temporary file over it, and filed or removed
  // the same way, so the folder's own mtime moves with every change in it. While it stands still,
  // the names and parses from the last pass stand too: 3,800 files were a statSync each, every
  // build (2026-10-08, 13% of a 5.7 s daemon stall). Object.is: a done/ not made yet has not moved.
  const moved = done.at === null || !Object.is(doneAt, done.at)
  const full = now - done.verified >= VERIFY_MS
  if (!moved && !full) return null
  const run = scanDoneOff(doneAt, full)
  return moved ? run : null
}

/**
 * Wait, off the thread, until the lookups below have every finished worker done/ lists: the Sessions list and a
 * session's page call it before them, so the first list after a boot (or after a worker is filed) has them.
 * Twice at most: a pass already running may have listed done/ before its latest move.
 */
export async function climayteEffortReady(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const pending = refreshDone(Date.now())
    if (!pending) return
    await pending
  }
}

/** Session id -> the effort CliMayte launched it at. Empty when CliMayte has never run here. */
export function climayteEffortBySession(): Map<string, string> {
  return build().map
}

/** Chat session id -> how many CliMayte tasks that chat dispatched. */
export function climayteTasksBySession(): Map<string, number> {
  return build().dispatched
}

/** The maps from the cached parses and workers.json; done/ itself is only ever read by scanDoneOff. */
function build(): NonNullable<typeof built> {
  const now = Date.now()
  if (built && now - built.at < TTL_MS) return built
  void refreshDone(now)
  const map = new Map<string, string>()
  // By worker: a task finishing moves from workers.json to done/, and one read can catch it in both.
  const senders = new Map<string, string>()
  for (const rec of [readRecord(LIVE), ...done.paths.map((path) => files.get(path))]) {
    if (!rec) continue
    for (const [sid, effort] of rec.efforts) map.set(sid, effort)
    for (const [workerId, sid] of rec.origins) senders.set(workerId, sid)
  }
  const dispatched = new Map<string, number>()
  for (const sid of senders.values()) dispatched.set(sid, (dispatched.get(sid) ?? 0) + 1)
  built = { at: now, map, dispatched }
  return built
}
