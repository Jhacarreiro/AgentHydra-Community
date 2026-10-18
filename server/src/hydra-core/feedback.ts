import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CatalogEntry, MODES } from './catalog'
import { readLog } from './log'
import { coreDir } from './paths'

export interface EntryFeedback {
  /** Offers where a take is observable: a pointer line, a find or page result, a pick list. */
  offered: number
  /** Times its full text was pasted into a chat, where reading it is the use and no take follows. Not an offer. */
  pasted?: number
  taken: number
  rejected: number
  reported: number
}

export interface Feedback {
  at: string
  since: string
  /** The catalog-wide take rate: every take over every offer. */
  base: number
  entries: Record<string, EntryFeedback>
}

export const FOLD_DAYS = 90
const DAY = 24 * 60 * 60 * 1000
/** An entry's prior moves its score only after this many offers, so a new entry keeps a fair start. */
export const PRIOR_OFFERS = 10
/** Knowledge offered this often and never taken is no longer pasted into packs or per-message additions. */
export const STALE_OFFERS = 50
const ONE_ID = /^(?:person|instrument|worker|knowledge|skill):[a-z0-9][a-z0-9-]*$/

export const feedbackPath = (dir: string) => join(dir, 'catalog', 'feedback.json')
export const needsPath = (dir: string) => join(dir, 'catalog', 'feedback-needs.md')

type Ev = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** The ids a pick step's answer took from the list it was shown: numbers or ids. */
function picked(e: Ev): string[] {
  if (!/pick$/.test(str(e.step)) || !Array.isArray(e.shown)) return []
  const tokens = str(e.answer)
    .split(/[\s,]+/)
    .filter(Boolean)
  if (!tokens.every((t) => /^\d+$/.test(t) || ONE_ID.test(t))) return []
  const shown = e.shown as unknown[]
  return tokens
    .map((t) => (/^\d+$/.test(t) ? shown[Number(t) - 1] : t))
    .filter((id): id is string => typeof id === 'string' && ONE_ID.test(id))
}

interface Need {
  at: string
  kind: 'none' | 'missing'
  text: string
  need?: string
}

/** Per entry: offered (a pack or placement pointer, a find result, a run's shown list once), pasted (a pack or
 *  placement that pasted its full text; a line from before `pasted` was logged counts its knowledge and person ids
 *  as pasted), taken (a pick, a core_use), rejected (`more` and `none` misses), reported (score - 3 over reports
 *  whose run took it, minus 1 per overruled). */
export function foldEvents(events: Ev[]): {
  entries: Record<string, EntryFeedback>
  needs: Need[]
} {
  const entries: Record<string, EntryFeedback> = {}
  const of = (id: string) => {
    entries[id] ??= { offered: 0, pasted: 0, taken: 0, rejected: 0, reported: 0 }
    return entries[id]
  }
  const runOf = new Map<string, number>()
  const shownIn = new Map<string, Set<string>>()
  const takenIn = new Map<string, Set<string>>()
  const needs: Need[] = []
  const take = (chat: string, run: number | undefined, ids: string[]) => {
    for (const id of new Set(ids)) {
      of(id).taken++
      if (run === undefined) continue
      const key = `${chat}#${run}`
      const set = takenIn.get(key) ?? new Set<string>()
      set.add(id)
      takenIn.set(key, set)
    }
  }
  for (const e of events) {
    const chat = str(e.chat)
    const run = typeof e.run === 'number' ? e.run : undefined
    if (e.step === 'start' && run !== undefined) runOf.set(chat, run)
    if ((e.event === 'pack' || e.event === 'placement') && Array.isArray(e.ids)) {
      const pasted = Array.isArray(e.pasted) ? new Set(e.pasted) : null
      for (const id of new Set(e.ids))
        if (typeof id !== 'string') continue
        else if (pasted ? pasted.has(id) : /^(?:knowledge|person):/.test(id))
          of(id).pasted = (of(id).pasted ?? 0) + 1
        else of(id).offered++
    }
    if (e.event === 'find' && Array.isArray(e.ids))
      for (const id of new Set(e.ids)) if (typeof id === 'string') of(id).offered++
    if (Array.isArray(e.shown)) {
      const key = `${chat}#${run}`
      const seen = shownIn.get(key) ?? new Set<string>()
      shownIn.set(key, seen)
      for (const id of e.shown)
        if (typeof id === 'string' && !seen.has(id)) {
          seen.add(id)
          of(id).offered++
        }
      take(chat, run, picked(e))
    }
    if (typeof e.id === 'string' && (MODES as readonly unknown[]).includes(e.mode))
      take(chat, runOf.get(chat), [e.id])
    if (e.event === 'miss' && typeof e.id === 'string') {
      of(e.id).rejected++
      if (e.why === 'none' && str(e.better).trim())
        needs.push({ at: str(e.at), kind: 'none', text: str(e.better).trim(), need: str(e.need) })
    }
    if (e.event === 'report') {
      if (typeof e.score === 'number' && run !== undefined)
        for (const id of takenIn.get(`${chat}#${run}`) ?? []) of(id).reported += e.score - 3
      for (const id of Array.isArray(e.overruled) ? e.overruled : [])
        if (typeof id === 'string') of(id).reported--
      if (str(e.missing).trim())
        needs.push({ at: str(e.at), kind: 'missing', text: str(e.missing).trim() })
    }
  }
  return { entries, needs }
}

