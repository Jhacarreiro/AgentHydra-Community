import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type CatalogEntry,
  KINDS,
  type Kind,
  LEAD_TIERS,
  loadCatalog,
  loadRef,
  loadText,
} from './catalog'
import { readFeedback } from './feedback'
import { findPage, matchOf, PAGE } from './find'
import {
  addPick,
  emptyDoc,
  type HydraDoc,
  leadLine,
  leadName,
  parseHydra,
  renderHydra,
  scopeLine,
} from './hydra-md'
import { appendLog } from './log'
import { chatPaths } from './paths'
import { takeLeadOwed } from './sent'

export type Step =
  | 'q1'
  | 'q2'
  | 'q3'
  | 'q4'
  | 'q5'
  | 'q6'
  | 'q6pick'
  | 'q7'
  | 'q7pick'
  | 'q8'
  | 'q8pick'
  | 'q9'
  | 'done'

interface Group {
  label: string
  need: string
  kinds?: Kind[]
  mode?: string
  tiers?: readonly string[]
  start: number
  ids: string[]
}

interface Pick {
  id: string
  mode?: 'hire'
}

export interface RunState {
  run: number
  step: Step
  msg: string
  steps: string[]
  tier?: string
  team?: string
  lead?: string | null
  picks: Pick[]
  groups: Group[]
  shown: string[]
  retried: boolean
}

interface Parsed {
  kw: string
  text?: string
  n?: number
  picks?: string[]
  label?: string
  roles?: { label: string; need: string }[]
}

type Files = ReturnType<typeof chatPaths>

interface Ctx {
  dir: string
  chat: string
  cat: Map<string, CatalogEntry>
  now: Date
  files: Files
}

type Reply = Record<string, unknown>

const QUESTIONS: Record<Exclude<Step, 'done'>, string> = {
  q1: "Do you need anything you don't already have for this message? Answer `no`, or `yes: <what you need>`.",
  q2: '',
  q3: 'Do it yourself, or delegate? `myself` or `delegate`.',
  q4: 'What tier is it, 1-5? 1 = one worker for minutes, 2 = one worker for an hour, 3 = a few workers or one field for a day, 4 = several fields in parallel, 5 = a multi-team build. Sized for an AI, never months.',
  q5: 'How big a team? Any number (1, 3, 5, 20).',
  q6: 'Who should you be? Describe the lead this needs in plain words.',
  q6pick: 'Pick one id, `more`, or `none: <a better description>`.',
  q7: 'Who and what do you need under you? One role per line, e.g. `testing: real visitors for the signup page`.',
  q7pick: 'Pick ids (`picks`), `more <role>`, or `none`.',
  q8: 'Which knowledge does this touch? Plain words, or `none`.',
  q8pick: 'Pick ids (`picks`), `more`, or `none`.',
  q9: 'Your plan in 3-7 lines.',
}

const EXAMPLE: Record<Exclude<Step, 'done'>, string> = {
  q1: '`yes: move the notes into the archive folder`',
  q2: '`mid` or `new`',
  q3: '`myself` or `delegate`',
  q4: '`3`',
  q5: '`5`',
  q6: '`a lead who knows dashboard design`',
  q6pick: '`2`, `person:ui-lead`, or `none`',
  q7: '`testing: real visitors for the signup page`, or `none`',
  q7pick: '`1 3`, `more testing`, or `none`',
  q8: '`dashboard styling`, or `none`',
  q8pick: '`1`, `more`, or `none`',
  q9: '`Rebuild the layout first, then test it with two visitors.`',
}

/** q1 on a chat's first message: the difficulty rides along; 2 or more gets a persona. */
const FIRST_Q1 =
  "Do you need anything you don't already have, and how hard is this message, 1-5? Answer `no 1`, or `yes 3: <what you need>`. 2 or more gets a persona."
const FIRST_EXAMPLE_Q1 = '`no 1`, or `yes 3: move the notes into the archive folder`'

