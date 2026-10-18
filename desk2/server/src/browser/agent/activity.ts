// What the browser tools service last did with each profile folder, for the idle close that runs in Desk: the time of the
// last tool call against it and how many calls are running on it now. Only the service writes the file; Desk reads it.

import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface DirActivity {
  last: number
  busy: number
}

interface ActivityFile {
  pid: number
  dirs: Record<string, DirActivity>
}

const calls = new AsyncLocalStorage<Set<string>>()
const dirs = new Map<string, DirActivity>()
const CLOSING_MS = 60_000
let homeDir: string | null = null
let filePath: string | null = null

export const activityPath = (home: string): string => join(home, 'browser-agent', 'activity.json')
const closingPath = (home: string): string => join(home, 'browser-agent', 'closing.json')

export function setActivityHome(home: string): void {
  homeDir = home
  filePath = activityPath(home)
}

function flush(): void {
  if (!filePath) return
  mkdirSync(join(filePath, '..'), { recursive: true })
  const body: ActivityFile = { pid: process.pid, dirs: Object.fromEntries(dirs) }
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, JSON.stringify(body), 'utf8')
  renameSync(tmp, filePath)
}

function entry(dir: string): DirActivity {
  const key = resolve(dir)
  let row = dirs.get(key)
  if (!row) {
    row = { last: 0, busy: 0 }
    dirs.set(key, row)
  }
  return row
}

/** Runs one tool call; every profile it touches counts as busy until the call answers, and as used at that moment. */
export async function withCall<T>(run: () => Promise<T>): Promise<T> {
  const touched = new Set<string>()
  try {
    return await calls.run(touched, run)
  } finally {
    for (const dir of touched) {
      const row = entry(dir)
      row.busy = Math.max(0, row.busy - 1)
      row.last = Date.now()
    }
    if (touched.size > 0) flush()
  }
}

/** Marks a profile folder as used by the call in progress; outside a call it only stamps the time. */
export function noteUse(dir: string): void {
  const touched = calls.getStore()
  const row = entry(dir)
  row.last = Date.now()
  if (touched && !touched.has(resolve(dir))) {
    touched.add(resolve(dir))
    row.busy += 1
  }
  flush()
}

function readClosing(home: string): Record<string, number> {
  try {
    return (JSON.parse(readFileSync(closingPath(home), 'utf8')) as { dirs?: Record<string, number> }).dirs ?? {}
  } catch {
    return {}
  }
}

function writeClosing(home: string, marks: Record<string, number>): void {
  mkdirSync(join(home, 'browser-agent'), { recursive: true })
  const tmp = `${closingPath(home)}.tmp`
  writeFileSync(tmp, JSON.stringify({ dirs: marks }), 'utf8')
  renameSync(tmp, closingPath(home))
}

/** Desk marks a folder before it closes that folder's Chrome; a call that starts meanwhile waits for the close. */
export function markClosing(home: string, dir: string): void {
  const marks = readClosing(home)
  marks[resolve(dir)] = Date.now()
  writeClosing(home, marks)
}

export function clearClosing(home: string, dir: string): void {
  const marks = readClosing(home)
  delete marks[resolve(dir)]
  writeClosing(home, marks)
}

/** The service's side of the mark: waits while Desk is closing the folder's Chrome; a mark older than a minute is stale. */
export async function awaitNotClosing(dir: string): Promise<void> {
  const home = homeDir
  if (!home) return
  const key = resolve(dir)
  const closing = (): boolean => {
    const at = readClosing(home)[key]
    return typeof at === 'number' && Date.now() - at < CLOSING_MS
  }
  while (closing()) await new Promise((done) => setTimeout(done, 100))
}

/** Desk's view: the calls running on a folder count only while the service that wrote them is alive. */
export function readActivity(home: string): Map<string, DirActivity> {
  const out = new Map<string, DirActivity>()
  const path = activityPath(home)
  if (!existsSync(path)) return out
  let file: ActivityFile
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as ActivityFile
  } catch {
    return out
  }
  const alive = pidAlive(file.pid)
  for (const [dir, row] of Object.entries(file.dirs ?? {})) {
    out.set(resolve(dir), { last: Number(row.last) || 0, busy: alive ? Number(row.busy) || 0 : 0 })
  }
  return out
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
