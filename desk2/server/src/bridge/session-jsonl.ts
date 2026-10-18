// An outside Claude Code session's transcript read from its own .jsonl, in full fidelity. AgentHydra's
// tail endpoint flattens every text to one line (newlines, lists, headings and code fences gone), so for
// a Claude Code session Hydra Desk reads the file itself: read-only, only the tail, parsed by the same
// normalizer the live stream and history use. The tail endpoint stays the fallback when no file is found.
//
// WHERE THE FILES ARE (as AgentHydra's transcript index finds them, server/src/transcript.ts
// claudeStores): <config dir>/projects/<encoded cwd>/<session id>.jsonl, for the default login
// (~/.claude), every Claude Desktop instance (~/.claude-instances/<name>) and every CLI instance
// config folder AgentHydra lists. The encoded cwd is the folder with every character that is not a
// letter or digit turned into '-'.

import { existsSync, openSync, readdirSync, readSync, closeSync, statSync, type Stats } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@shared/protocol'
import { historyBuilder, historyToItems, parseJsonl, type HistoryOptions } from '../engine/normalize'
import { mediaCache } from '../media/cache'

/** How a session file's records become items: with the media cache, so a Read of a picture, a screenshot and the
 *  person's own pictures show (2026-10-14: without it every outside session's pictures were dropped). Measured on a
 *  session holding 15 in its tail: 57 ms the first time they are cached, then 7 ms against 5 to 9 without them. */
const history = (cwd?: string | null): HistoryOptions => ({ cwd: cwd ?? null, media: mediaCache() })

/** How much of a transcript's end is read: enough for a long session's recent turns. What is before it the window asks
 *  for on its own (sessionJsonlOlder): a 56 MB session showed only its last 8 MiB, none of the owner's messages
 *  (owner, 2026-10-11: "it won't let me scroll up to ... the top. It just stops"). */
export const TAIL_BYTES = 8 * 1024 * 1024

/** A session id that can only name a file in a projects folder: no dots, no separators. */
const SESSION_ID = /^[A-Za-z0-9_-]{6,80}$/