const PEOPLE_AND_TOOLS: Kind[] = ['person', 'instrument', 'worker']
const KNOWLEDGE: Kind[] = ['knowledge', 'skill']
const TOKEN = /^(\d+|(?:person|instrument|worker|knowledge|skill):[a-z0-9-]+)$/

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The ask the end of every run carries: the report is the only outcome signal the log gets. */
const REPORT_ASK =
  'When this work is finished, call core_report once: { chat, outcome: "done" | "partial" | "failed", note, score: 1-5 for the help you got, overruled?: [ids you set aside] }.'

const skipsLogged = new Set<string>()

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** The catalog, logging each skipped entry once per (file, id, why) until that file changes. */
function catalogFor(dir: string, now: Date): Map<string, CatalogEntry> {
  const cat = loadCatalog(dir)
  for (const s of cat.skipped) {
    const key = [dir, s.file, s.id ?? '', s.why, mtimeOf(join(dir, 'catalog', s.file))].join(
      '\u0000',
    )
    if (skipsLogged.has(key)) continue
    skipsLogged.add(key)
    appendLog(dir, { event: 'skip', ...s }, now)
  }
  return cat.entries
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function readState(file: string): RunState | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as RunState) : null
}

function readDoc(files: Files): HydraDoc | null {
  return existsSync(files.hydraMd) ? parseHydra(readFileSync(files.hydraMd, 'utf8')) : null
}

/** Folder entries q1 shows in full; a folder with many rules would otherwise fill the chat on every message. */
const FOLDER_SHOWN = 3

/** All knowledge filed under the chat's folder. */
export function folderKnowledgeOf(cat: Iterable<CatalogEntry>, cwd: string): CatalogEntry[] {
  if (!cwd) return []
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const here = norm(cwd)
  return [...cat].filter(
    (e) =>
      e.kind === 'knowledge' &&
      (e.folders ?? []).some((f) => here === norm(f) || here.startsWith(`${norm(f)}/`)),
  )
}

/** The rules a pack or core_scope shows for a folder: its main entries (tagged `repo`) when it has any, else all of them. */
export function mainRules(all: CatalogEntry[]): CatalogEntry[] {
  const main = all.filter((e) => (e.tags ?? []).includes('repo'))
  return main.length ? main : all
}

/** The knowledge for the chat's folder: its main entries (tagged `repo`) in full, the rest as a count that core_find reaches. */
function folderKnowledge(cat: Map<string, CatalogEntry>, cwd: string) {
  if (!cwd) return { folderKnowledge: [] }
  const all = folderKnowledgeOf(cat.values(), cwd)
  const shown = mainRules(all).slice(0, FOLDER_SHOWN)
  const more = all.length - shown.length
  return {
    folderKnowledge: shown.map((e) => ({ ...matchOf(e), load: loadRef(e) })),
    ...(more > 0
      ? {
          folderMore: {
            count: more,
            find: 'core_find { need: "<what you are about to touch>", kind: "knowledge", chat } finds the rest of this folder\'s rules',
          },
        }
      : {}),
  }
}

