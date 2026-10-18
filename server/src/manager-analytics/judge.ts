import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { findTranscript } from '../transcript'
import { type MergedTurn, mergeTurns } from './collect'
import { appendJsonl, managersDir, ROUTES_FILE, readJsonl, readState, TURNS_FILE } from './store'
import {
  type JudgeRecord,
  type LineRef,
  promptOf,
  readLinesFrom,
  type TranscriptEntry,
} from './turns'

export const CRITERIA = ['answered', 'lane', 'resultFirst', 'proof', 'delegated'] as const
export const DAILY_CAP = 300
export const BATCH_SIZE = 20
export const JUDGE_EVERY_MS = 10 * 60_000
const FIRST_JUDGE_MS = 5 * 60_000
const SETTLE_MS = 2 * 60_000
const PROMPT_CHARS = 1500
const REPLY_CHARS = 2500
const RUBRIC_CHARS = 3000
const WHY_CHARS = 200
const FREE_WAIT_LIMIT_MS = 15 * 60_000

export interface FreeAnswer {
  text: string
  model: string
}
export type AskFree = (prompt: string) => Promise<FreeAnswer>

export function judgedToday(rows: Array<Record<string, unknown>>, now: number): number {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return rows.filter((r) => r.type === 'judge' && Number(r.at) >= start.getTime()).length
}

export function selectTurns(
  all: Map<string, MergedTurn>,
  now: number,
  limit: number,
): MergedTurn[] {
  if (limit <= 0) return []
  return [...all.values()]
    .filter(
      (t) =>
        t.outcome === 'replied' &&
        (t.trigger === 'owner' || t.trigger === 'parent') &&
        t.judge === null &&
        t.end <= now - SETTLE_MS,
    )
    .sort((a, b) => b.end - a.end)
    .slice(0, limit)
}

function textOf(entry: TranscriptEntry): string {
  const content = entry.message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((b: { type?: string; text?: unknown }) =>
      b?.type === 'text' && typeof b.text === 'string' ? [b.text] : [],
    )
    .join('\n')
    .trim()
}

export interface Excerpt {
  prompt: string
  reply: string
}

/** The turn's start line (its prompt uuid) and the last assistant text before the next real prompt. */
export function excerptOf(lines: LineRef[], promptUuid: string): Excerpt | null {
  const start = lines.findIndex((l) => l.entry.uuid === promptUuid)
  if (start < 0) return null
  const first = promptOf(lines[start])
  if (!first) return null
  let reply = ''
  for (let i = start + 1; i < lines.length; i++) {
    if (promptOf(lines[i])) break
    const e = lines[i].entry
    if (e.type === 'assistant') {
      const t = textOf(e)
      if (t) reply = t
    }
  }
  return { prompt: first.text.slice(0, PROMPT_CHARS), reply: reply.slice(0, REPLY_CHARS) }
}

export function rubricSections(brief: string): string {
  const parts: string[] = []
  let buf: string[] = []
  let keep = false
  const flush = () => {
    if (keep && buf.length) parts.push(buf.join('\n').trim())
    buf = []
  }
  for (const line of brief.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      flush()
      keep = /own|employees|voice/i.test(line)
    }
    if (keep) buf.push(line)
  }
  flush()
  return parts.join('\n\n').slice(0, RUBRIC_CHARS)
}

export function facetNamesOf(persona: unknown): string[] {
  const playbook = (persona as { playbook?: unknown })?.playbook
  if (!Array.isArray(playbook)) return []
  return playbook.flatMap((p: { file?: unknown }) =>
    typeof p?.file === 'string' ? [basename(p.file)] : [],
  )
}

function readManagerFiles(slug: string): { rubric: string; facets: string[] } | null {
  const dir = join(managersDir(), slug)
  const briefPath = join(dir, 'brief.md')
  if (!existsSync(briefPath)) return null
  const personaPath = join(dir, 'persona.json')
  let facets: string[] = []
  if (existsSync(personaPath)) {
    try {
      facets = facetNamesOf(JSON.parse(readFileSync(personaPath, 'utf8')))
    } catch {
      facets = []
    }
  }
  return { rubric: rubricSections(readFileSync(briefPath, 'utf8')), facets }
}

function transcriptPaths(): Map<string, string> {
  const paths = new Map<string, string>()
  for (const r of readJsonl<{ session: string; transcriptPath?: string | null }>(ROUTES_FILE))
    if (r.transcriptPath) paths.set(r.session, r.transcriptPath)
  const state = readState()
  for (const [session, t] of Object.entries(state.transcripts))
    if (!paths.has(session) && t.path) paths.set(session, t.path)
  return paths
}