function needsText(needs: Need[]): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const n of [...needs].sort((a, b) => b.at.localeCompare(a.at))) {
    const key = `${n.kind}\n${n.text.toLowerCase().replace(/\s+/g, ' ')}`
    if (seen.has(key)) continue
    seen.add(key)
    const text = n.text.replace(/\s+/g, ' ')
    lines.push(`- ${n.at.slice(0, 10)} ${n.kind}: ${text}${n.need ? ` (asked: ${n.need})` : ''}`)
  }
  return [
    '# What the catalog lacked',
    '',
    'Folded from log.jsonl with feedback.json, newest first. `none`: what a chat asked for instead of the page it',
    'was shown. `missing`: what a run report said was lacking. Turn these into `when` keywords or new entries.',
    '',
    ...lines,
    '',
  ].join('\n')
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** Folds the last FOLD_DAYS of the log into catalog/feedback.json and catalog/feedback-needs.md. Never call it on
 *  a request path: it reads the whole window of the log. */
export function foldFeedback(dir: string, now = new Date()): Feedback {
  const since = new Date(now.getTime() - FOLD_DAYS * DAY)
  const { entries, needs } = foldEvents(readLog(dir, since).events)
  let offered = 0
  let taken = 0
  for (const f of Object.values(entries)) {
    offered += f.offered
    taken += f.taken
  }
  const fb: Feedback = {
    at: now.toISOString(),
    since: since.toISOString(),
    base: offered ? taken / offered : 0,
    entries,
  }
  mkdirSync(join(dir, 'catalog'), { recursive: true })
  writeAtomic(feedbackPath(dir), JSON.stringify(fb))
  writeAtomic(needsPath(dir), needsText(needs))
  return fb
}

/** Folds when feedback.json is missing or older than a day; true when it folded. */
export function foldIfDue(dir: string, now = new Date()): boolean {
  let mtime = 0
  try {
    mtime = statSync(feedbackPath(dir)).mtimeMs
  } catch {}
  if (mtime && now.getTime() - mtime < DAY) return false
  foldFeedback(dir, now)
  return true
}

const cache = new Map<string, { mtime: number; fb: Feedback | null }>()

/** The last fold, cached by the file's mtime; null when there is none or it is unreadable. */
export function readFeedback(dir: string): Feedback | null {
  const file = feedbackPath(dir)
  let mtime: number
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    cache.delete(file)
    return null
  }
  const hit = cache.get(file)
  if (hit && hit.mtime === mtime) return hit.fb
  let fb: Feedback | null = null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Feedback>
    if (raw && typeof raw.base === 'number' && raw.entries && typeof raw.entries === 'object')
      fb = raw as Feedback
  } catch {}
  cache.set(file, { mtime, fb })
  return fb
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** What feedback needs of an entry: its id, and what marks it exempt. */
export type Rated = Pick<CatalogEntry, 'id'> &
  Partial<Pick<CatalogEntry, 'kind' | 'folders' | 'pinned'>>

/** The owner's pinned rulings and folder rules: feedback never drops them, raises their bar or moves their score. */
export function exempt(e: Rated): boolean {
  return e.pinned === true || (e.kind === 'knowledge' && (e.folders?.length ?? 0) > 0)
}

/** The score multiplier an entry's record earns: a smoothed take rate against the catalog's, bounded to ±25%. */
export function priorOf(fb: Feedback | null, e: Rated): number {
  const f = fb?.entries[e.id]
  if (!fb || !f || f.offered < PRIOR_OFFERS || exempt(e)) return 1
  return 1 + 0.5 * clamp((f.taken + 1) / (f.offered + 2) - fb.base, -0.5, 0.5)
}

/** Offered STALE_OFFERS times or more and never taken. */
export function stale(fb: Feedback | null, e: Rated): boolean {
  const f = fb?.entries[e.id]
  return !!f && !exempt(e) && f.offered >= STALE_OFFERS && f.taken === 0
}

/** Rejected more often than taken. */
export function doubted(fb: Feedback | null, e: Rated): boolean {
  const f = fb?.entries[e.id]
  return !!f && !exempt(e) && f.rejected > f.taken
}

export interface Mover extends EntryFeedback {
  id: string
  prior: number
}

/** The entries the prior moves most, up and down; `catalog` marks the exempt ones, which never move. */
export function movers(
  fb: Feedback | null,
  catalog: Map<string, CatalogEntry> = new Map(),
  n = 5,
): { at: string | null; up: Mover[]; down: Mover[] } {
  const all: Mover[] = Object.entries(fb?.entries ?? {})
    .map(([id, f]) => ({
      id,
      ...f,
      prior: Math.round(priorOf(fb, catalog.get(id) ?? { id }) * 1000) / 1000,
    }))
    .filter((m) => m.prior !== 1)
  return {
    at: fb?.at ?? null,
    up: all
      .filter((m) => m.prior > 1)
      .sort((a, b) => b.prior - a.prior || a.id.localeCompare(b.id))
      .slice(0, n),
    down: all
      .filter((m) => m.prior < 1)
      .sort((a, b) => a.prior - b.prior || a.id.localeCompare(b.id))
      .slice(0, n),
  }
}

let first: ReturnType<typeof setTimeout> | null = null
let every: ReturnType<typeof setInterval> | null = null

function foldQuietly(dir: string, force: boolean): void {
  try {
    if (force) foldFeedback(dir)
    else foldIfDue(dir)
  } catch (e) {
    console.warn(`[hydra-core] feedback fold failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** The daemon's fold: once just after start, then whenever feedback.json passes a day old (checked hourly). */
export function startFeedbackFold(dir = coreDir()): void {
  if (first || every) return
  first = setTimeout(() => foldQuietly(dir, true), 30_000)
  every = setInterval(
    () => {
      try {
        foldQuietly(dir, false)
      } catch {
        // the next hour tries again; a throw here would end the daemon
      }
    },
    60 * 60 * 1000,
  )
  first.unref?.()
  every.unref?.()
}

export function stopFeedbackFold(): void {
  if (first) clearTimeout(first)
  if (every) clearInterval(every)
  first = null
  every = null
}