export function scope(dir: string, chat: string, now = new Date()) {
  const files = chatPaths(dir, chat)
  if (!existsSync(files.prompt))
    throw new Error('no message for this chat yet: the core hook writes prompt.txt first')
  const cat = catalogFor(dir, now)
  const doc = readDoc(files)
  const prev = readState(files.state)
  const state: RunState = {
    run: (prev?.run ?? 0) + 1,
    step: 'q1',
    msg: squash(readFileSync(files.prompt, 'utf8')).slice(0, 80).replace(/"/g, "'"),
    steps: [],
    picks: [],
    groups: [],
    shown: [],
    retried: false,
  }
  writeText(files.state, JSON.stringify(state, null, 2))
  appendLog(dir, { chat, run: state.run, step: 'start' }, now)
  const cwd = existsSync(files.cwd) ? readFileSync(files.cwd, 'utf8').trim() : ''
  return {
    run: state.run,
    step: 'q1' as Step,
    question: questionOf('q1', doc),
    context: {
      hydraMd: doc
        ? { exists: true, path: files.hydraMd, lead: leadName(doc), tier: doc.tier }
        : { exists: false, path: files.hydraMd },
      ...folderKnowledge(cat, cwd),
    },
  }
}

function group(label: string, need: string, kinds?: Kind[], mode?: string): Group {
  return { label, need, kinds, mode, start: 0, ids: [] }
}

function leadGroup(need: string): Group {
  return { ...group('lead', need, ['person'], 'become'), tiers: LEAD_TIERS }
}

function fill(ctx: Ctx, g: Group): void {
  g.ids = findPage(ctx.cat.values(), g.need, {
    kinds: g.kinds,
    mode: g.mode,
    tiers: g.tiers,
    start: g.start,
    feedback: readFeedback(ctx.dir),
  }).ids
  if (!g.ids.length)
    appendLog(ctx.dir, { chat: ctx.chat, event: 'find', need: g.need, empty: true }, ctx.now)
}

/** Logs every id a group showed as a miss: passed over for the next page (`more`) or rejected (`none`). */
function missGroup(ctx: Ctx, g: Group, why: 'more' | 'none', better?: string): void {
  for (const id of g.ids)
    appendLog(
      ctx.dir,
      { chat: ctx.chat, event: 'miss', id, need: g.need, why, ...(better ? { better } : {}) },
      ctx.now,
    )
}

function pageGroup(ctx: Ctx, g: Group): void {
  missGroup(ctx, g, 'more')
  g.start += PAGE
  fill(ctx, g)
}

function view(ctx: Ctx, state: RunState) {
  const out: Record<string, unknown>[] = []
  state.shown = []
  for (const g of state.groups)
    for (const id of g.ids) {
      const e = ctx.cat.get(id)
      if (!e) continue
      state.shown.push(id)
      out.push({ n: state.shown.length, group: g.label, ...matchOf(e) })
    }
  return out
}

function questionOf(step: Step, doc: HydraDoc | null): string {
  if (step === 'done') return ''
  if (step === 'q1' && !doc) return FIRST_Q1
  if (step === 'q2') {
    const head = doc?.plan[0] ?? 'no plan line yet'
    return `Mid-project (this message fits your hydra.md: ${doc ? leadName(doc) : 'none'}, ${head}) or new work? \`mid\` or \`new\`.`
  }
  return QUESTIONS[step]
}

/** The next question. Matches ride along only when the list changed: the chat already holds the ones it was shown. */
function next(ctx: Ctx, state: RunState, doc: HydraDoc | null): Reply {
  const before = state.shown.join('\n')
  const matches = view(ctx, state)
  const fresh = matches.length > 0 && state.shown.join('\n') !== before
  return { step: state.step, question: questionOf(state.step, doc), ...(fresh ? { matches } : {}) }
}

function reject(ctx: Ctx, state: RunState, doc: HydraDoc | null, why: string): Reply {
  state.steps.pop()
  return { ...next(ctx, state, doc), error: why }
}

function end(
  ctx: Ctx,
  state: RunState,
  doc: HydraDoc | null,
  verdict: string,
  body: Reply,
  write = true,
): Reply {
  state.step = 'done'
  const reply: Reply = { verdict, ...body, report: REPORT_ASK }
  if (verdict === 'go') {
    const lead = takeLeadOwed(ctx.files.sent, ctx.cat)
    if (lead) reply.lead = lead
  }
  if (doc && write) {
    doc.updated = ctx.now.toISOString()
    doc.scopeLog.push(scopeLine(ctx.now, state.msg, verdict, state.steps))
    writeText(ctx.files.hydraMd, renderHydra(doc))
    if (verdict === 'hydra') reply.hydra_md = renderHydra(doc)
  }
  appendLog(ctx.dir, { chat: ctx.chat, run: state.run, step: 'end', verdict }, ctx.now)
  return reply
}

function resolve(tokens: string[], state: RunState, cat: Map<string, CatalogEntry>) {
  const ids: string[] = []
  const bad: string[] = []
  for (const t of tokens) {
    const id = /^\d+$/.test(t) ? state.shown[Number(t) - 1] : t
    if (id && cat.has(id)) ids.push(id)
    else bad.push(t)
  }
  return { ids: [...new Set(ids)], bad }
}

function addPicks(state: RunState, ids: string[], mode?: 'hire'): void {
  for (const id of ids) {
    const have = state.picks.find((p) => p.id === id)
    if (!have) state.picks.push(mode ? { id, mode } : { id })
    else if (mode && !have.mode) have.mode = mode
  }
}

function pickHows(ctx: Ctx, state: RunState) {
  return state.picks.flatMap((p) => {
    const e = ctx.cat.get(p.id)
    return e ? [{ id: e.id, how: e.how }] : []
  })
}

function findGroup(state: RunState, label?: string): Group | undefined {
  if (!label) return state.groups.length === 1 ? state.groups[0] : undefined
  return state.groups.find((g) => g.label.toLowerCase() === label.toLowerCase())
}

function finishPlan(ctx: Ctx, state: RunState, prev: HydraDoc | null, plan: string): Reply {
  const doc = emptyDoc(ctx.now)
  doc.scopeLog = prev?.scopeLog ?? []
  doc.tier = state.tier ?? '-'
  doc.team = state.team ?? '-'
  const lead = state.lead ? ctx.cat.get(state.lead) : undefined
  doc.lead = lead ? leadLine(lead) : null
  doc.plan = plan
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const p of state.picks) {
    const e = ctx.cat.get(p.id)
    if (e) addPick(doc, e, p.mode)
  }
  // Logged as core_use become logs, so both ways a lead is chosen are counted alike.
  if (lead && prev?.lead !== doc.lead)
    appendLog(
      ctx.dir,
      { chat: ctx.chat, event: 'use', mode: 'become', id: lead.id, via: 'tree' },
      ctx.now,
    )
  return end(ctx, state, doc, 'hydra', { become: lead ? loadText(lead) : null })
}