/** Claude Code's project folder name for a cwd. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** Every Claude-format projects folder on this machine that exists: the default login, Desktop instances, the given config dirs. */
export function claudeProjectRoots(configDirs: Iterable<string> = [], home = homedir()): string[] {
  const dirs = [join(home, '.claude')]
  const instances = join(home, '.claude-instances')
  try {
    for (const name of readdirSync(instances)) dirs.push(join(instances, name))
  } catch {
    // no Desktop instances on this machine
  }
  for (const d of configDirs) if (d) dirs.push(d)
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of dirs) {
    const root = join(d, 'projects')
    const key = root.toLowerCase()
    if (seen.has(key) || !existsSync(root)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

/** The session's .jsonl (the newest when it is in several folders), or null. Looks in the cwd's folder first. */
export function findSessionJsonl(sessionId: string, roots: string[], cwd?: string | null): string | null {
  if (!SESSION_ID.test(sessionId)) return null
  const file = `${sessionId}.jsonl`
  const hits: { path: string; mtime: number }[] = []
  const consider = (path: string) => {
    try {
      const st = statSync(path)
      if (st.isFile()) hits.push({ path, mtime: st.mtimeMs })
    } catch {
      // not here
    }
  }
  if (cwd) for (const root of roots) consider(join(root, encodeProjectDir(cwd), file))
  if (!hits.length) {
    for (const root of roots) {
      let projects: string[] = []
      try {
        projects = readdirSync(root)
      } catch {
        continue
      }
      for (const p of projects) consider(join(root, p, file))
    }
  }
  if (!hits.length) return null
  return hits.reduce((a, b) => (b.mtime > a.mtime ? b : a)).path
}

/** findSessionJsonl on the file thread pool: the same folders in the same order, the newest copy. */
export async function findSessionJsonlAsync(sessionId: string, roots: string[], cwd?: string | null): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null
  const file = `${sessionId}.jsonl`
  const consider = async (path: string) => {
    const st = await stat(path).catch(() => null)
    return st?.isFile() ? { path, mtime: st.mtimeMs } : null
  }
  const found = (list: ({ path: string; mtime: number } | null)[]) => list.filter((h): h is { path: string; mtime: number } => h !== null)
  let hits = cwd ? found(await Promise.all(roots.map((root) => consider(join(root, encodeProjectDir(cwd), file))))) : []
  if (!hits.length) {
    for (const root of roots) {
      const projects = await readdir(root).catch(() => [] as string[])
      hits.push(...found(await Promise.all(projects.map((p) => consider(join(root, p, file))))))
    }
  }
  if (!hits.length) return null
  return hits.reduce((a, b) => (b.mtime > a.mtime ? b : a)).path
}

/** The last `max` bytes of a file as text (the first line may be cut; parseJsonl skips it). */
export function readTail(path: string, max = TAIL_BYTES): string {
  const size = statSync(path).size
  const start = Math.max(0, size - max)
  const buf = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  try {
    let read = 0
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read)
      if (n <= 0) break
      read += n
    }
    return buf.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * The folder Claude Code says the session is in now: the `cwd` of the newest line that has one (every
 * transcript line carries it, and it follows the Bash tool's `cd`). Reads the file's end only; null when
 * no line in it has one.
 */
export function lastCwd(path: string): string | null {
  const size = statSync(path).size
  for (const max of [64 * 1024, TAIL_BYTES]) {
    const lines = readTail(path, max).split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (!line) continue
      try {
        const rec = JSON.parse(line) as { cwd?: unknown }
        if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd
      } catch {
        // the tail's first line may be cut
      }
    }
    if (size <= max) break
  }
  return null
}

/**
 * The tokens in context after the session's last reply: that call's prompt (input, cache read, cache write) and its
 * answer, from the newest main-thread assistant line with usage (a subagent's and a synthetic one are not the
 * session's). Claude Code's file never names the model's window, so there is no share of it. Null when none is in the
 * file's end.
 */
export function lastContextTokens(path: string): number | null {
  const size = statSync(path).size
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  for (const max of [256 * 1024, TAIL_BYTES]) {
    const lines = readTail(path, max).split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!
      if (!line.includes('"usage"')) continue
      try {
        const rec = JSON.parse(line) as { type?: unknown; isSidechain?: unknown; message?: { model?: unknown; usage?: Record<string, unknown> } }
        const u = rec.message?.usage
        if (rec.type !== 'assistant' || rec.isSidechain === true || rec.message?.model === '<synthetic>' || !u) continue
        const tokens = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens) + n(u.output_tokens)
        if (tokens > 0) return tokens
      } catch {
        // the tail's first line may be cut
      }
    }
    if (size <= max) break
  }
  return null
}

/**
 * The `cwd` of the first whole line written at or after byte `offset` that has one (reads at most 256 KB
 * from there): the folder the session was in when its next turn began. Null when no such line exists yet.
 */
export function firstCwdFrom(path: string, offset: number): string | null {
  const size = statSync(path).size
  if (offset >= size) return null
  const len = Math.min(size - offset, 256 * 1024)
  const buf = Buffer.alloc(len)
  const fd = openSync(path, 'r')
  let read = 0
  try {
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, offset + read)
      if (n <= 0) break
      read += n
    }
  } finally {
    closeSync(fd)
  }
  for (const raw of buf.subarray(0, read).toString('utf8').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const rec = JSON.parse(line) as { cwd?: unknown }
      if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd
    } catch {
      // a line still being written, or the offset fell mid-line
    }
  }
  return null
}

/** Source bytes of the lines parsed so far, by every reader (a test counts what a read did by the difference). */
export const sessionJsonlWork = { parsedBytes: 0 }