function resolvePath(session: string, paths: Map<string, string>): string | null {
  const known = paths.get(session)
  if (known && existsSync(known)) return known
  return findTranscript(session)?.path ?? null
}

export function buildPrompt(
  slug: string,
  rubric: string,
  facets: string[],
  items: Array<{ n: number; excerpt: Excerpt; turn: MergedTurn }>,
): string {
  const turns = items.map(({ n, excerpt, turn }) => {
    const tools = Object.entries(turn.tools)
      .map(([name, count]) => `${name} x${count}`)
      .join(', ')
    return [
      `### Turn ${n}`,
      `Prompt:`,
      excerpt.prompt,
      `Final reply:`,
      excerpt.reply || '(no text)',
      `Tools: ${tools || 'none'}`,
      `Sub-managers opened: ${turn.sub.opened.length}. Workers dispatched: ${turn.workers.length}.`,
    ].join('\n')
  })
  return [
    `You score replies from the Manager Hydra manager "${slug}". Score each turn on five criteria, 0 to 2 each:`,
    `answered: it answered the ask. lane: it stayed in its own lane and handed the other fields to the named manager.`,
    `resultFirst: the result came first. proof: it gave proof. delegated: it handed the work to its employees instead of doing it itself.`,
    '',
    `The manager's own brief (its rubric):`,
    rubric || '(no brief sections found)',
    '',
    `Its playbook facet files: ${facets.length ? facets.join(', ') : '(none)'}.`,
    'For each turn give the one facet file the turn falls under, or null.',
    '',
    'Reply with a JSON array only, no prose:',
    `[{"n":1,"answered":0,"lane":0,"resultFirst":0,"proof":0,"delegated":0,"facet":null,"why":"one line, max 200 characters"}]`,
    '',
    ...turns,
  ].join('\n')
}

interface ParsedItem {
  n: number
  criteria: Record<string, number>
  facet: string | null
  facetDropped?: string
  why: string
}

/** The playbook file a judge's facet answer names: the file itself, the file without .md, or its unique number ("06"). */
export function matchFacet(answer: string, facets: string[]): string | null {
  const name = basename(answer.trim())
  if (facets.includes(name)) return name
  if (facets.includes(`${name}.md`)) return `${name}.md`
  const num = /^(\d{1,2})(?:\D|$)/.exec(name)?.[1]
  if (!num) return null
  const hits = facets.filter((f) => f.startsWith(`${num.padStart(2, '0')}-`))
  return hits.length === 1 ? hits[0] : null
}

function arrayAt(text: string, start: number): unknown[] | null {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1))
          return Array.isArray(v) ? v : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** The first JSON array in the reply that holds at least one object; fences and prose around it are ignored. */
export function firstJsonArray(text: string): unknown[] | null {
  for (let i = text.indexOf('['); i >= 0; i = text.indexOf('[', i + 1)) {
    const v = arrayAt(text, i)
    if (v?.some((x) => x !== null && typeof x === 'object')) return v
  }
  return null
}

export function parseJudgeReply(text: string, count: number, facets: string[]): ParsedItem[] {
  const raw = firstJsonArray(text)
  if (!raw) return []
  const out: ParsedItem[] = []
  const seen = new Set<number>()
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const n = Number(o.n)
    if (!Number.isInteger(n) || n < 1 || n > count || seen.has(n)) continue
    const criteria: Record<string, number> = {}
    let ok = true
    for (const key of CRITERIA) {
      const v = Number(o[key])
      if (!Number.isFinite(v)) {
        ok = false
        break
      }
      criteria[key] = Math.min(2, Math.max(0, Math.round(v)))
    }
    if (!ok) continue
    seen.add(n)
    const answer = typeof o.facet === 'string' && o.facet.trim() ? o.facet : null
    const facet = answer ? matchFacet(answer, facets) : null
    out.push({
      n,
      criteria,
      facet,
      ...(answer && !facet ? { facetDropped: answer.slice(0, WHY_CHARS) } : {}),
      why: typeof o.why === 'string' ? o.why.slice(0, WHY_CHARS) : '',
    })
  }
  return out
}

