// server/src/climayte-log-archive.ts — log retention: the files in corch/logs/ of workers that
// finished more than `days` ago (setting climayte_log_archive_days, default 7) move into one tar per
// UTC day under corch/logs/archive/ (climayte-tar.ts). Nothing is deleted: a file leaves logs/ only
// once its bytes are synced into a whole archive entry, and the log readers (climayte-core.ts
// storedLog) fall through to the archive, so climayte_status { id }, the backfills and a revived
// worker's resume read an archived worker as before. The tick runs it hourly (archiveLogsWhenDue);
// GET/POST /api/corch/log-archive shows it, changes `days` and runs it now.
//
// WHY (2026-10-13): nothing pruned corch/logs. 47,188 files, 2.3 GB, 9,751 of them older than 7 days,
// and the owner's hygiene check flagged the folder (it lists it).
//
// Which archive: an attempt's files (its log, packed or not, its error log, runner leftovers) go to
// the day its attempt ended, which a reader knows from the attempt alone (archiveOfLog); a check log
// to the day the worker's last attempt ended; a file of no known worker to the day it was last
// written.

import type { Dirent } from 'node:fs'
import { type FileHandle, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  archiveDay,
  dayArchive,
  isActive,
  LOG_ARCHIVE,
  LOGS,
  load,
  workerIdOfLog,
  workers,
} from './climayte-core'
import type { CliMayteWorker } from './climayte-lib'
import { logSettled } from './climayte-storage'
import { appendTar, scanTar } from './climayte-tar'
import { fsSlot } from './core/fs-slots'
import { getSetting, setSetting } from './db'

const DAY_MS = 86_400_000

export const LOG_ARCHIVE_DAYS_SETTING = 'climayte_log_archive_days'

export const LOG_ARCHIVE_DAYS_DEFAULT = 7

/** The pass runs this often once nothing is left over; a minute after one that hit its byte cap. */
export const ARCHIVE_EVERY_MS = 60 * 60_000

/** One pass moves at most this much (whole workers); the rest goes a minute later. */
export const ARCHIVE_PASS_BYTES = 256 * 1024 * 1024

/** Files are read and appended this much at a time, each batch synced. */
const BATCH_BYTES = 32 * 1024 * 1024

/** How many days a finished worker's logs stay in logs/ (the setting; 7 when unset or not a whole
 *  number of days, at least 1). */
export function logArchiveDays(): number {
  const n = Number(getSetting(LOG_ARCHIVE_DAYS_SETTING))
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 3650) : LOG_ARCHIVE_DAYS_DEFAULT
}

export function setLogArchiveDays(days: number): number {
  setSetting(LOG_ARCHIVE_DAYS_SETTING, String(Math.min(Math.max(1, Math.floor(days)), 3650)))
  return logArchiveDays()
}

export interface LogArchivePass {
  /** When it ran (epoch ms) and the retention it ran with. */
  at: number
  days: number
  /** Workers whose files moved, and the files and bytes moved into `archives` (file names). */
  workers: number
  files: number
  bytes: number
  archives: string[]
  /** Files left in logs/ because their worker is active or finished inside the window. */
  kept: number
  /** Workers due that the byte cap left for the next pass. */
  left: number
  /** Files that could not be moved this time (changed while read, or held open): they stay. */
  failed: number
  ms: number
}

interface LogFile {
  name: string
  size: number
  mtimeMs: number
}

/** The newest end of `w`'s attempts, 0 with none. */
const lastEnd = (w: CliMayteWorker): number => Math.max(0, ...w.attempts.map((a) => a.endedAt ?? 0))

/** Whether a known worker is finished, every attempt's log settled, and nothing of it ended or ran
 *  after `cutoff` (its files' own times are checked after this). */
function finishedBefore(w: CliMayteWorker, cutoff: number): boolean {
  if (isActive(w) || w.checkRunner || w.staleChecks?.length) return false
  if (lastEnd(w) >= cutoff) return false
  return w.attempts.every((a) => logSettled(a) && !a.runner?.killOnStart)
}

/** The day archive a file of `w` (undefined: no known worker) goes to (see the header). */
function dayOf(w: CliMayteWorker | undefined, f: LogFile): string {
  if (!w) return archiveDay(f.mtimeMs)
  const at = w.attempts.find(
    (a) => f.name === basename(a.errLog) || f.name.startsWith(basename(a.log)),
  )
  return archiveDay(at?.endedAt ?? (lastEnd(w) || f.mtimeMs))
}