/** One session file as last read: the records of its complete lines, and where the next read starts. */
interface Memo {
  ino: number
  size: number
  mtimeMs: number
  /** Where the first unconsumed byte is: just after the last complete line read. */
  offset: number
  /** Where the first kept record begins: 0 when the items are the whole file, else what is before it is sessionJsonlOlder's. */
  start: number
  recs: { rec: unknown; bytes: number; uses?: string[]; mid?: string }[]
  /** Bytes the kept records took in the file. */
  bytes: number
  items: TranscriptItem[]
  /** The file's last FINGERPRINT bytes before `offset`: a file rewritten in place no longer has them there. */
  tail: Buffer
}
type Settled = Pick<Memo, 'ino' | 'size' | 'mtimeMs' | 'items' | 'bytes' | 'start'>
const FINGERPRINT = 64

/** The last FINGERPRINT bytes the file held before `start`; a short one goes on from the old tail. */
function fingerprintTail(buf: Buffer, start: number, prevTail: Buffer): Buffer {
  const seg = buf.subarray(Math.max(0, start - FINGERPRINT), start)
  const joined = seg.length >= FINGERPRINT ? seg : Buffer.concat([prevTail, seg])
  return Buffer.from(joined.subarray(Math.max(0, joined.length - FINGERPRINT)))
}

const unchanged = (m: Pick<Memo, 'ino' | 'size' | 'mtimeMs'>, st: { ino: number; size: number; mtimeMs: number }) =>
  m.size === st.size && m.mtimeMs === st.mtimeMs && m.ino === st.ino

/** A file call the reader's steps ask for: the sync read runs it in place, readAsync on the file thread pool. */
type Io = { op: 'stat'; path: string } | { op: 'read'; path: string; from: number; to: number }

const runSync = (io: Io): Stats | Buffer => (io.op === 'stat' ? statSync(io.path) : readFrom(io.path, io.from, io.to))

async function runAsync(io: Io): Promise<Stats | Buffer> {
  if (io.op === 'stat') return stat(io.path)
  const buf = Buffer.alloc(io.to - io.from)
  const fh = await open(io.path, 'r')
  try {
    let read = 0
    while (read < buf.length) {
      const { bytesRead } = await fh.read(buf, read, buf.length - read, io.from + read)
      if (bytesRead <= 0) break
      read += bytesRead
    }
    return buf.subarray(0, read)
  } finally {
    await fh.close()
  }
}

/** Reads [from, size) of a file. */
function readFrom(path: string, from: number, size: number): Buffer {
  const buf = Buffer.alloc(size - from)
  const fd = openSync(path, 'r')
  try {
    let read = 0
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, from + read)
      if (n <= 0) break
      read += n
    }
    return buf.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

export interface JsonlReaderOptions {
  /** How much of a file's end a first read takes. */
  tailBytes: number
  /** A first read that leaves out the file's start also answers the first user record in its first `headBytes`, the session's opening prompt. */
  headBytes?: number
  /** Source bytes of records kept per file between reads. Below `tailBytes` the reader is windowed (see createJsonlReader). */
  keepBytes: number
  /** A windowed reader may keep this much to hold the launch of a tool or task still running. */
  pinBytes?: number
  /** Files kept incremental, and the source bytes of their kept records. */
  maxFiles: number
  maxBytes: number
  /** Files pushed out of that: their stat and answer only, so an unchanged one costs a stat. */
  settledFiles: number
  settledBytes: number
}

/** The ids of the tool_use blocks a record holds and the API message it belongs to: what a window must not cut apart. */
function marks(rec: unknown): { uses?: string[]; mid?: string } {
  const msg = (rec as { type?: unknown; message?: { id?: unknown; content?: unknown } } | null)?.message
  if (!msg || (rec as { type?: unknown }).type !== 'assistant') return {}
  const out: { uses?: string[]; mid?: string } = {}
  if (typeof msg.id === 'string') out.mid = msg.id
  if (Array.isArray(msg.content)) {
    for (const b of msg.content as { type?: unknown; id?: unknown }[]) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') (out.uses ??= []).push(b.id)
    }
  }
  return out
}

/**
 * Drops the oldest records past `keep` bytes, and returns the bytes dropped. A cut falls where an API message
 * begins (its blocks are separate records and number their items by arrival), and not past the launch of a tool
 * or task the items show still running, since a result whose tool is gone is skipped by the normalizer and the
 * item would stay running; that holds only while the window is within `cap`, so a tool that never answers cannot
 * keep a file's whole history in memory.
 */
