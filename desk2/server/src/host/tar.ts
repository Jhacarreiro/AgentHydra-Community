// Reading npm tarballs (gunzipped tar streams): one file out of one (engine/claude-code-binary.ts, Claude Code's
// binary out of its platform package), or a whole package into a folder (host/sdk-package.ts, the Agent SDK a release
// fetches). Kept in host/ because chat-host.ts imports nothing outside this folder.

import { mkdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const TAR_BLOCK = 512
/** The longest pax or GNU long-name record read into memory. */
const MAX_TAR_META = 1 << 20

/** Reads a gunzipped tar stream: exact byte counts, and the rest of a body in chunks. */
class ByteReader {
  private readonly it: AsyncIterator<Uint8Array>
  private buf: Uint8Array = new Uint8Array(0)

  constructor(source: AsyncIterable<Uint8Array>) {
    this.it = source[Symbol.asyncIterator]()
  }

  private async fill(): Promise<boolean> {
    const r = await this.it.next()
    if (r.done) return false
    this.buf = this.buf.length ? Buffer.concat([this.buf, r.value]) : r.value
    return true
  }

  /** Exactly n bytes, or null when the stream ended before the first of them. */
  async take(n: number): Promise<Uint8Array | null> {
    while (this.buf.length < n) {
      if (!(await this.fill())) {
        if (this.buf.length === 0) return null
        throw new Error('the download ended inside a tar entry')
      }
    }
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }

  /** The next n bytes, handed on in chunks as they arrive. */
  async stream(n: number, onChunk: (chunk: Uint8Array) => Promise<void> | void): Promise<void> {
    let left = n
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.fill())) throw new Error('the download ended inside a tar entry')
      const take = Math.min(left, this.buf.length)
      const chunk = this.buf.subarray(0, take)
      this.buf = this.buf.subarray(take)
      left -= take
      await onChunk(chunk)
    }
  }

  skip(n: number): Promise<void> {
    return this.stream(n, () => {})
  }
}

function cString(block: Uint8Array, from: number, len: number): string {
  const end = block.indexOf(0, from)
  return Buffer.from(block.subarray(from, end === -1 || end > from + len ? from + len : end)).toString('utf8')
}

function octal(block: Uint8Array, from: number, len: number): number {
  // Sizes of 8 GB and more are stored base-256 (high bit set); a package this tool reads never has one.
  if (block[from]! & 0x80) throw new Error('tar entry too large')
  const text = cString(block, from, len).trim()
  return text ? Number.parseInt(text, 8) : 0
}

/** pax records: "<len> <key>=<value>\n", length counted in bytes, its own digits and newline included. */
function paxRecords(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>()
  const buf = Buffer.from(data)
  let at = 0
  while (at < buf.length) {
    const space = buf.indexOf(0x20, at)
    if (space === -1) break
    const len = Number.parseInt(buf.subarray(at, space).toString('ascii'), 10)
    if (!Number.isFinite(len) || len <= 0) break
    const record = buf.subarray(space + 1, at + len - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1))
    at += len
  }
  return out
}

/** A tar entry's name with Windows separators and a leading ./ normalized, so package\claude.exe matches too. */
function normalizeTarPath(name: string): string {
  return name.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
}

/** What the meta entries before a file say about it (GNU long name, pax), and the pax records for every file. */
interface TarMeta {
  longName: string | null
  pax: Map<string, string> | null
  globalPax: Map<string, string>
}

function readTarMeta(type: string, body: Uint8Array, meta: TarMeta): void {
  if (type === 'L') meta.longName = cString(body, 0, body.length)
  else if (type === 'x') meta.pax = paxRecords(body)
  else meta.globalPax = new Map([...meta.globalPax, ...paxRecords(body)])
}

/** The header's name field, under its ustar prefix when it has one. */
function headerName(header: Uint8Array): string {
  const name = cString(header, 0, 100)
  if (cString(header, 257, 5) !== 'ustar') return name
  const prefix = cString(header, 345, 155)
  return prefix ? `${prefix}/${name}` : name
}

/**
 * Streams the one file `wanted` out of a tar, calling `onFile` with a chunk writer; stops reading once it has it.
 * Understands the ustar prefix field, pax extended headers (path, size) and GNU long names. Returns false when the
 * archive has no such file.
 */