export async function askFree(prompt: string): Promise<FreeAnswer> {
  const { FREE_TOOLS } = await import('../mcp-free')
  const chat = FREE_TOOLS.find((t) => t.name === 'free_chat')
  const results = FREE_TOOLS.find((t) => t.name === 'free_results')
  if (!chat || !results) throw new Error('free_chat is not registered')
  type Task = { state: string; response?: string; model?: string; error?: string }
  type Snapshot = { batch: string; finished: boolean; tasks: Task[] }
  let snap = (await chat.run({
    tasks: [{ prompt, provider: 'claude', model: 'haiku' }],
    wait_s: 45,
  })) as Snapshot
  const deadline = Date.now() + FREE_WAIT_LIMIT_MS
  while (!snap.finished && Date.now() < deadline)
    snap = (await results.run({ batch: snap.batch, wait_s: 45 })) as Snapshot
  const task = snap.tasks[0]
  if (!snap.finished || task?.state !== 'done' || !task.response)
    throw new Error(task?.error ?? 'the Free answer did not finish')
  return { text: task.response, model: task.model ?? 'haiku' }
}

export interface JudgePassOptions {
  ask?: AskFree
  now?: number
  limit?: number
  dry?: boolean
}

export interface JudgePassResult {
  candidates: number
  batches: number
  written: JudgeRecord[]
  failed: Array<{ manager: string; error: string }>
}

export async function runJudgePass(opts: JudgePassOptions = {}): Promise<JudgePassResult> {
  const now = opts.now ?? Date.now()
  const ask = opts.ask ?? askFree
  const rows = readJsonl(TURNS_FILE)
  const all = mergeTurns(rows)
  const left = DAILY_CAP - judgedToday(rows, now)
  const picked = selectTurns(all, now, Math.min(left, opts.limit ?? Number.POSITIVE_INFINITY))
  const result: JudgePassResult = { candidates: picked.length, batches: 0, written: [], failed: [] }

  const byManager = new Map<string, MergedTurn[]>()
  for (const t of picked) {
    const list = byManager.get(t.manager) ?? []
    list.push(t)
    byManager.set(t.manager, list)
  }

  const paths = transcriptPaths()
  const lineCache = new Map<string, LineRef[]>()
  const linesOf = async (path: string): Promise<LineRef[]> => {
    const hit = lineCache.get(path)
    if (hit) return hit
    const { lines } = await readLinesFrom(path, 0)
    lineCache.set(path, lines)
    return lines
  }

  for (const [manager, turns] of byManager) {
    const files = readManagerFiles(manager)
    if (!files) {
      result.failed.push({ manager, error: 'no brief.md' })
      continue
    }
    const ready: Array<{ excerpt: Excerpt; turn: MergedTurn }> = []
    for (const turn of turns) {
      const sep = turn.id.indexOf(':')
      const promptUuid = turn.id.slice(sep + 1)
      const path = resolvePath(turn.session, paths)
      if (!path) continue
      const excerpt = excerptOf(await linesOf(path), promptUuid)
      if (excerpt) ready.push({ excerpt, turn })
    }
    for (let at = 0; at < ready.length; at += BATCH_SIZE) {
      const chunk = ready.slice(at, at + BATCH_SIZE).map((x, i) => ({ ...x, n: i + 1 }))
      result.batches++
      try {
        const answer = await ask(buildPrompt(manager, files.rubric, files.facets, chunk))
        const parsed = parseJudgeReply(answer.text, chunk.length, files.facets)
        if (parsed.length === 0) throw new Error('no judge rows in the reply')
        const model = `${answer.model} free`
        for (const p of parsed) {
          const turn = chunk[p.n - 1].turn
          const score = CRITERIA.reduce((sum, k) => sum + p.criteria[k], 0)
          result.written.push({
            v: 1,
            type: 'judge',
            turn: turn.id,
            score,
            criteria: p.criteria,
            facet: p.facet,
            ...(p.facetDropped ? { facetDropped: p.facetDropped } : {}),
            why: p.why,
            model,
            costUsd: 0,
            at: now,
          })
        }
      } catch (e) {
        const error = (e as Error).message
        console.error(`[manager-judge] ${manager} batch failed: ${error}`)
        result.failed.push({ manager, error })
      }
    }
  }

  if (!opts.dry) appendJsonl(TURNS_FILE, result.written)
  return result
}

let judging = false

/** Daemon timer: first pass 5 min after boot, then every 10 min; a pass still running is not overlapped. */
export function startManagerJudge(): void {
  const tick = async () => {
    if (judging) return
    judging = true
    try {
      await runJudgePass()
    } catch (e) {
      console.error(`[manager-judge] pass failed: ${(e as Error).message}`)
    } finally {
      judging = false
    }
  }
  setTimeout(() => {
    tick()
    setInterval(tick, JUDGE_EVERY_MS)
  }, FIRST_JUDGE_MS)
}