function trimWindow(m: Memo, items: TranscriptItem[], keep: number, cap: number): number {
  const open = new Set<string>()
  for (const it of items) {
    if (it.kind === 'tool_use' && it.status === 'running') open.add(it.id)
    else if (it.kind === 'task' && it.status === 'running' && it.toolUseId) open.add(it.toolUseId)
  }
  let pin = open.size ? m.recs.findIndex((r) => r.uses?.some((id) => open.has(id))) : -1
  if (pin < 0) pin = m.recs.length
  let dropped = 0
  while (m.recs.length > 1 && m.bytes > keep) {
    let j = 1
    while (j < m.recs.length && m.recs[j]!.mid !== undefined && m.recs[j]!.mid === m.recs[j - 1]!.mid) j++
    if (j >= m.recs.length) break
    if (j > pin && m.bytes <= cap) break
    for (const r of m.recs.splice(0, j)) {
      m.bytes -= r.bytes
      dropped += r.bytes
    }
    pin -= j
  }
  return dropped
}

/**
 * The first record a tail may begin at so that it reads the same alone as after what is before it, with no more than
 * `keep` of the `total` bytes from there on; -1 when none does. That is the start of an API message right after a record
 * of another kind: the message before it had every tool result back before it was asked (items number a message's
 * blocks by arrival, so a tail begun mid-message would name them differently), and an earlier message in the records
 * shows it is not the rest of one the cut fell in.
 */
function cleanCut(recs: Memo['recs'], total: number, keep: number): number {
  let lastMid: string | undefined
  for (let i = 0, before = 0; i < recs.length; before += recs[i]!.bytes, i++) {
    const mid = recs[i]!.mid
    if (mid === undefined) continue
    if (lastMid !== undefined && mid !== lastMid && recs[i - 1]!.mid === undefined && total - before <= keep) return i
    lastMid = mid
  }
  return -1
}

/** Drops the records before index `i`, and moves the start past them. */
function dropBefore(m: Memo, i: number): void {
  for (const r of m.recs.splice(0, i)) {
    m.bytes -= r.bytes
    m.start += r.bytes
  }
}

/**
 * A session file's items, read for as long as the file is polled. An open chat is polled every few seconds and a
 * running one grows all the time, so the file is read once and then only from where the last read stopped: the new
 * complete lines are parsed and added to the records kept, and the items are made from those. A file that shrank,
 * was replaced or was rewritten in place starts over; one that did not change costs a stat.
 *
 * With `keepBytes` below `tailBytes` the reader is WINDOWED: the first read still takes the whole tail and answers
 * every item in it, once; afterwards only the newest `keepBytes` of records stay in memory, and what a later read
 * answers is the items of that window. That is for a caller that only adds what is new or changed to a store that
 * already holds the rest (the CliMayte chats' workers); an item that fell out of the window is simply not answered
 * again. A window never starts inside an API message, and keeps back to the launch of a tool or task still running
 * (up to `pinBytes`; a tool that long without an answer loses it, and its result is then skipped).
 */
export interface JsonlReader {
  (path: string, cwd?: string | null): TranscriptItem[]
  /** The same answer, parsed in slices that let the event loop run between them. */
  readAsync(path: string, cwd?: string | null): Promise<TranscriptItem[]>
  /** Where in the file the last answer for `path` begins: 0 for the whole file (or a file not read). */
  startOf(path: string): number
}

/** Lines parsed between two slices of an async read: about a few milliseconds of JSON.parse. */
const LINES_PER_SLICE = 100

/** The first user record that ends before `before` in `head`, as its items: a session's opening prompt. */
function openingItems(head: Buffer, before: number, cwd?: string | null): TranscriptItem[] {
  for (let s = 0, nl = head.indexOf(10); nl >= 0 && nl < before; s = nl + 1, nl = head.indexOf(10, s)) {
    const rec = parseJsonl(head.subarray(s, nl).toString('utf8'))[0] as { type?: unknown } | undefined
    if (rec?.type === 'user') return historyToItems([rec], history(cwd))
  }
  return []
}