export async function untarFile(source: AsyncIterable<Uint8Array>, wanted: string, onFile: (chunk: Uint8Array) => Promise<void>): Promise<boolean> {
  const reader = new ByteReader(source)
  const meta: TarMeta = { longName: null, pax: null, globalPax: new Map() }
  for (;;) {
    const header = await reader.take(TAR_BLOCK)
    if (!header || header.every((b) => b === 0)) return false
    const type = String.fromCharCode(header[156]!)
    let size = octal(header, 124, 12)
    const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    if (type === 'x' || type === 'g' || type === 'L') {
      if (size > MAX_TAR_META) throw new Error('tar header too large')
      const data = (await reader.take(padded)) ?? new Uint8Array(0)
      readTarMeta(type, data.subarray(0, size), meta)
      continue
    }
    const path = meta.pax?.get('path') ?? meta.globalPax.get('path') ?? meta.longName ?? headerName(header)
    const paxSize = meta.pax?.get('size')
    if (paxSize) size = Number.parseInt(paxSize, 10)
    meta.longName = null
    meta.pax = null
    const dataLen = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    if ((type === '0' || type === '\0') && normalizeTarPath(path) === wanted) {
      await reader.stream(size, onFile)
      return true
    }
    await reader.skip(dataLen)
  }
}

/** The path an entry of an npm tarball has inside the package: its first folder (package/) taken off. */
function packagePath(name: string): string | null {
  const parts = normalizeTarPath(name).replace(/\/+$/, '').split('/')
  if (parts.length < 2) return null // the top folder itself
  const rest = parts.slice(1)
  if (rest.some((p) => p === '' || p === '.' || p === '..' || p.includes(':')) || name.startsWith('/'))
    throw new Error(`the archive holds an unsafe path: ${name}`)
  return rest.join('/')
}

/**
 * Unpacks a whole npm tarball into `dest`, its first folder (package/) taken off, and returns how many files it wrote.
 * Only files and folders: a link, a device or a path that climbs out of `dest` is refused, as is more than `maxBytes`
 * of content. A stream that ends inside an entry is an error, so a cut-off download never passes for a package.
 */
export async function untarPackage(source: AsyncIterable<Uint8Array>, dest: string, maxBytes = Number.POSITIVE_INFINITY): Promise<number> {
  const reader = new ByteReader(source)
  const meta: TarMeta = { longName: null, pax: null, globalPax: new Map() }
  let files = 0
  let total = 0
  for (;;) {
    const header = await reader.take(TAR_BLOCK)
    if (!header || header.every((b) => b === 0)) return files
    const type = String.fromCharCode(header[156]!)
    let size = octal(header, 124, 12)
    const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    if (type === 'x' || type === 'g' || type === 'L') {
      if (size > MAX_TAR_META) throw new Error('tar header too large')
      const data = (await reader.take(padded)) ?? new Uint8Array(0)
      readTarMeta(type, data.subarray(0, size), meta)
      continue
    }
    const name = meta.pax?.get('path') ?? meta.globalPax.get('path') ?? meta.longName ?? headerName(header)
    const paxSize = meta.pax?.get('size')
    if (paxSize) size = Number.parseInt(paxSize, 10)
    meta.longName = null
    meta.pax = null
    const dataLen = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    if (type === '5') {
      const rel = packagePath(name)
      if (rel) mkdirSync(join(dest, rel), { recursive: true })
      await reader.skip(dataLen)
      continue
    }
    if (type !== '0' && type !== '\0' && type !== '7') throw new Error(`the archive holds ${name}, which is not a file or a folder`)
    const rel = packagePath(name)
    if (!rel) throw new Error(`the archive holds a file with no name: ${name}`)
    total += size
    if (total > maxBytes) throw new Error(`the archive unpacks to more than ${Math.round(maxBytes / 1e6)} MB`)
    const file = join(dest, rel)
    mkdirSync(dirname(file), { recursive: true })
    const executable = (octal(header, 100, 8) & 0o111) !== 0
    const fh = await open(file, 'w', executable ? 0o755 : 0o644)
    try {
      await reader.stream(size, async (chunk) => {
        await fh.write(chunk)
      })
    } finally {
      await fh.close()
    }
    await reader.skip(dataLen - size)
    files++
  }
}
