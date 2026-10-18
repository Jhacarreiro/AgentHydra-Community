import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { logPath } from './paths'

const ROTATE_BYTES = 20 * 1024 * 1024
const ROTATED = /^log-(\d{4}-\d{2})(?:-(\d+))?\.jsonl$/

/** The month (YYYY-MM) of the log's first line, or null for an empty or unreadable one. */
function firstMonth(file: string): string | null {
  const buf = Buffer.alloc(64)
  const fd = openSync(file, 'r')
  try {
    const n = readSync(fd, buf, 0, buf.length, 0)
    return /"at":"(\d{4}-\d{2})/.exec(buf.toString('utf8', 0, n))?.[1] ?? null
  } finally {
    closeSync(fd)
  }
}

/** Moves log.jsonl to log-YYYY-MM.jsonl (its first line's month) when a new month starts or it passes 20 MB. */
function rotate(dir: string, now: Date): void {
  const file = logPath(dir)
  if (!existsSync(file)) return
  const size = statSync(file).size
  if (!size) return
  const month = firstMonth(file)
  if (!month || (month === now.toISOString().slice(0, 7) && size < ROTATE_BYTES)) return
  let target = join(dir, `log-${month}.jsonl`)
  for (let n = 2; existsSync(target); n++) target = join(dir, `log-${month}-${n}.jsonl`)
  renameSync(file, target)
}

export function appendLog(dir: string, event: Record<string, unknown>, now = new Date()): void {
  mkdirSync(dir, { recursive: true })
  try {
    rotate(dir, now)
  } catch {
    // Another process holds log.jsonl (Windows refuses the rename): the next append tries again.
  }
  appendFileSync(logPath(dir), `${JSON.stringify({ at: now.toISOString(), ...event })}\n`)
}

/** The month before an ISO timestamp's month: a rotation that was blocked files a new month's first lines under it. */
function monthBefore(iso: string): string {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - 1)
  return d.toISOString().slice(0, 7)
}

/** The log's events, oldest first; with `since`, the files from the month before it on and the lines at or after it. */
export function readLog(
  dir: string,
  since?: Date,
): { events: Record<string, unknown>[]; corrupt: number } {
  const events: Record<string, unknown>[] = []
  let corrupt = 0
  const from = since?.toISOString()
  const rotated = existsSync(dir)
    ? readdirSync(dir)
        .map((name) => {
          const m = ROTATED.exec(name)
          return { name, month: m?.[1], n: Number(m?.[2] ?? 1) }
        })
        .filter((f): f is { name: string; month: string; n: number } => Boolean(f.month))
        .filter((f) => !from || f.month >= monthBefore(from))
        .sort((a, b) => a.month.localeCompare(b.month) || a.n - b.n)
        .map((f) => join(dir, f.name))
    : []
  for (const file of [...rotated, logPath(dir)]) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as Record<string, unknown>
        if (!from || String(e.at ?? '') >= from) events.push(e)
      } catch {
        corrupt++
      }
    }
  }
  return { events, corrupt }
}

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1
}

export function statsOf(dir: string, since?: Date) {
  const { events, corrupt } = readLog(dir, since)
  const misses: Record<string, number> = {}
  const noneMisses: Record<string, number> = {}
  const overruled: Record<string, number> = {}
  const questions: Record<string, { asked: number; defaulted: number }> = {}
  const pushback: Record<string, number> = {}
  const finds = { total: 0, empty: 0 }
  const runs = new Set<string>()
  const reported = new Set<string>()
  let reports = 0
  for (const e of events) {
    const chat = typeof e.chat === 'string' ? e.chat : ''
    if (e.event === 'miss' && typeof e.id === 'string') {
      bump(misses, e.id)
      if (e.why === 'none') bump(noneMisses, e.id)
    }
    if (e.event === 'find') {
      finds.total++
      if (Array.isArray(e.ids) ? e.ids.length === 0 : e.empty === true) finds.empty++
    }
    if (e.event === 'president-block') bump(pushback, chat)
    if (e.step === 'start') runs.add(`${chat}#${e.run}`)
    else if (typeof e.step === 'string' && e.step !== 'end' && 'answer' in e) {
      const q = questions[e.step] ?? { asked: 0, defaulted: 0 }
      questions[e.step] = q
      q.asked++
      if (e.defaulted === true) q.defaulted++
    }
    if (e.event === 'report') {
      reports++
      if (typeof e.run === 'number') reported.add(`${chat}#${e.run}`)
      for (const id of (e.overruled as string[] | undefined) ?? []) bump(overruled, id)
    }
  }
  const done = [...runs].filter((k) => reported.has(k)).length
  return {
    misses,
    noneMisses,
    overruled,
    reports,
    reportRate: {
      runs: runs.size,
      reported: done,
      rate: runs.size ? Math.round((done / runs.size) * 1000) / 1000 : 0,
    },
    questions,
    pushback,
    finds,
    corrupt,
  }
}