export function createJsonlReader(o: JsonlReaderOptions): JsonlReader {
  const memo = new Map<string, Memo>()
  let memoBytes = 0
  const settled = new Map<string, Settled>()
  let settledBytes = 0
  const windowed = o.keepBytes < o.tailBytes
  const pinCap = o.pinBytes ?? o.keepBytes
  const reading = new Map<string, Promise<unknown>>()

  function unsettle(path: string): void {
    const kept = settled.get(path)
    if (!kept) return
    settled.delete(path)
    settledBytes -= kept.bytes
  }

  /** While memory is over its limits, the least recently read file moves to the settled set (answers kept, parse dropped). */
  function settleOverflow(): void {
    while (memo.size > 1 && (memo.size > o.maxFiles || memoBytes > o.maxBytes)) {
      const [old, out] = memo.entries().next().value!
      memo.delete(old)
      memoBytes -= out.bytes
      settled.set(old, { ino: out.ino, size: out.size, mtimeMs: out.mtimeMs, items: out.items, bytes: out.bytes, start: out.start })
      settledBytes += out.bytes
      while (settled.size > o.settledFiles || settledBytes > o.settledBytes) unsettle(settled.keys().next().value!)
    }
  }

  /**
   * The bytes after what the memo has read, when the bytes just before it are still the same: a file rewritten in
   * place to the same size or more is read from the start, not continued (null then).
   */
  function* readContinuation(path: string, m: Memo, st: Stats): Generator<Io | undefined, Buffer | null, Stats | Buffer | undefined> {
    const back = m.tail.length
    const read = (yield { op: 'read', path, from: m.offset - back, to: st.size }) as Buffer
    return read.length >= back && read.subarray(0, back).equals(m.tail) ? read.subarray(back) : null
  }

  /** Parses each complete line of `buf` from `start` into `fresh`; returns where the last complete line ends. */
  function* appendLines(fresh: Memo, buf: Buffer, start: number): Generator<Io | undefined, number, Stats | Buffer | undefined> {
    // Lines are cut on the bytes themselves, so the offset counts what the file holds even where a line is
    // not valid UTF-8 (decoded, such a byte would count as three).
    let parsed = 0
    for (let nl = buf.indexOf(10, start); nl >= 0; start = nl + 1, nl = buf.indexOf(10, start)) {
      if (++parsed % LINES_PER_SLICE === 0) yield
      const bytes = nl + 1 - start
      fresh.offset += bytes
      sessionJsonlWork.parsedBytes += bytes
      const recs = parseJsonl(buf.subarray(start, nl).toString('utf8'))
      if (!recs.length) continue
      fresh.recs.push({ rec: recs[0], bytes, ...marks(recs[0]) })
      fresh.bytes += bytes
    }
    return start
  }

  function* step(path: string, cwd?: string | null): Generator<Io | undefined, TranscriptItem[], Stats | Buffer | undefined> {
    const st = (yield { op: 'stat', path }) as Stats
    let m = memo.get(path)
    if (m && unchanged(m, st)) return m.items
    const kept = settled.get(path)
    if (kept && unchanged(kept, st)) {
      settled.delete(path)
      settled.set(path, kept)
      return kept.items
    }
    const counted = m?.bytes ?? 0
    if (m && (st.size < m.size || st.ino !== m.ino || st.mtimeMs < m.mtimeMs)) m = undefined
    let from = 0
    let buf: Buffer | null = null
    if (m) {
      buf = yield* readContinuation(path, m, st)
      if (buf) from = m.offset
      else m = undefined
    }
    let head: Buffer | null = null
    if (!buf) {
      from = Math.max(0, st.size - o.tailBytes)
      buf = (yield { op: 'read', path, from, to: st.size }) as Buffer
      if (o.headBytes && from > 0) head = (yield { op: 'read', path, from: 0, to: Math.min(o.headBytes, st.size) }) as Buffer
    }
    const prevTail = m?.tail ?? Buffer.alloc(0)
    let start = 0
    if (!m && from > 0) {
      // The read starts mid-file: its first line may be cut, so it is left out.
      const nl = buf.indexOf(10)
      start = nl < 0 ? buf.length : nl + 1
      from += start
    }
    const fresh: Memo = m ?? { ino: st.ino, size: 0, mtimeMs: 0, offset: from, start: from, recs: [], bytes: 0, items: [], tail: prevTail }
    start = yield* appendLines(fresh, buf, start)
    if (!windowed && !m && from > 0) {
      // A first read from inside the file begins at a clean cut, so what is before it reads the same on its own.
      const i = cleanCut(fresh.recs, fresh.bytes, Infinity)
      if (i > 0) dropBefore(fresh, i)
    }
    // The last line may still be being written: it counts when it already parses, but is read again next time.
    const unfinished = parseJsonl(buf.subarray(start).toString('utf8'))
    fresh.tail = fingerprintTail(buf, start, prevTail)
    fresh.size = st.size
    fresh.mtimeMs = st.mtimeMs
    fresh.ino = st.ino
    // A session that goes on growing keeps its start until it holds twice the tail, so the window's older part (asked for
    // once per start) stays good; then it moves on to a clean cut. Only with none in the newest tail is it cut anywhere.
    if (!windowed && fresh.bytes > 2 * o.tailBytes) {
      const i = cleanCut(fresh.recs, fresh.bytes, o.tailBytes)
      if (i > 0) dropBefore(fresh, i)
      else while (fresh.bytes > o.tailBytes && fresh.recs.length > 1) dropBefore(fresh, 1)
    }
    yield
    const opening = head ? openingItems(head, from, cwd) : []
    const answer = [...opening, ...historyToItems([...fresh.recs.map((r) => r.rec), ...unfinished], history(cwd))]
    fresh.items = answer
    if (windowed) {
      const dropped = trimWindow(fresh, answer, o.keepBytes, pinCap)
      // A first read dropped most of the tail: what is kept answers for the window alone, not the whole tail again.
      if (dropped > o.keepBytes) fresh.items = [...opening, ...historyToItems([...fresh.recs.map((r) => r.rec), ...unfinished], history(cwd))]
    }
    memo.delete(path)
    memo.set(path, fresh)
    memoBytes += fresh.bytes - counted
    unsettle(path)
    settleOverflow()
    return answer
  }

  const drive = (path: string, cwd?: string | null): TranscriptItem[] => {
    const g = step(path, cwd)
    let r = g.next()
    while (!r.done) r = g.next(r.value ? runSync(r.value) : undefined)
    return r.value
  }

  const readAsync = async (path: string, cwd?: string | null): Promise<TranscriptItem[]> => {
    for (let prev = reading.get(path); prev; prev = reading.get(path)) await prev.catch(() => undefined)
    const run = (async () => {
      const g = step(path, cwd)
      let r = g.next()
      while (!r.done) {
        const io = r.value
        if (io) r = g.next(await runAsync(io))
        else {
          await new Promise((done) => setImmediate(done))
          r = g.next()
        }
      }
      return r.value
    })()
    reading.set(path, run)
    try {
      return await run
    } finally {
      if (reading.get(path) === run) reading.delete(path)
    }
  }

  const startOf = (path: string): number => memo.get(path)?.start ?? settled.get(path)?.start ?? 0

  return Object.assign(drive, { readAsync, startOf })
}