function firstQ1(ctx: Ctx, state: RunState, p: Parsed): Reply {
  if (p.kw === 'no' && p.n === 1) return end(ctx, state, null, 'go', { say: 'Go do it.' })
  if (p.n === undefined) {
    state.groups = [group('need', p.text ?? state.msg)]
    fill(ctx, state.groups[0])
    state.step = 'q3'
    return next(ctx, state, null)
  }
  state.tier = String(p.n)
  if (p.n >= 2) {
    state.groups = [leadGroup(p.text ?? state.msg)]
    fill(ctx, state.groups[0])
    state.step = 'q6pick'
    return next(ctx, state, null)
  }
  state.groups = [group('need', p.text ?? state.msg)]
  fill(ctx, state.groups[0])
  state.step = 'q3'
  return next(ctx, state, null)
}

function route(ctx: Ctx, state: RunState, doc: HydraDoc | null, p: Parsed): Reply {
  switch (state.step) {
    case 'q1': {
      if (!doc) return firstQ1(ctx, state, p)
      if (p.kw === 'no') return end(ctx, state, doc, 'go', { say: 'Go do it.' })
      state.groups = [group('need', p.text ?? state.msg)]
      fill(ctx, state.groups[0])
      state.step = doc ? 'q2' : 'q3'
      return next(ctx, state, doc)
    }
    case 'q2': {
      if (p.kw === 'mid') {
        const added: Reply[] = []
        const hd = doc ?? emptyDoc(ctx.now)
        for (const pk of state.picks) {
          const e = ctx.cat.get(pk.id)
          if (e && addPick(hd, e, pk.mode)) added.push({ id: e.id, how: e.how })
        }
        return end(ctx, state, hd, 'go', { added })
      }
      state.step = 'q3'
      return next(ctx, state, doc)
    }
    case 'q3': {
      if (p.kw === 'myself')
        return end(ctx, state, doc, 'go', { picks: pickHows(ctx, state) }, false)
      state.step = state.tier ? 'q5' : 'q4'
      return next(ctx, state, doc)
    }
    case 'q4':
      state.tier = String(p.n)
      state.step = 'q5'
      return next(ctx, state, doc)
    case 'q5':
      state.team = String(p.n)
      state.groups = []
      state.step = 'q6'
      return next(ctx, state, doc)
    case 'q6': {
      state.groups = [leadGroup(p.text ?? state.msg)]
      fill(ctx, state.groups[0])
      state.step = 'q6pick'
      return next(ctx, state, doc)
    }
    case 'q6pick': {
      if (p.kw === 'none') for (const g of state.groups) missGroup(ctx, g, 'none', p.text)
      if (p.kw === 'none' && p.text) {
        state.groups = [leadGroup(p.text)]
        fill(ctx, state.groups[0])
        return next(ctx, state, doc)
      }
      if (p.kw === 'more') {
        const g = findGroup(state)
        if (g) pageGroup(ctx, g)
        return next(ctx, state, doc)
      }
      if (p.kw === 'none') {
        state.lead = null
      } else {
        const { ids } = resolve(p.picks ?? [], state, ctx.cat)
        const lead = ids.find((id) => ctx.cat.get(id)?.kind === 'person')
        if (!lead)
          return reject(
            ctx,
            state,
            doc,
            'no person matched: pick a number or an id from the matches',
          )
        if (!(LEAD_TIERS as readonly string[]).includes(ctx.cat.get(lead)?.tier ?? ''))
          return reject(
            ctx,
            state,
            doc,
            'only a manager or an employee can lead: owners are consulted, interns are hired under a lead',
          )
        state.lead = lead
      }
      state.groups = []
      state.step = 'q7'
      return next(ctx, state, doc)
    }
    case 'q7': {
      if (p.kw === 'none') {
        state.groups = []
        state.step = 'q8'
        return next(ctx, state, doc)
      }
      state.groups = (p.roles ?? []).map((r) => group(r.label, r.need, PEOPLE_AND_TOOLS))
      for (const g of state.groups) fill(ctx, g)
      state.step = 'q7pick'
      return next(ctx, state, doc)
    }
    case 'q7pick': {
      if (p.kw === 'more') {
        const g = findGroup(state, p.label)
        if (g) pageGroup(ctx, g)
        return next(ctx, state, doc)
      }
      if (p.kw === 'picks') addPicks(state, resolve(p.picks ?? [], state, ctx.cat).ids, 'hire')
      else for (const g of state.groups) missGroup(ctx, g, 'none', p.text)
      state.groups = []
      state.step = 'q8'
      return next(ctx, state, doc)
    }
    case 'q8': {
      if (p.kw === 'none') {
        state.groups = []
        state.step = 'q9'
        return next(ctx, state, doc)
      }
      state.groups = [group('knowledge', p.text ?? state.msg, KNOWLEDGE)]
      fill(ctx, state.groups[0])
      state.step = 'q8pick'
      return next(ctx, state, doc)
    }
    case 'q8pick': {
      if (p.kw === 'more') {
        const g = findGroup(state)
        if (g) pageGroup(ctx, g)
        return next(ctx, state, doc)
      }
      if (p.kw === 'picks') addPicks(state, resolve(p.picks ?? [], state, ctx.cat).ids)
      else for (const g of state.groups) missGroup(ctx, g, 'none', p.text)
      state.groups = []
      state.step = 'q9'
      return next(ctx, state, doc)
    }
    case 'q9':
      return finishPlan(ctx, state, doc, p.text ?? state.msg)
    default:
      throw new Error('no run for this chat: call core_scope first')
  }
}

