// server/src/climayte-tar.ts — the day archives the log retention pass writes (climayte-log-archive.ts):
// plain ustar files, so `tar -tf` / `tar -xf` (bsdtar ships with Windows 10+) open them without
// AgentHydra. Entries are only ever appended; a reader finds one by name through an index of the
// headers, kept per archive and extended when the file grows. No dependency: a header is 512 bytes.
//
// CRASH SAFETY. An append first cuts the file back to the end of its last whole entry (a pass that
// died mid-write left a partial one), then writes, then the end-of-archive blocks, then syncs. The
// pass removes a log only after that, so a crash at any point leaves every byte either in logs/ or
// in a whole entry here (twice at worst: the next pass sees the same name and size, and only removes).

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

const BLOCK = 512

/** Where one entry's bytes are in its archive. */
export interface TarEntry {
  offset: number
  size: number
}

/** An archive's entries by name (a later entry of the same name wins, as tar extracts), and where
 *  its last whole entry ends: the next append starts there. */
export interface TarIndex {
  entries: Map<string, TarEntry>
  end: number
}

/** The checksum of a header: its bytes summed with the checksum field read as spaces. */
function checksum(h: Buffer): number {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number)
  return sum
}

/** A NUL-padded octal field. */
function octal(h: Buffer, at: number, len: number, n: number): void {
  h.write(`${n.toString(8).padStart(len - 1, '0')}\0`, at, len, 'ascii')
}

/** The ustar header of a regular file. Names over 100 bytes are refused (the logs' are ~30). */
function tarHeader(name: string, size: number, mtimeMs: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar entry name too long: ${name}`)
  const h = Buffer.alloc(BLOCK)
  h.write(name, 0, 100, 'utf8')
  octal(h, 100, 8, 0o644)
  octal(h, 108, 8, 0)
  octal(h, 116, 8, 0)
  octal(h, 124, 12, size)
  octal(h, 136, 12, Math.max(0, Math.floor(mtimeMs / 1000)))
  h.write('0', 156, 1, 'ascii')
  h.write('ustar\u000000', 257, 8, 'binary')
  h.write(`${checksum(h).toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return h
}

/** Bytes after an entry's data up to the next block. */
const padOf = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK

/** One header read: the entry it starts, null at the end-of-archive block or past the last whole
 *  entry (a torn header, or data the file does not hold). */
function parseHeader(
  h: Buffer,
  offset: number,
  fileSize: number,
): { name: string; size: number } | null {
  if (h.length < BLOCK || h.every((b) => b === 0)) return null
  if (h.toString('ascii', 257, 262) !== 'ustar') return null
  const sum = Number.parseInt(h.toString('ascii', 148, 156).replace(/[\0 ]/g, ''), 8)
  if (sum !== checksum(h)) return null
  const size = Number.parseInt(h.toString('ascii', 124, 136).replace(/[\0 ]/g, ''), 8)
  if (!Number.isFinite(size) || offset + BLOCK + size > fileSize) return null
  const nul = h.indexOf(0)
  const name = h.toString('utf8', 0, nul >= 0 && nul < 100 ? nul : 100)
  return { name, size }
}

const step = (offset: number, size: number): number => offset + BLOCK + size + padOf(size)

/** The index of the archive open on `fd`, from `from` (an earlier index's `end`) on. */
export function scanTarSync(fd: number, from: TarIndex | null = null): TarIndex {
  const size = fstatSync(fd).size
  const idx: TarIndex = from
    ? { entries: new Map(from.entries), end: from.end }
    : { entries: new Map(), end: 0 }
  const h = Buffer.alloc(BLOCK)
  for (;;) {
    const n = idx.end + BLOCK <= size ? readSync(fd, h, 0, BLOCK, idx.end) : 0
    const e = n === BLOCK ? parseHeader(h, idx.end, size) : null
    if (!e) return idx
    idx.entries.set(e.name, { offset: idx.end + BLOCK, size: e.size })
    idx.end = step(idx.end, e.size)
  }
}

/** scanTarSync through a FileHandle, for the pass, which runs off the daemon's thread. */
export async function scanTar(file: FileHandle): Promise<TarIndex> {
  const size = (await file.stat()).size
  const idx: TarIndex = { entries: new Map(), end: 0 }
  const h = Buffer.alloc(BLOCK)
  for (;;) {
    const n = idx.end + BLOCK <= size ? (await file.read(h, 0, BLOCK, idx.end)).bytesRead : 0
    const e = n === BLOCK ? parseHeader(h, idx.end, size) : null
    if (!e) return idx
    idx.entries.set(e.name, { offset: idx.end + BLOCK, size: e.size })
    idx.end = step(idx.end, e.size)
  }
}

/** Append files to the archive open on `file` whose index is `idx`: everything past `idx.end` is cut
 *  first, then each entry, then the end-of-archive blocks, then a sync. `idx` is updated in place. */
export async function appendTar(
  file: FileHandle,
  idx: TarIndex,
  items: { name: string; data: Buffer; mtimeMs: number }[],
): Promise<void> {
  await file.truncate(idx.end)
  let at = idx.end
  for (const it of items) {
    const head = tarHeader(it.name, it.data.length, it.mtimeMs)
    const pad = Buffer.alloc(padOf(it.data.length))
    await file.write(Buffer.concat([head, it.data, pad]), 0, undefined, at)
    idx.entries.set(it.name, { offset: at + BLOCK, size: it.data.length })
    at = step(at, it.data.length)
  }
  idx.end = at
  await file.write(Buffer.alloc(2 * BLOCK), 0, undefined, at)
  await file.sync()
}

/** Indexes the readers built, by archive path, with the size and write time they were built at: a
 *  grown archive is scanned on from where the last scan ended. A day's index holds ~10k names, so
 *  only the newest few archives read stay (CACHED_ARCHIVES). */
const cached = new Map<string, { size: number; mtimeMs: number; idx: TarIndex }>()

const CACHED_ARCHIVES = 4

/** The bytes of entry `name` in the archive at `path`; null when there is no such archive or entry.
 *  Sync, like the log readers it serves. */
export function readTarEntry(path: string, name: string): Buffer | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const st = fstatSync(fd)
    let c = cached.get(path)
    if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) {
      // An archive only grows (appendTar cuts back to a whole entry first); a smaller one was
      // replaced, so it is read from the start.
      const from = c && c.size <= st.size ? c.idx : null
      c = { size: st.size, mtimeMs: st.mtimeMs, idx: scanTarSync(fd, from) }
    }
    cached.delete(path)
    cached.set(path, c)
    if (cached.size > CACHED_ARCHIVES) cached.delete(cached.keys().next().value as string)
    const e = c.idx.entries.get(name)
    if (!e) return null
    const buf = Buffer.alloc(e.size)
    readSync(fd, buf, 0, e.size, e.offset)
    return buf
  } finally {
    closeSync(fd)
  }
}