const SETTLED = { settledFiles: 1024, settledBytes: 64 * 1024 * 1024 }

/**
 * The outside-session views' reader: the whole tail, kept in full, 8 files incremental. A CliMayte chat reads every
 * session it has had at each poll (one had 94, ten chats 136 files): with only 8 remembered, each poll re-parsed
 * them all, 0.6 to 1.6 s on the server's one thread, so those that settled keep their stat and answer.
 */
const readSession = createJsonlReader({ tailBytes: TAIL_BYTES, keepBytes: TAIL_BYTES, maxFiles: 8, maxBytes: Infinity, ...SETTLED })

export function sessionJsonlItems(path: string, cwd?: string | null): TranscriptItem[] {
  return readSession(path, cwd)
}

/** Where sessionJsonlItems' last answer for the file begins; what is before it is sessionJsonlOlder's. 0: the whole file,
 *  and also a file not read yet: ask it after sessionJsonlItems, or use sessionJsonlPage, which does both in order. */
export function sessionJsonlStart(path: string): number {
  return readSession.startOf(path)
}

/** A session file's last page and the byte it begins at (0: the whole file), read in the one order that answers right
 *  (2026-10-14: the core asked the start first, got 0 for every file, and offered no older page). */
export function sessionJsonlPage(path: string, cwd?: string | null): { items: TranscriptItem[]; start: number } {
  const items = readSession(path, cwd)
  return { items, start: readSession.startOf(path) }
}