function pickAnswer(t: string): Parsed | null {
  if (/^none\b/i.test(t))
    return { kw: 'none', text: t.replace(/^none\b\s*:?\s*/i, '') || undefined }
  if (/^more\b/i.test(t)) return { kw: 'more', label: t.replace(/^more\b\s*/i, '') || undefined }
  const toks = t.split(/[\s,]+/).filter(Boolean)
  return toks.length && toks.every((x) => TOKEN.test(x)) ? { kw: 'picks', picks: toks } : null
}

function parseRole(line: string): { label: string; need: string } {
  const m = line.match(/^[-*]?\s*([^:]{1,60}):\s*(.+)$/)
  return m ? { label: m[1].trim(), need: m[2].trim() } : { label: line.slice(0, 60), need: line }
}

function parse(step: Step, raw: string, first = false): Parsed | null {
  const t = squash(raw)
  switch (step) {
    case 'q1': {
      if (first) {
        const no = t.match(/^no\b(?:\s+([1-5])\b)?/i)
        if (no) return { kw: 'no', n: Number(no[1] ?? 1) }
        const yes = t.match(/^yes\b\s*(?:([1-5])\b)?\s*:?\s*(.+)$/i)
        return yes
          ? { kw: 'yes', n: yes[1] ? Number(yes[1]) : undefined, text: yes[2].trim() }
          : null
      }
      if (/^no\b/i.test(t)) return { kw: 'no' }
      const y = t.match(/^yes\b\s*:?\s*(.+)$/i)
      return y ? { kw: 'yes', text: y[1].trim() } : null
    }
    case 'q2':
      return /^mid\b/i.test(t) ? { kw: 'mid' } : /^new\b/i.test(t) ? { kw: 'new' } : null
    case 'q3':
      return /^myself\b/i.test(t)
        ? { kw: 'myself' }
        : /^delegate\b/i.test(t)
          ? { kw: 'delegate' }
          : null
    case 'q4': {
      const m = t.match(/^([1-5])\b/)
      return m ? { kw: 'tier', n: Number(m[1]) } : null
    }
    case 'q5': {
      const m = t.match(/^(\d{1,3})\b/)
      return m && Number(m[1]) >= 1 ? { kw: 'team', n: Number(m[1]) } : null
    }
    case 'q6':
      return t ? { kw: 'lead', text: t } : null
    case 'q6pick':
    case 'q7pick':
    case 'q8pick':
      return pickAnswer(t)
    case 'q7': {
      if (/^none\b/i.test(t)) return { kw: 'none', roles: [] }
      const roles = raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map(parseRole)
      return roles.length ? { kw: 'roles', roles } : null
    }
    case 'q8':
      return /^none\b/i.test(t) ? { kw: 'none' } : t ? { kw: 'need', text: t } : null
    case 'q9':
      return raw.trim() ? { kw: 'plan', text: raw.trim() } : null
    default:
      return null
  }
}

