import { Database } from 'bun:sqlite'
import { closeSync, mkdirSync, openSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Proof that no Codex process writes a thread while Hydra rewrites it. Release it in `finally`. */
export interface CodexWriterLock {
  release(): void
}

const GENERIC_READ_WRITE = 0xc0000000
const FILE_SHARE_READ_WRITE = 3 // never FILE_SHARE_DELETE: Codex's stale-lock sweep must not remove it under us
const OPEN_ALWAYS = 4
const FILE_ATTRIBUTE_NORMAL = 0x80
const LOCKFILE_EXCLUSIVE_FAIL_IMMEDIATELY = 3
const ERROR_SHARING_VIOLATION = 32
const ERROR_LOCK_VIOLATION = 33
const LOCK_EX_NB = 2 | 4

function windowsLock(path: string): CodexWriterLock | null {
  const { dlopen, FFIType, ptr } = createRequire(import.meta.url)(
    'bun:ffi',
  ) as typeof import('bun:ffi')
  const k = dlopen('kernel32.dll', {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.i64,
    },
    LockFileEx: {
      args: [FFIType.i64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    UnlockFileEx: {
      args: [FFIType.i64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  })
  const name = Buffer.from(`${path}\0`, 'utf16le')
  const handle = BigInt(
    k.symbols.CreateFileW(
      ptr(name),
      GENERIC_READ_WRITE,
      FILE_SHARE_READ_WRITE,
      null,
      OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
      null,
    ),
  )
  if (handle === -1n || handle === 0n) {
    const error = k.symbols.GetLastError()
    if (error === ERROR_SHARING_VIOLATION) return null
    throw new Error(`Could not open the Codex writer lock (Windows error ${error}).`)
  }
  // Codex locks the whole file (offset 0, length 2^64-1); any overlapping range conflicts.
  const overlapped = new Uint8Array(32)
  if (
    !k.symbols.LockFileEx(
      handle,
      LOCKFILE_EXCLUSIVE_FAIL_IMMEDIATELY,
      0,
      0xffffffff,
      0xffffffff,
      ptr(overlapped),
    )
  ) {
    const error = k.symbols.GetLastError()
    k.symbols.CloseHandle(handle)
    if (error === ERROR_LOCK_VIOLATION) return null
    throw new Error(`Could not take the Codex writer lock (Windows error ${error}).`)
  }
  let held = true
  return {
    release() {
      if (!held) return
      held = false
      k.symbols.UnlockFileEx(handle, 0, 0xffffffff, 0xffffffff, ptr(overlapped))
      k.symbols.CloseHandle(handle)
    },
  }
}

function posixLock(path: string): CodexWriterLock | null {
  const { dlopen, FFIType } = createRequire(import.meta.url)('bun:ffi') as typeof import('bun:ffi')
  const libc = dlopen(process.platform === 'darwin' ? 'libc.dylib' : 'libc.so.6', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  })
  const fd = openSync(path, 'a+')
  if (libc.symbols.flock(fd, LOCK_EX_NB) !== 0) {
    closeSync(fd)
    return null
  }
  let held = true
  return {
    release() {
      if (!held) return
      held = false
      closeSync(fd) // closing the descriptor drops its flock
    },
  }
}

/** Take the lock Codex holds while a process may write `threadId`: `thread-writer-locks/<id>.lock`,
 * locked exclusively from the moment an app-server loads the thread until about a minute after its
 * last client unsubscribes, or until the process exits (measured with Codex 0.162, 2026-10-13).
 * Null means a Codex process owns the thread now; a rewrite then would race its appends and its
 * history projection, which is how a repair once lost 72 rows of a running turn. */
export function holdCodexWriterLock(codexHome: string, threadId: string): CodexWriterLock | null {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error('Not a Codex thread id.')
  const dir = join(codexHome, 'thread-writer-locks')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${threadId}.lock`)
  return process.platform === 'win32' ? windowsLock(path) : posixLock(path)
}

const PROJECTION_TABLES = [
  'thread_items',
  'thread_turns',
  'thread_realtime_items',
  'thread_history_projection_state',
]
const REQUIRED_TABLES = new Set(['thread_items', 'thread_turns', 'thread_history_projection_state'])

/** Codex projects a transcript into `thread_history_<n>.sqlite` incrementally, remembering the byte
 * offset it reached; after a rewrite that offset points into the wrong row. Dropping the thread's
 * projection makes Codex rebuild it from the whole transcript on the next resume (measured). Call
 * only while holding the thread's writer lock. Returns the removed rows so the caller can keep them. */
export function resetCodexHistoryProjection(
  codexHome: string,
  threadId: string,
): Record<string, unknown[]> {
  const files = readdirSync(codexHome).filter((name) => /^thread_history_\d+\.sqlite$/.test(name))
  if (files.length === 0) return {}
  if (files.length > 1)
    throw new Error('This Codex account has more than one history database. Nothing was reset.')
  const db = new Database(join(codexHome, files[0]!))
  try {
    db.exec('PRAGMA busy_timeout = 10000')
    const tables = PROJECTION_TABLES.filter((table) =>
      db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .some((column) => column.name === 'thread_id'),
    )
    if ([...REQUIRED_TABLES].some((table) => !tables.includes(table)))
      throw new Error('This Codex history database has an unknown layout. Nothing was reset.')
    return db
      .transaction(() => {
        const removed: Record<string, unknown[]> = {}
        for (const table of tables) {
          removed[table] = db.query(`SELECT * FROM ${table} WHERE thread_id = ?`).all(threadId)
          db.query(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId)
        }
        return removed
      })
      .immediate()
  } finally {
    db.close()
  }
}