/** Each name's size and write time; a file gone meanwhile is left out. */
async function statAll(names: string[]): Promise<LogFile[]> {
  const out: LogFile[] = []
  for (const name of names) {
    try {
      const st = await fsSlot(() => stat(join(LOGS, name)))
      out.push({ name, size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      // packed or archived meanwhile
    }
  }
  return out
}

/** Open the archive for appending, made when there is none. */
async function openArchive(path: string): Promise<FileHandle> {
  try {
    return await fsSlot(() => open(path, 'r+'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return fsSlot(() => open(path, 'w+'))
  }
}

/** Append `files` to the day's archive, then remove from logs/ each one whose bytes it holds. */
async function archiveInto(day: string, files: LogFile[], pass: LogArchivePass): Promise<void> {
  const path = dayArchive(day)
  await fsSlot(() => mkdir(LOG_ARCHIVE, { recursive: true }))
  const file = await openArchive(path)
  const held: LogFile[] = []
  try {
    const idx = await scanTar(file)
    let batch: { name: string; data: Buffer; mtimeMs: number }[] = []
    let batchBytes = 0
    for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
      // An earlier pass wrote it and stopped before the remove.
      if (idx.entries.get(f.name)?.size === f.size) {
        held.push(f)
        continue
      }
      let data: Buffer
      try {
        data = await fsSlot(() => readFile(join(LOGS, f.name)))
      } catch {
        pass.failed++
        continue
      }
      if (data.length !== f.size) {
        pass.failed++
        continue
      }
      batch.push({ name: f.name, data, mtimeMs: f.mtimeMs })
      held.push(f)
      batchBytes += data.length
      if (batchBytes >= BATCH_BYTES) {
        await appendTar(file, idx, batch)
        batch = []
        batchBytes = 0
      }
    }
    if (batch.length) await appendTar(file, idx, batch)
  } finally {
    await file.close()
  }
  // Only now, with every byte synced into the archive, does a file leave logs/.
  for (const f of held)
    try {
      await fsSlot(() => rm(join(LOGS, f.name)))
      pass.files++
      pass.bytes += f.size
    } catch {
      // held open by another process: the next pass finds it archived and removes it then
      pass.failed++
    }
  pass.archives.push(basename(path))
}

/** One retention pass at `now`: every file in logs/ of a worker finished more than `days` ago moves
 *  into its day archive, at most `maxBytes` of them. */
export async function archiveOldLogs(
  opts: { now?: number; days?: number; maxBytes?: number } = {},
): Promise<LogArchivePass> {
  const started = Date.now()
  const now = opts.now ?? started
  const days = opts.days ?? logArchiveDays()
  const cutoff = now - days * DAY_MS
  const pass: LogArchivePass = {
    at: now,
    days,
    workers: 0,
    files: 0,
    bytes: 0,
    archives: [],
    kept: 0,
    left: 0,
    failed: 0,
    ms: 0,
  }
  // Which archive a file goes to comes from its worker's record, so with no record read nothing
  // moves: a store that did not load would file every log under the wrong day.
  load()
  if (workers.size === 0) {
    pass.ms = Date.now() - started
    return pass
  }
  let entries: Dirent[] = []
  try {
    entries = await fsSlot(() => readdir(LOGS, { withFileTypes: true }))
  } catch {
    // no logs yet
  }
  const byId = new Map<string, string[]>()
  for (const e of entries) {
    const id = e.isFile() ? workerIdOfLog(e.name) : null
    if (!id) continue
    const list = byId.get(id)
    if (list) list.push(e.name)
    else byId.set(id, [e.name])
  }
  const perDay = new Map<string, LogFile[]>()
  let room = opts.maxBytes ?? ARCHIVE_PASS_BYTES
  for (const [id, names] of byId) {
    const w = workers.get(id)
    // A known worker still running or recently finished keeps its files without a stat.
    if (w && !finishedBefore(w, cutoff)) {
      pass.kept += names.length
      continue
    }
    if (room <= 0) {
      pass.left++
      continue
    }
    const files = await statAll(names)
    // A file written inside the window (a check log, a revived worker's) keeps them all.
    if (files.some((f) => f.mtimeMs >= cutoff)) {
      pass.kept += names.length
      continue
    }
    pass.workers++
    for (const f of files) {
      room -= f.size
      const day = dayOf(w, f)
      const list = perDay.get(day)
      if (list) list.push(f)
      else perDay.set(day, [f])
    }
  }
  for (const [day, files] of [...perDay].sort(([a], [b]) => a.localeCompare(b)))
    try {
      await archiveInto(day, files, pass)
    } catch (err) {
      pass.failed += files.length
      console.error(`[climayte] could not archive logs into ${day}.tar:`, err)
    }
  pass.ms = Date.now() - started
  return pass
}

let running: Promise<LogArchivePass> | null = null
let nextAt = 0
let last: LogArchivePass | null = null

/** Run the pass now, or join the one running. */
export function runArchivePass(
  opts: Parameters<typeof archiveOldLogs>[0] = {},
): Promise<LogArchivePass> {
  if (running) return running
  running = archiveOldLogs(opts)
    .then((p) => {
      last = p
      nextAt = Date.now() + (p.left > 0 ? 60_000 : ARCHIVE_EVERY_MS)
      if (p.files || p.failed)
        console.log(
          `[climayte] log archive: ${p.files} files (${(p.bytes / 1e6).toFixed(1)} MB) of ${p.workers} workers finished over ${p.days} days ago into ${p.archives.join(', ') || 'no archive'}; ${p.kept} kept, ${p.failed} not moved, ${p.left} workers left for the next pass, ${p.ms} ms`,
        )
      return p
    })
    .catch((err) => {
      nextAt = Date.now() + ARCHIVE_EVERY_MS
      throw err
    })
    .finally(() => {
      running = null
    })
  return running
}

/** The tick's call: start the pass when it is due and none runs. */
export function archiveLogsWhenDue(now: number): void {
  if (running || now < nextAt) return
  runArchivePass().catch((err) => console.error('[climayte] the log archive pass failed:', err))
}

/** What GET /api/corch/log-archive shows. */
export function logArchiveStatus(): {
  days: number
  dir: string
  running: boolean
  nextAt: number | null
  last: LogArchivePass | null
} {
  return {
    days: logArchiveDays(),
    dir: LOG_ARCHIVE,
    running: running !== null,
    nextAt: nextAt || null,
    last,
  }
}