function fallback(step: Step, state: RunState): Parsed {
  switch (step) {
    case 'q1':
      return { kw: 'yes', text: state.msg }
    case 'q2':
      return { kw: 'new' }
    case 'q3':
      return { kw: 'myself' }
    case 'q4':
      return { kw: 'tier', n: 2 }
    case 'q5':
      return { kw: 'team', n: 1 }
    case 'q6':
      return { kw: 'lead', text: state.msg }
    case 'q7':
      return { kw: 'none', roles: [] }
    case 'q9':
      return { kw: 'plan', text: state.msg }
    default:
      return { kw: 'none' }
  }
}

export function answer(
  dir: string,
  chat: string,
  input: { answer: string; picks?: string[] },
  now = new Date(),
): Reply {
  const files = chatPaths(dir, chat)
  const state = readState(files.state)
  if (!state || state.step === 'done')
    throw new Error('no run for this chat: call core_scope first')
  const cat = catalogFor(dir, now)
  const ctx: Ctx = { dir, chat, cat, now, files }
  const doc = readDoc(files)
  const step = state.step
  const extra = resolve(input.picks ?? [], state, cat)
  addPicks(state, extra.ids)
  let parsed = parse(step, input.answer ?? '', !doc)
  if (!parsed) {
    if (!state.retried) {
      state.retried = true
      writeText(files.state, JSON.stringify(state, null, 2))
      const shown = squash(input.answer ?? '').slice(0, 80)
      const example =
        step === 'q1' && !doc ? FIRST_EXAMPLE_Q1 : EXAMPLE[step as Exclude<Step, 'done'>]
      return {
        step,
        question: questionOf(step, doc),
        retry: `Could not read "${shown}". Example: ${example}`,
        matches: view(ctx, state),
      }
    }
    parsed = fallback(step, state)
  }
  const dflt = fallback(step, state)
  const defaulted = parsed.kw === dflt.kw && parsed.n === dflt.n && parsed.text === dflt.text
  state.retried = false
  state.steps.push(`${step} ${parsed.kw}`)
  appendLog(
    dir,
    {
      chat,
      run: state.run,
      step,
      answer: squash(input.answer ?? '').slice(0, 200),
      shown: state.shown,
      kw: parsed.kw,
      defaulted,
    },
    now,
  )
  const reply = route(ctx, state, doc, parsed)
  if (extra.bad.length) reply.skipped = extra.bad
  writeText(files.state, JSON.stringify(state, null, 2))
  return reply
}

