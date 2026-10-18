import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isPathInside, normalizeInstancePath } from './paths'

/** Where a paginated rollout's earlier rows live: the first `end_byte_offset` bytes of another
 * rollout of `thread_id`, whose last row there has ordinal `end_ordinal_exclusive - 1`. */
interface HistoryBase {
  thread_id: string
  end_ordinal_exclusive: number
  end_byte_offset: number
}

export interface CodexHistorySegment {
  path: string
  /** Bytes of this rollout the history uses: all of the newest, the boundary prefix of the rest. */
  bytes: number
  sha256: string
}

export interface CodexHistory {
  /** The chat's whole history as one self-contained rollout that needs no other file. */
  text: string
  /** Every rollout it was read from, oldest first; the last is the chat's own transcript. */
  segments: CodexHistorySegment[]
  /** Ordinal of the last row, so rows a copy gains later can be told from the copied history. */
  lastOrdinal: number
}

const MAX_SEGMENTS = 64

function firstRow(
  bytes: Buffer,
  path: string,
): { type?: string; payload?: Record<string, unknown> } {
  const end = bytes.indexOf(10)
  try {
    return JSON.parse(bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8'))
  } catch {
    throw new Error(`The transcript ${path} has no readable metadata.`)
  }
}

function historyBase(meta: { payload?: Record<string, unknown> }): HistoryBase | null {
  const base = meta.payload?.history_base as Partial<HistoryBase> | undefined
  if (!base) return null
  if (
    typeof base.thread_id !== 'string' ||
    !Number.isSafeInteger(base.end_ordinal_exclusive) ||
    !Number.isSafeInteger(base.end_byte_offset) ||
    base.end_byte_offset! <= 0
  )
    throw new Error('The transcript names an unreadable earlier history.')
  return base as HistoryBase
}

/** The row that ends exactly at `end`, or null when `end` is not a row boundary. */
function rowEndingAt(bytes: Buffer, end: number): { ordinal?: unknown } | null {
  if (end > bytes.length || bytes[end - 1] !== 10) return null
  const start = bytes.lastIndexOf(10, end - 2) + 1
  try {
    return JSON.parse(bytes.subarray(start, end - 1).toString('utf8'))
  } catch {
    return null
  }
}

function rollouts(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith('.jsonl'))
    .map((entry) => join(dir, entry))
}

/** The one rollout in this home that holds `base`: it belongs to the named thread and its bytes
 * end a row with the named ordinal exactly at the named offset. Names alone are not trusted: a
 * thread's own continuation shares its id, and Codex itself reports a cycle when two match. */
function findBase(codexHome: string, base: HistoryBase, seen: Set<string>): string {
  const home = realpathSync(codexHome)
  const matches = ['sessions', 'archived_sessions']
    .flatMap((dir) => rollouts(join(codexHome, dir)))
    .filter((path) => path.includes(base.thread_id) && !seen.has(normalizeInstancePath(path)))
    .filter((path) => {
      const bytes = readFileSync(path)
      const row = rowEndingAt(bytes, base.end_byte_offset)
      return (
        isPathInside(home, realpathSync(path)) &&
        firstRow(bytes, path).payload?.id === base.thread_id &&
        row?.ordinal === base.end_ordinal_exclusive - 1
      )
    })
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? 'More than one transcript matches this chat’s earlier history. Nothing was copied.'
        : 'The earlier history this chat continues is missing from its account. Nothing was copied.',
    )
  return matches[0]!
}

function rowsOf(text: string): string[] {
  return text.split('\n').filter((line) => line.trim())
}

/** Read a Codex chat's complete displayed history. A paginated rollout can continue an earlier
 * one (`history_base`), which another CODEX_HOME cannot resolve: copying only the newest file
 * imported 5 of 7 turns (2026-10-13), and current Codex refuses such a copy outright. The result
 * keeps the newest metadata at ordinal 0, without the link, followed by every earlier row up to
 * each boundary and then the newest rows, untouched; ordinals keep their gaps where the dropped
 * metadata rows stood, which Codex accepts (measured: 7 of 7 turns, 517 of 517 items). */