/** Source bytes parsed between two yields of an older read, beside LINES_PER_SLICE: a transcript line can be megabytes. */
const SLICE_BYTES = 2 * 1024 * 1024
/** Older answers kept, by file and start: a reopened long session answers at once. Each is a whole session's items. */
const OLDER_KEPT = 2
const olderKept = new Map<string, TranscriptItem[]>()
const olderReading = new Map<string, Promise<TranscriptItem[]>>()

/**
 * The items of a session file from before byte `before` (sessionJsonlStart): the whole file is read through, so a tool or
 * task launched before the cut is settled by what came after it, less every item the records from `before` on make
 * themselves (those are sessionJsonlItems'). Parsed in slices that let the event loop run (a 56 MB session is 25,000
 * records), on the file thread pool. A file that only grows never changes before its cut, so the answer is kept.
 */
export async function sessionJsonlOlder(path: string, before: number, cwd?: string | null): Promise<TranscriptItem[]> {
  if (!(before > 0)) return []
  const st = await stat(path)
  const key = `${path}|${st.ino}|${before}|${cwd ?? ''}`
  const kept = olderKept.get(key)
  if (kept) return kept
  const running = olderReading.get(key)
  if (running) return running
  const read = (async () => {
    const buf = (await runAsync({ op: 'read', path, from: 0, to: st.size })) as Buffer
    const all = historyBuilder(history(cwd))
    const after = historyBuilder(history(cwd))
    let lines = 0
    let bytes = 0
    for (let start = 0; start < buf.length; ) {
      if (++lines >= LINES_PER_SLICE || bytes >= SLICE_BYTES) {
        lines = bytes = 0
        await new Promise((done) => setImmediate(done))
      }
      const nl = buf.indexOf(10, start)
      const end = nl < 0 ? buf.length : nl
      const text = buf.subarray(start, end).toString('utf8')
      for (const rec of parseJsonl(text)) all.add(rec)
      // Parsed again, not shared: each normalizer keeps what it is handed.
      if (start >= before) for (const rec of parseJsonl(text)) after.add(rec)
      bytes += end - start
      start = end + 1
    }
    const theirs = new Set(after.items().map((i) => i.id))
    return all.items().filter((i) => !theirs.has(i.id))
  })()
  olderReading.set(key, read)
  try {
    const items = await read
    olderKept.delete(key)
    olderKept.set(key, items)
    while (olderKept.size > OLDER_KEPT) olderKept.delete(olderKept.keys().next().value!)
    return items
  } finally {
    olderReading.delete(key)
  }
}

/**
 * The CliMayte workers' reader: a running worker grows its file between two polls and every running worker is
 * polled, so with 8 files remembered each poll of 10 to 30 workers parsed an 8 MiB tail apiece in one stretch,
 * while keeping 8 MiB of parsed records for each would take gigabytes of heap. The window is 1 MiB of records.
 */
export const workerJsonlItems = createJsonlReader({
  tailBytes: TAIL_BYTES,
  headBytes: 512 * 1024,
  keepBytes: 1024 * 1024,
  pinBytes: 4 * 1024 * 1024,
  maxFiles: 128,
  maxBytes: 64 * 1024 * 1024,
  ...SETTLED,
})
