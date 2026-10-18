// server/src/hydra-core/lead.ts - who a chat is told to be: one small model call through HSwarm's decide door picks
// the lead among the five managers (or none), and the word ranker answers when that call fails or runs out of time.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { contentWords } from '../mcp-find'
import { type CatalogEntry, LEAD_TIERS, loadRef, loadText } from './catalog'
import { type Feedback, readFeedback } from './feedback'
import { detailOf, rankEntries, terms } from './find'
import { emptyDoc, leadLine, parseHydra, renderHydra } from './hydra-md'
import { appendLog } from './log'
import { coreDir } from './paths'

/** A chat's first launch may wait this long for the model's pick. */
export const LAUNCH_BUDGET_MS = 5000
/** The hook gives the whole per-message request 1.5 s (hook.mjs PACK_TIMEOUT_MS); the call gets this much of it. */
export const MESSAGE_BUDGET_MS = 1000
/** A per-message shift check that misses MESSAGE_BUDGET_MS keeps asking this long in the background; under 3000 so
 *  it stays one ask. Live picks that missed 1 s came back in 1.0-1.6 s. */
export const LATE_BUDGET_MS = 2500
export const LEAD_MIN = 4
/** A lead-change note carries the new lead's brief whole up to this many characters. */
export const NOTE_CAP = 9500
const DECIDE_URL = 'http://127.0.0.1:7793/api/decide'
/** Jev and Clef answer nothing on this PC (2026-10-14: the TypeSafe key is disabled, no Cloudflare route), so the
 *  call goes straight to a fast fallback model: this one answered in 0.4-0.7 s. */
const DEFAULT_MODEL = 'cerebras-gpt-oss-120b'
/** One model answer varies run to run: with time for it (a launch), three asks at once and two agreeing measured
 *  steadier; inside the hook's budget one ask, since three at once come back slower. */
const votesFor = (budgetMs: number) => (budgetMs >= 3000 ? 3 : 1)

export interface LeadQuestion {
  message: string
  question: string
  options: Record<string, string>
}

export interface Decision {
  answer: string | null
  error?: string
}

export type Decider = (q: LeadQuestion, budgetMs: number) => Promise<Decision>

export interface LeadPick {
  id: string | null
  path: 'model' | 'words'
  ms: number
  error?: string
}

/**
 * The decide door. Asks votesFor(budgetMs) times at once and answers when a majority agrees, else with the most common
 * answer so far when every ask is back or the time is up. Awaited, never waited on synchronously: the daemon and the
 * Desk server keep serving while it runs.
 */
export async function hswarmDecide(q: LeadQuestion, budgetMs: number): Promise<Decision> {
  const model = process.env.AGENTHYDRA_LEAD_MODEL || DEFAULT_MODEL
  if (model === 'off') return { answer: null, error: 'AGENTHYDRA_LEAD_MODEL=off' }
  const tokenFile =
    process.env.AGENTHYDRA_HSWARM_TOKEN_FILE || join(homedir(), '.hswarm', 'console-token')
  let token: string
  try {
    token = readFileSync(tokenFile, 'utf8').trim()
  } catch (err) {
    return { answer: null, error: `no HSwarm token: ${err instanceof Error ? err.message : err}` }
  }
  const body = JSON.stringify({
    items: [
      {
        id: 'lead',
        state: { message: q.message },
        question: q.question,
        type: 'choice',
        options: q.options,
      },
    ],
    // Jev answers nothing here, so everything goes to the fallback model at once.
    escalate_below: 1.01,
    fallback_model: model,
  })
  const url = process.env.AGENTHYDRA_DECIDE_URL || DECIDE_URL
  const votes = votesFor(budgetMs)
  const abort = new AbortController()
  const got: string[] = []
  const errs: string[] = []
  return await new Promise<Decision>((resolve) => {
    let back = 0
    let over = false
    const done = (d: Decision) => {
      if (over) return
      over = true
      clearTimeout(timer)
      abort.abort()
      resolve(d)
    }
    const settle = (final: boolean) => {
      const n = new Map<string, number>()
      for (const a of got) n.set(a, (n.get(a) ?? 0) + 1)
      const best = [...n.entries()].sort((a, b) => b[1] - a[1])[0]
      if (best && (best[1] * 2 > votes || final)) done({ answer: best[0] })
      else if (final) done({ answer: null, error: errs[0] ?? 'no answer' })
    }
    const timer = setTimeout(() => settle(true), Math.max(100, budgetMs - 50))
    for (let i = 0; i < votes; i++)
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hswarm-token': token },
        body,
        signal: abort.signal,
      })
        .then(async (r) => {
          const j = (await r.json().catch(() => ({}))) as {
            answers?: { answer?: unknown; error?: unknown }[]
            error?: unknown
          }
          const a = j.answers?.[0]
          if (a?.answer != null) got.push(String(a.answer))
          else errs.push(String(a?.error ?? j.error ?? `HTTP ${r.status}`).slice(0, 200))
        })
        .catch((err) => errs.push(String(err instanceof Error ? err.message : err).slice(0, 200)))
        .finally(() => {
          back++
          settle(back === votes)
        })
  })
}