export function readCodexHistory(transcriptPath: string, codexHome: string): CodexHistory {
  const chain: { path: string; bytes: Buffer; used: number }[] = []
  const seen = new Set<string>()
  let path = transcriptPath
  let used: number | null = null
  for (;;) {
    const key = normalizeInstancePath(path)
    if (seen.has(key) || chain.length >= MAX_SEGMENTS)
      throw new Error('This chat’s earlier history loops back on itself. Nothing was copied.')
    seen.add(key)
    const bytes = readFileSync(path)
    chain.push({ path, bytes, used: used ?? bytes.length })
    const base = historyBase(firstRow(bytes, path))
    if (!base) break
    path = findBase(codexHome, base, seen)
    used = base.end_byte_offset
  }
  const segments = chain
    .map(({ path, bytes, used }) => ({
      path,
      bytes: used,
      sha256: createHash('sha256').update(bytes.subarray(0, used)).digest('hex'),
    }))
    .reverse()
  const newest = chain[0]!
  if (chain.length === 1) {
    const text = newest.bytes.toString('utf8')
    const last = rowsOf(text).at(-1)
    return { text, segments, lastOrdinal: last ? (JSON.parse(last).ordinal ?? -1) : -1 }
  }
  const meta = JSON.parse(rowsOf(newest.bytes.toString('utf8'))[0]!)
  meta.ordinal = 0
  delete meta.payload.history_base
  const rows = chain
    .slice()
    .reverse()
    .flatMap(({ bytes, used }) => rowsOf(bytes.subarray(0, used).toString('utf8')).slice(1))
  let previous = 0
  for (const row of rows) {
    const ordinal = JSON.parse(row).ordinal
    if (!Number.isSafeInteger(ordinal) || ordinal <= previous)
      throw new Error('This chat’s history rows are out of order. Nothing was copied.')
    previous = ordinal
  }
  return {
    text: `${[JSON.stringify(meta), ...rows].join('\n')}\n`,
    segments,
    lastOrdinal: previous,
  }
}

/** Bytes `start` to `end` of a file, fewer when it is shorter. */
async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const buf = Buffer.alloc(Math.max(0, end - start))
    const { bytesRead } = await file.read(buf, 0, buf.length, start)
    return buf.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

/** A file's first row, read in growing windows rather than whole. */
async function firstRowOf(path: string): Promise<{ payload?: Record<string, unknown> } | null> {
  for (let size = 64 * 1024; ; size *= 4) {
    const bytes = await readRange(path, 0, size)
    if (bytes.indexOf(10) >= 0 || bytes.length < size) return firstRow(bytes, path)
  }
}

/** The row that ends exactly at `end` in a file, read back in growing windows; null when `end` is not a row boundary. */
async function rowEndingAtFile(path: string, end: number): Promise<{ ordinal?: unknown } | null> {
  for (let size = 64 * 1024; ; size *= 4) {
    const start = Math.max(0, end - size)
    const bytes = await readRange(path, start, end)
    if (bytes.length !== end - start) return null
    if (bytes.lastIndexOf(10, bytes.length - 2) >= 0 || start === 0)
      return rowEndingAt(bytes, bytes.length)
  }
}

/** The CODEX_HOME a rollout sits in: everything before its `sessions` or `archived_sessions` folder. */
function codexHomeOf(path: string): string | null {
  const norm = path.replaceAll('\\', '/')
  const at = Math.max(norm.lastIndexOf('/sessions/'), norm.lastIndexOf('/archived_sessions/'))
  return at > 0 ? path.slice(0, at) : null
}

/** Where each earlier history was found, so a chat's poll scans its account's folders once, not every 4 s. */
const baseFound = new Map<string, string>()