/** The last page core_find showed per (chat, need, kind), for the misses a `more` logs. */
const pages = new Map<string, { start: number; ids: string[] }>()
const PAGES_KEPT = 200

function keepPage(key: string, page: { start: number; ids: string[] }): void {
  pages.delete(key)
  pages.set(key, page)
  if (pages.size > PAGES_KEPT) pages.delete(pages.keys().next().value as string)
}

export function findTool(
  dir: string,
  args: { need: string; kind?: string; more?: boolean; chat?: string },
  now = new Date(),
) {
  const cat = catalogFor(dir, now)
  const need = squash(args.need)
  if (!need) throw new Error('need is empty: say what you are looking for')
  if (args.kind && !(KINDS as readonly string[]).includes(args.kind))
    throw new Error(`kind must be one of ${KINDS.join(', ')}`)
  const kinds = args.kind ? [args.kind as Kind] : undefined
  const feedback = readFeedback(dir)
  // A call with no chat keeps no page: two chat-less callers would otherwise page each other's list.
  const key = args.chat ? [args.chat, need, args.kind ?? ''].join('\u0000') : null
  let start = 0
  if (args.more) {
    // No page in memory (a restart, an evicted key, no chat): the previous page is the first one.
    const prev = (key && pages.get(key)) || {
      start: 0,
      ids: findPage(cat.values(), need, { kinds, start: 0, feedback }).ids,
    }
    for (const id of prev.ids)
      appendLog(dir, { chat: args.chat, event: 'miss', id, need, why: 'more' }, now)
    start = prev.start + PAGE
  }
  const r = findPage(cat.values(), need, { kinds, start, feedback })
  if (key) keepPage(key, { start, ids: r.ids })
  appendLog(
    dir,
    {
      chat: args.chat,
      event: 'find',
      need,
      ...(args.kind ? { kind: args.kind } : {}),
      ...(start ? { start } : {}),
      ids: r.ids,
      total: r.total,
    },
    now,
  )
  const matches = r.ids.flatMap((id) => {
    const e = cat.get(id)
    return e ? [matchOf(e)] : []
  })
  return { matches, more: r.total > start + PAGE, total: r.total }
}