const CACHE_MAX = 100
/** Picks the model made, so a launch that builds its slot twice asks once; a failed call is asked again. */
const cache = new Map<string, LeadPick>()

const late = new Set<Promise<void>>()

/** Resolves once every late pick started so far has landed. */
export async function latePicks(): Promise<void> {
  while (late.size) await Promise.all([...late])
}

const noModel: Decider = async () => ({ answer: null, error: 'no model call under test' })
const defaultDecider = (): Decider => (process.env.NODE_ENV === 'test' ? noModel : hswarmDecide)
let decider: Decider = defaultDecider()

/** Tests set a mock; null puts the default back (no model call under test, so no test reaches the network). */
export function setDecider(d: Decider | null): void {
  decider = d ?? defaultDecider()
  cache.clear()
}

/** Whether a pick can ask a model at all: not under test's default, not with AGENTHYDRA_LEAD_MODEL=off. */
export function modelOn(): boolean {
  if (decider === noModel) return false
  return decider !== hswarmDecide || process.env.AGENTHYDRA_LEAD_MODEL !== 'off'
}

/** The managers a lead is picked from: the people of the manager family that can be become. */
export function managersOf(entries: Iterable<CatalogEntry>): CatalogEntry[] {
  return [...entries]
    .filter(
      (e) =>
        e.kind === 'person' &&
        e.family === 'manager' &&
        e.tier === 'manager' &&
        (e.modes ?? []).includes('become'),
    )
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** The manager who takes quick one-step asks in any field. */
export function quickOf(managers: CatalogEntry[]): CatalogEntry | undefined {
  return managers.find((e) => /quick|floor/i.test(`${e.title ?? ''} ${e.id}`))
}

/** The manager who takes work spanning several fields. */
export function coordinatorOf(managers: CatalogEntry[]): CatalogEntry | undefined {
  return managers.find((e) => /coordinat/i.test(`${e.title ?? ''} ${e.id}`))
}

const slugOf = (e: CatalogEntry) => e.id.slice(e.id.indexOf(':') + 1)

export function leadQuestion(
  managers: CatalogEntry[],
  message: string,
  current: CatalogEntry | null = null,
): LeadQuestion {
  const coord = coordinatorOf(managers)
  const quick = quickOf(managers)
  const now = current && managers.includes(current) ? current : null
  const options: Record<string, string> = {
    none: 'No work in the message: ok, thanks, a greeting, or a bare "keep going" that names no work.',
  }
  for (const m of managers)
    options[slugOf(m)] =
      `${m.name}${m.title ? ` (${m.title})` : ''}: ${m.when}${m === coord ? ' A message spanning several fields is theirs.' : ''}`
  return {
    message,
    question: [
      'Which manager should lead the work this owner message asks for?',
      quick
        ? `A quick ask needing no field judgment (a fact, a status, a rename, a typo, a git or npm command) is ${quick.name}'s.`
        : '',
      quick
        ? "A quick ask that changes something a field's manager owns stays that manager's: an ad spend or audience change is the advertising manager's, a schema column or a migration the backend manager's, a screen's design the UI manager's."
        : '',
      'Answer none only when the message holds no work: ok, thanks, a greeting, a bare "keep going".',
      `A continuation that names its work ("keep going on <the work>, still need <X>") is that work's field's manager's.`,
      "Research, a bug or a question inside one field is that field's manager's, and the lead is the field where the fix lives, not where the symptom shows.",
      coord ? `A message spanning several fields is ${coord.name}'s.` : '',
      // Without this a message about the chat's own tooling moved a backend chat to the coordinator (C3 N3).
      now
        ? `${now.name} leads this chat now: answer ${slugOf(now)} unless the work this message asks for clearly sits in another manager's field. A message that only says how to run a tool, or tests the chat's own tools, keeps ${now.name}.`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
    options,
  }
}

/** The word ranker: content words only, no `how` text, nothing under LEAD_MIN, and score before tier. Three or
 *  more managers hit means work across fields, so the coordinator. */
export function wordLead(
  entries: CatalogEntry[],
  message: string,
  feedback: Feedback | null = readFeedback(coreDir()),
): CatalogEntry | null {
  if (!contentWords(message).length) return null
  const managers = managersOf(entries)
  const need = terms(message, true)
  const coord = coordinatorOf(managers)
  const fields = managers.filter((m) => m !== coord && detailOf(m, need, true).score >= 2)
  if (coord && fields.length >= 3) return coord
  const ranked = rankEntries(entries, message, {
    kinds: ['person'],
    mode: 'become',
    tiers: LEAD_TIERS,
    content: true,
    noHow: true,
    min: LEAD_MIN,
    feedback,
  })
  return ranked[0]?.entry ?? null
}

/**
 * The lead for a message: the model's pick among the managers or none, else the word ranker's. A message with no
 * content word ("keep going", "ok") needs no call. `log` appends which path chose. `current` is the chat's lead now,
 * named in the question. With `late`, the call may run LATE_BUDGET_MS: the pick still answers by `budgetMs` (the word
 * ranker's when the model is not back), and the model's answer, when it comes, goes to `late` and the log.
 */
export async function pickLead(
  entries: CatalogEntry[],
  message: string,
  budgetMs: number,
  opts: {
    cache?: boolean
    log?: { dir: string; chat: string; at?: Date }
    current?: CatalogEntry | null
    late?: (pick: LeadPick) => void
  } = {},
): Promise<LeadPick> {
  const key = `${budgetMs}
${opts.current?.id ?? ''}
${message}`
  const hit = opts.cache === false ? undefined : cache.get(key)
  if (hit) return hit
  const started = performance.now()
  const managers = managersOf(entries)
  const toPick = (d: Decision): LeadPick => {
    const ms = Math.round(performance.now() - started)
    const answer = d.answer?.trim().toLowerCase()
    const chosen = managers.find((m) => slugOf(m) === answer)
    if (answer === 'none') return { id: null, path: 'model', ms }
    if (chosen) return { id: chosen.id, path: 'model', ms }
    return {
      id: wordLead(entries, message)?.id ?? null,
      path: 'words',
      ms,
      error: d.error ?? `not an option: ${d.answer}`,
    }
  }
  const keep = (pick: LeadPick, extra: Record<string, unknown> = {}, at = opts.log?.at) => {
    if (opts.cache !== false && !pick.error) {
      cache.set(key, pick)
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
    }
    if (opts.log)
      appendLog(
        opts.log.dir,
        {
          event: 'lead-pick',
          chat: opts.log.chat,
          id: pick.id,
          path: pick.path,
          ms: pick.ms,
          ...(pick.error ? { error: pick.error } : {}),
          ...extra,
        },
        at,
      )
  }
  let pick: LeadPick
  if (!contentWords(message).length) pick = { id: null, path: 'words', ms: 0 }
  // No managers to choose from: the word ranker picks among whoever can be become.
  else if (!managers.length)
    pick = { id: wordLead(entries, message)?.id ?? null, path: 'words', ms: 0 }
  else {
    const asked = decider(
      leadQuestion(managers, message, opts.current ?? null),
      opts.late ? LATE_BUDGET_MS : budgetMs,
    ).catch(
      (err): Decision => ({
        answer: null,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    const then = opts.late
    if (!then) pick = toPick(await asked)
    else {
      let timer: ReturnType<typeof setTimeout> | undefined
      const out = new Promise<null>((r) => {
        timer = setTimeout(() => r(null), Math.max(100, budgetMs - 50))
      })
      const d = await Promise.race([asked, out])
      clearTimeout(timer)
      if (d) pick = toPick(d)
      else {
        pick = toPick({ answer: null, error: 'no answer in time; asking on' })
        const landing: Promise<void> = asked
          .then((ld) => {
            const lp = toPick(ld)
            keep(lp, { late: true }, new Date())
            then(lp)
          })
          .catch((err) => {
            if (opts.log)
              appendLog(opts.log.dir, {
                event: 'lead-pick',
                chat: opts.log.chat,
                late: true,
                error: String(err instanceof Error ? err.message : err).slice(0, 200),
              })
          })
          .finally(() => late.delete(landing))
        late.add(landing)
      }
    }
  }
  keep(pick)
  return pick
}

/** Owner messages that only keep the work going. */
const CONTINUE =
  /^(ok(ay)?|yes|yep|sure|go( on| ahead)?|continue|keep going|do it|thanks?|thank you|sounds good|next|proceed)\b/i

/** An owner message worth checking the lead against: three content words or more, or a continuation that names its
 *  work ("keep going on the ad campaign"); a bare "keep going" or "ok do it" keeps the lead. */
export function substantive(message: string): boolean {
  const m = message.trim()
  return contentWords(m).length >= (CONTINUE.test(m) ? 2 : 3)
}

/** The cheap check before a call: the work may have moved when the current lead matches none of the message's
 *  words, or the word ranker names another lead. */
export function mayHaveMoved(
  entries: CatalogEntry[],
  current: CatalogEntry | null,
  message: string,
): boolean {
  if (!current) return true
  if (detailOf(current, terms(message, true), true).score < 2) return true
  const words = wordLead(entries, message)
  return !!words && words.id !== current.id
}

/** A brief for a note: whole when it fits NOTE_CAP, else the text before its third `## ` heading. */
export function briefFor(e: CatalogEntry, chat: string): string {
  const text = loadText(e).trimEnd()
  const become = `The whole brief: core_use { chat: "${chat}", id: "${e.id}", mode: "become" } (${loadRef(e)}).`
  if (text.length <= NOTE_CAP) return text
  const heads = [...text.matchAll(/^## /gm)].map((m) => m.index ?? 0)
  const head = heads.length >= 3 ? text.slice(0, heads[2]).trimEnd() : text
  const room = NOTE_CAP - become.length - 2
  return `${head.length <= room ? head : head.slice(0, room)}\n\n${become}`
}

/** `late`: the pick came back after the message it was made for, so the note rides the next one. */
export function leadNote(
  from: CatalogEntry | null,
  to: CatalogEntry,
  chat: string,
  late = false,
): string {
  return [
    `Lead change: ${late ? "the owner's last message was" : 'this message is'} ${to.name}'s field${to.title ? ` (${to.title})` : ''}${
      from ? `, not ${from.name}'s` : ''
    }. From here on you are ${to.name}. ${to.name}'s brief:`,
    briefFor(to, chat),
  ].join('\n\n')
}

/** Makes `e` the chat's lead in its hydra.md, as core_use become does; the next launch's slot carries its brief. */
export function recordLead(hydraMd: string, e: CatalogEntry, now: Date): void {
  const doc =
    (existsSync(hydraMd) ? parseHydra(readFileSync(hydraMd, 'utf8')) : null) ?? emptyDoc(now)
  doc.lead = leadLine(e)
  doc.updated = now.toISOString()
  mkdirSync(dirname(hydraMd), { recursive: true })
  writeFileSync(hydraMd, renderHydra(doc))
}

export interface LateLead {
  from: string | null
  to: string
}

const lateFile = (chatRoot: string) => join(chatRoot, 'lead-late.json')

/** A late pick's move whose lead-change note the chat's next message still owes, beside its hydra.md. */
export function setLateLead(chatRoot: string, move: LateLead): void {
  mkdirSync(chatRoot, { recursive: true })
  writeFileSync(lateFile(chatRoot), JSON.stringify(move))
}

/** The owed move, taken once: it is removed as it is read. */
export function takeLateLead(chatRoot: string): LateLead | null {
  const file = lateFile(chatRoot)
  if (!existsSync(file)) return null
  let move: LateLead | null = null
  try {
    move = JSON.parse(readFileSync(file, 'utf8')) as LateLead
  } catch {}
  rmSync(file, { force: true })
  return move?.to ? move : null
}