/** findBase for the tail: the same checks, by windows, and null rather than an error when it is not there. */
async function findBaseAsync(
  codexHome: string,
  base: HistoryBase,
  seen: Set<string>,
): Promise<string | null> {
  const key = `${normalizeInstancePath(codexHome)}|${base.thread_id}|${base.end_byte_offset}`
  const holds = async (path: string): Promise<boolean> => {
    try {
      const [home, real] = await Promise.all([realpath(codexHome), realpath(path)])
      return (
        isPathInside(home, real) &&
        (await firstRowOf(path))?.payload?.id === base.thread_id &&
        (await rowEndingAtFile(path, base.end_byte_offset))?.ordinal ===
          base.end_ordinal_exclusive - 1
      )
    } catch {
      return false
    }
  }
  const known = baseFound.get(key)
  if (known && !seen.has(normalizeInstancePath(known)) && (await holds(known))) return known
  baseFound.delete(key)
  const found: string[] = []
  for (const dir of ['sessions', 'archived_sessions']) {
    const root = join(codexHome, dir)
    const entries = await readdir(root, { recursive: true }).catch(() => [] as string[])
    for (const entry of entries.map(String))
      if (entry.endsWith('.jsonl') && entry.includes(base.thread_id)) {
        const path = join(root, entry)
        if (!seen.has(normalizeInstancePath(path)) && (await holds(path))) found.push(path)
      }
  }
  if (found.length !== 1) return null
  baseFound.set(key, found[0]!)
  return found[0]!
}

/** A Codex chat's rollouts, oldest first, each with the bytes of it its history uses: the boundary prefix of each
 *  earlier one, all of the newest. A missing or unreadable earlier history ends the chain where it stands. */
async function codexChain(transcriptPath: string): Promise<{ path: string; used: number }[]> {
  const chain = [{ path: transcriptPath, used: (await stat(transcriptPath)).size }]
  const seen = new Set([normalizeInstancePath(transcriptPath)])
  const home = codexHomeOf(transcriptPath)
  while (home && chain.length < MAX_SEGMENTS) {
    let base: HistoryBase | null
    try {
      base = historyBase((await firstRowOf(chain.at(-1)!.path)) ?? {})
    } catch {
      break
    }
    const earlier = base ? await findBaseAsync(home, base, seen) : null
    if (!base || !earlier) break
    seen.add(normalizeInstancePath(earlier))
    chain.push({ path: earlier, used: base.end_byte_offset })
  }
  return chain.reverse()
}

/**
 * Up to `maxBytes` of a Codex chat's history, ending at `before` (bytes from the start of the whole history; its end
 * when left out), for the tail an open chat polls and the pages above it. A paginated rollout (`history_base`) holds
 * only the rows since it continued an earlier one, so reading it alone showed a moved chat as its last few messages
 * (2026-10-13: 14 events of a 26-turn chat whose copy held all 2,382 items). `start` is where the text begins in that
 * history, 0 at its beginning; a window that would begin inside a row begins at the next one, so every line is whole.
 * Windows only, never whole files.
 */
export async function readCodexTail(
  transcriptPath: string,
  maxBytes: number,
  before?: number,
): Promise<{ text: string; start: number }> {
  const chain = await codexChain(transcriptPath)
  const total = chain.reduce((n, s) => n + s.used, 0)
  const end = Math.min(before ?? total, total)
  let start = Math.max(0, end - maxBytes)
  const parts: Buffer[] = []
  let at = 0
  for (const s of chain) {
    const from = Math.max(start, at)
    const to = Math.min(end, at + s.used)
    if (from < to) parts.push(await readRange(s.path, from - at, to - at))
    at += s.used
  }
  let bytes = Buffer.concat(parts)
  if (start > 0) {
    const nl = bytes.indexOf(10)
    // One row longer than the window: it is passed over, and the next page goes on above it.
    if (nl < 0) return { text: '', start }
    bytes = bytes.subarray(nl + 1)
    start += nl + 1
  }
  return { text: bytes.toString('utf8'), start }
}
