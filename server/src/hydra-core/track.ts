import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { type CatalogEntry, loadCatalog, MODES } from './catalog'
import { readLog } from './log'
import { chatPaths, coreDir } from './paths'

type Json = Record<string, unknown>

interface Block {
  type: string
  id?: string
  name?: string
  input?: Json
  tool_use_id?: string
  content?: unknown
  text?: unknown
}

interface Rec {
  type?: string
  sessionId?: string
  cwd?: string
  timestamp?: string
  isMeta?: boolean
  message?: { content?: unknown }
}

interface Call {
  id: string
  name: string
  input: Json
  at: number
  result: string
}

interface Turn {
  at: number
  calls: Call[]
}

interface Session {
  id: string
  project: string
  cwd: string
  prompt: string
  turns: Turn[]
}

export interface Scope {
  chat: string
  run: number | null
  verdict: string | null
}

export interface Reported {
  chat: string
  run: number
  outcome: string
  score: number | null
  missing: string | null
}

export type Method = 'scope' | 'pack' | 'both' | 'none'

export interface Row {
  session: string
  project: string
  turn: number
  at: string
  placement: string | null
  scopes: Scope[]
  method: Method
  served: boolean
  compliant: boolean
  used: string[]
  offered: string[]
  picks: string[]
  notTaken: string[]
  usedNotOffered: string[]
  reports: Reported[]
}

export interface PlacementSummary {
  launches: number
  messages: number
  meanChars: number
  reuseRate: number | null
  readRate: number | null
}

export interface Summary {
  builtAt: string
  onAt: string | null
  sessions: { transcripts: number; workers: number; noCore: number; eligible: number }
  turns: { total: number; compliant: number; compliancePct: number }
  methods: { scope: number; pack: number; both: number; none: number }
  scopes: { total: number; go: number; hydra: number; none: number }
  packs: {
    total: number
    first: number
    delta: number
    emptyDelta: number
    meanBytes: number
    meanMs: number
  }
  placements: { slot: PlacementSummary; file: PlacementSummary }
  reports: {
    runs: number
    reported: number
    rate: number
    noRun: number
    scored: number
    meanScore: number | null
  }
  deliveries: { total: number; matched: number; noTurn: number }
  picks: { total: number }
  entries: {
    offered: number
    taken: number
    neverTaken: number
    notTaken: { id: string; offered: number }[]
  }
  usedNotOffered: number
  missing: { chat: string; run: number; text: string }[]
  handoffs: { chats: number; handoffs: number; kept: number; lost: number; linkedFiles: number }
}

export interface TrackOptions {
  roots?: string[]
  handoffsDir?: string
  now?: number
}

const TEN_MINUTES = 10 * 60 * 1000
const CORE_PREFIX = 'mcp__agenthydra__core_'
const ID_RE = /\b(?:person|instrument|worker|knowledge|skill):[a-z0-9][a-z0-9-]*/g
const ONE_ID = /^(?:person|instrument|worker|knowledge|skill):[a-z0-9][a-z0-9-]*$/
const MONTH = 30 * 24 * 60 * 60 * 1000
const NOT_TAKEN_SHOWN = 10
const CHAT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

function list(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function mtimeOf(file: string): number | null {
  return existsSync(file) ? statSync(file).mtimeMs : null
}

export function defaultRoots(): string[] {
  const home = homedir()
  const cli = join(home, '.agenthydra', 'cli-instances')
  return [join(home, '.claude', 'projects'), ...list(cli).map((id) => join(cli, id, 'projects'))]
}

function transcripts(roots: string[], since: number): { file: string; project: string }[] {
  const out: { file: string; project: string }[] = []
  for (const root of roots)
    for (const project of list(root)) {
      const pdir = join(root, project)
      for (const name of list(pdir)) {
        if (!name.endsWith('.jsonl')) continue
        const file = join(pdir, name)
        if (statSync(file).mtimeMs >= since) out.push({ file, project })
      }
    }
  return out
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b: Block) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
}

function parseSession(file: string, project: string): Session {
  const turns: Turn[] = []
  const byId = new Map<string, Call>()
  let id = basename(file, '.jsonl')
  let cwd = ''
  let prompt = ''
  let cur: Turn | null = null
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let rec: Rec
    try {
      rec = JSON.parse(line) as Rec
    } catch {
      continue
    }
    if (typeof rec.sessionId === 'string') id = rec.sessionId
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd
    const at = Date.parse(rec.timestamp ?? '') || 0
    const content = rec.message?.content
    if (rec.type === 'user' && typeof content === 'string' && !rec.isMeta) {
      if (!prompt) prompt = content
      cur = { at, calls: [] }
      turns.push(cur)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const b of content as Block[]) {
      if (b.type === 'tool_use' && rec.type === 'assistant' && cur && b.id && b.name) {
        const call: Call = { id: b.id, name: b.name, input: b.input ?? {}, at, result: '' }
        cur.calls.push(call)
        byId.set(b.id, call)
      } else if (b.type === 'tool_result' && b.tool_use_id) {
        const call = byId.get(b.tool_use_id)
        if (call) call.result = textOf(b.content)
      }
    }
  }
  return { id, project, cwd, prompt, turns }
}

function isWorker(s: Session): boolean {
  return (
    /corch/i.test(s.project) ||
    /[\\/]corch[\\/]/i.test(s.cwd) ||
    /CliMayte worker|climayte_worker/.test(s.prompt)
  )
}

const tail = (id: string): string => slug(id.slice(id.indexOf(':') + 1))
const bare = (name: string): string => slug(name.replace(/^.*:/, ''))

/** The catalog entries a call uses: a core_use names one; a Skill, Agent or MCP call maps by name, or to none. */
function usedOf(c: Call, cat: CatalogEntry[]): string[] {
  const hit = (pick: (e: CatalogEntry) => boolean) => cat.filter(pick).map((e) => e.id)
  if (c.name === `${CORE_PREFIX}use`) return [str(c.input.id)].filter(Boolean)
  if (c.name === 'Skill') {
    const name = bare(str(c.input.skill))
    return name
      ? hit(
          (e) =>
            (e.kind === 'skill' && tail(e.id) === name) ||
            (e.load.type === 'skill' && bare(e.load.name) === name),
        )
      : []
  }
  if (c.name === 'Agent') {
    const name = slug(str(c.input.subagent_type))
    return name
      ? hit((e) => (e.kind === 'worker' || e.kind === 'person') && tail(e.id) === name)
      : []
  }
  if (c.name.startsWith('mcp__') && !c.name.startsWith(CORE_PREFIX)) {
    const server = c.name.split('__')[1] ?? ''
    return hit(
      (e) =>
        e.kind === 'instrument' &&
        (tail(e.id) === slug(server) ||
          (e.load.type === 'tool' && e.load.call.startsWith(`mcp__${server}__`))),
    )
  }
  return []
}

function scopeOf(chat: string, at: number, events: Json[]): Scope {
  let run: number | null = null
  let best = Number.POSITIVE_INFINITY
  for (const e of events) {
    if (str(e.chat) !== chat || e.step !== 'start') continue
    const t = Date.parse(str(e.at))
    if (t >= at - 60_000 && t < best) {
      best = t
      run = Number(e.run)
    }
  }
  if (run === null) return { chat, run: null, verdict: null }
  const end = events.find((e) => str(e.chat) === chat && e.run === run && e.step === 'end')
  return { chat, run, verdict: end ? str(end.verdict) || null : null }
}

function reportOf(chat: string, run: number, events: Json[]): Reported | null {
  const e = events.findLast((x) => x.event === 'report' && str(x.chat) === chat && x.run === run)
  if (!e) return null
  return {
    chat,
    run,
    outcome: str(e.outcome),
    score: typeof e.score === 'number' ? e.score : null,
    missing: str(e.missing) || null,
  }
}

/** The ids a pack or placement line pasted in full (reading them is the use, no offer), as the feedback fold counts them;
 *  a line from before `pasted` was logged counts its knowledge and person ids as pasted. */
function pastedIn(e: Json): Set<string> {
  if (Array.isArray(e.pasted)) return new Set(e.pasted.map(str))
  const legacy = Array.isArray(e.ids)
    ? e.ids.map(str).filter((id) => /^(?:knowledge|person):/.test(id))
    : []
  return new Set(legacy)
}

// A turn is served when the core delivered something for it: a pack, or a per-message answer (even an empty one).
function deliveriesOf(s: Session, turn: Turn, events: Json[]): Json[] {
  return events.filter(
    (e) =>
      (e.event === 'pack' || (e.event === 'placement' && e.phase === 'message')) &&
      str(e.session) === s.id &&
      Math.abs(Date.parse(str(e.at)) - turn.at) <= 60_000,
  )
}

function placementOf(s: Session, events: Json[]): string | null {
  const last = events.findLast((e) => e.event === 'placement' && str(e.session) === s.id)
  return last ? str(last.placement) : null
}

function turnRow(
  s: Session,
  turn: Turn,
  index: number,
  events: Json[],
  cat: CatalogEntry[],
  delivered: Set<Json>,
): Row {
  const scopes = turn.calls
    .filter((c) => c.name === `${CORE_PREFIX}scope`)
    .map((c) => scopeOf(str(c.input.chat), c.at, events))
  const deliveries = deliveriesOf(s, turn, events)
  for (const d of deliveries) delivered.add(d)
  const core = turn.calls.filter((c) => c.name.startsWith(CORE_PREFIX))
  const offered = new Set<string>()
  for (const c of core) for (const m of c.result.matchAll(ID_RE)) offered.add(m[0])
  for (const sc of scopes)
    for (const e of events)
      if (str(e.chat) === sc.chat && e.run === sc.run && Array.isArray(e.shown))
        for (const id of e.shown) offered.add(str(id))
  const pasted = new Set<string>()
  for (const p of deliveries) {
    const inFull = pastedIn(p)
    if (Array.isArray(p.ids))
      for (const id of p.ids) (inFull.has(str(id)) ? pasted : offered).add(str(id))
  }
  const byScope = scopes.length > 0
  const byPack = deliveries.length > 0
  const method: Method = byScope && byPack ? 'both' : byScope ? 'scope' : byPack ? 'pack' : 'none'
  const used = [...new Set(turn.calls.flatMap((c) => usedOf(c, cat)))]
  const picks = core
    .filter((c) => c.name === `${CORE_PREFIX}use`)
    .map((c) => str(c.input.id))
    .filter(Boolean)
  const reports: Reported[] = []
  for (const sc of scopes) {
    if (sc.run === null) continue
    const r = reportOf(sc.chat, sc.run, events)
    if (r) reports.push(r)
  }
  const offeredList = [...offered]
  return {
    session: s.id,
    project: s.project,
    turn: index,
    at: new Date(turn.at).toISOString(),
    placement: placementOf(s, events),
    scopes,
    method,
    served: deliveries.length > 0,
    compliant: method !== 'none',
    used,
    offered: offeredList,
    picks,
    notTaken: offeredList.filter((o) => !used.includes(o)),
    usedNotOffered: used.filter((u) => !offered.has(u) && !pasted.has(u)),
    reports,
  }
}

function handoffsOf(
  dir: string,
  chatSessions: Map<string, Set<string>>,
  handoffsDir: string,
): Summary['handoffs'] {
  let chats = 0
  let handoffs = 0
  let kept = 0
  let lost = 0
  const multi: string[] = []
  for (const [chat, sessions] of chatSessions) {
    if (sessions.size < 2) continue
    chats++
    const n = sessions.size - 1
    handoffs += n
    multi.push(chat)
    if (existsSync(chatPaths(dir, chat).hydraMd)) kept += n
    else lost += n
  }
  let linkedFiles = 0
  if (multi.length > 0)
    for (const name of list(handoffsDir)) {
      if (!name.endsWith('.md')) continue
      const text = readFileSync(join(handoffsDir, name), 'utf8')
      if (multi.some((chat) => text.includes(chat))) linkedFiles++
    }
  return { chats, handoffs, kept, lost, linkedFiles }
}

function mean(xs: number[]): number {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0
}

function ratio(part: number, whole: number): number | null {
  return whole ? Math.round((part / whole) * 1000) / 1000 : null
}

function placementSummary(events: Json[]): Summary['placements'] {
  const one = (name: 'slot' | 'file'): PlacementSummary => {
    const mine = events.filter((e) => e.event === 'placement' && e.placement === name)
    const launches = mine.filter((e) => e.phase === 'launch')
    const reads = name === 'file' ? events.filter((e) => e.event === 'pack_read') : []
    return {
      launches: launches.length,
      messages: mine.length - launches.length,
      meanChars: mean(mine.map((e) => num(e.chars))),
      reuseRate: ratio(launches.filter((e) => e.reused === true).length, launches.length),
      readRate: ratio(reads.filter((e) => e.read === true).length, reads.length),
    }
  }
  return { slot: one('slot'), file: one('file') }
}

function packSummary(events: Json[]): Summary['packs'] {
  const packs = events.filter((e) => e.event === 'pack')
  const delta = packs.filter((e) => e.mode === 'delta')
  return {
    total: packs.length,
    first: packs.filter((e) => e.mode === 'first').length,
    delta: delta.length,
    emptyDelta: delta.filter((e) => {
      const ids = Array.isArray(e.ids) ? e.ids : []
      return ids.length === 0 || e.bytes === 0
    }).length,
    meanBytes: mean(packs.map((e) => num(e.bytes))),
    meanMs: mean(packs.map((e) => num(e.ms))),
  }
}

const isDelivery = (e: Json): boolean =>
  e.event === 'pack' || (e.event === 'placement' && e.phase === 'message')

/** Per entry, how often it was offered (pack, placement, shown, find) and taken (a pick answer, a core_use). */
function entrySummary(events: Json[]): Summary['entries'] {
  const offered = new Map<string, number>()
  const taken = new Map<string, number>()
  const add = (m: Map<string, number>, ids: Iterable<unknown>) => {
    for (const id of new Set(ids)) if (typeof id === 'string') m.set(id, (m.get(id) ?? 0) + 1)
  }
  for (const e of events) {
    if (
      (e.event === 'pack' || e.event === 'placement' || e.event === 'find') &&
      Array.isArray(e.ids)
    )
      add(offered, e.event === 'find' ? e.ids : e.ids.filter((id) => !pastedIn(e).has(str(id))))
    if (Array.isArray(e.shown)) {
      add(offered, e.shown)
      const tokens = str(e.answer)
        .split(/[\s,]+/)
        .filter(Boolean)
      if (/pick$/.test(str(e.step)) && tokens.every((t) => /^\d+$/.test(t) || ONE_ID.test(t))) {
        const shown = e.shown as unknown[]
        add(
          taken,
          tokens
            .map((t) => (/^\d+$/.test(t) ? shown[Number(t) - 1] : t))
            .filter((id) => typeof id === 'string' && ONE_ID.test(id)),
        )
      }
    }
    if (typeof e.id === 'string' && (MODES as readonly unknown[]).includes(e.mode))
      add(taken, [e.id])
  }
  const never = [...offered].filter(([id]) => !taken.has(id)).sort((a, b) => b[1] - a[1])
  return {
    offered: offered.size,
    taken: taken.size,
    neverTaken: never.length,
    notTaken: never.slice(0, NOT_TAKEN_SHOWN).map(([id, n]) => ({ id, offered: n })),
  }
}

function summarize(
  rows: Row[],
  sessions: Summary['sessions'],
  handoffs: Summary['handoffs'],
  onAt: number | null,
  now: number,
  events: Json[],
  delivered: Set<Json>,
): Summary {
  const methodCount = (m: Method): number => rows.filter((r) => r.method === m).length
  const runs = new Map<string, Scope>()
  for (const e of events)
    if (e.step === 'start' && typeof e.run === 'number')
      runs.set(`${str(e.chat)}#${e.run}`, { chat: str(e.chat), run: e.run, verdict: null })
  for (const e of events)
    if (e.step === 'end') {
      const sc = runs.get(`${str(e.chat)}#${e.run}`)
      if (sc) sc.verdict = str(e.verdict) || null
    }
  const scopes = [...runs.values()]
  const reported = new Map<string, Reported>()
  let noRun = 0
  for (const e of events) {
    if (e.event !== 'report') continue
    if (typeof e.run !== 'number') {
      noRun++
      continue
    }
    const r = reportOf(str(e.chat), e.run, [e])
    if (r) reported.set(`${r.chat}#${r.run}`, r)
  }
  const joined = [...runs.keys()].filter((k) => reported.has(k)).length
  const scores = [...reported.values()].map((r) => r.score).filter((x): x is number => x !== null)
  const picks = rows.flatMap((r) => r.picks)
  const deliveries = events.filter(isDelivery).length
  const compliant = rows.filter((r) => r.compliant).length
  return {
    builtAt: new Date(now).toISOString(),
    onAt: onAt === null ? null : new Date(onAt).toISOString(),
    sessions,
    turns: {
      total: rows.length,
      compliant,
      compliancePct: rows.length ? Math.round((compliant / rows.length) * 1000) / 10 : 0,
    },
    methods: {
      scope: methodCount('scope'),
      pack: methodCount('pack'),
      both: methodCount('both'),
      none: methodCount('none'),
    },
    scopes: {
      total: scopes.length,
      go: scopes.filter((s) => s.verdict === 'go').length,
      hydra: scopes.filter((s) => s.verdict === 'hydra').length,
      none: scopes.filter((s) => s.verdict === null).length,
    },
    packs: packSummary(events),
    placements: placementSummary(events),
    reports: {
      runs: runs.size,
      reported: joined,
      rate: runs.size ? Math.round((joined / runs.size) * 1000) / 1000 : 0,
      noRun,
      scored: scores.length,
      meanScore: scores.length
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
        : null,
    },
    deliveries: {
      total: deliveries,
      matched: delivered.size,
      noTurn: deliveries - delivered.size,
    },
    picks: { total: picks.length },
    entries: entrySummary(events),
    usedNotOffered: rows.reduce((n, r) => n + r.usedNotOffered.length, 0),
    missing: [...reported.values()]
      .filter((r) => r.missing)
      .map((r) => ({ chat: r.chat, run: r.run, text: r.missing ?? '' })),
    handoffs,
  }
}

export function buildTrack(
  dir: string,
  opts: TrackOptions = {},
): { rows: Row[]; summary: Summary } {
  const now = opts.now ?? Date.now()
  const onAt = mtimeOf(join(dir, 'ON'))
  // The last 30 days at most: the log rotates by month, and older months are not read.
  const since = Math.max(onAt ?? 0, now - MONTH)
  const events = readLog(dir, new Date(since)).events as Json[]
  const cat = [...loadCatalog(dir).entries.values()]
  const delivered = new Set<Json>()
  const files = transcripts(opts.roots ?? defaultRoots(), since)
  const sessions = { transcripts: files.length, workers: 0, noCore: 0, eligible: 0 }
  const rows: Row[] = []
  const chatSessions = new Map<string, Set<string>>()
  for (const { file, project } of files) {
    const s = parseSession(file, project)
    if (isWorker(s)) {
      sessions.workers++
      continue
    }
    const injected = events.some(
      (e) => (e.event === 'pack' || e.event === 'placement') && str(e.session) === s.id,
    )
    if (!injected && !s.turns.some((t) => t.calls.some((c) => c.name.startsWith(CORE_PREFIX)))) {
      sessions.noCore++
      continue
    }
    sessions.eligible++
    for (const [i, turn] of s.turns.entries())
      rows.push(turnRow(s, turn, i, events, cat, delivered))
    for (const turn of s.turns)
      for (const c of turn.calls) {
        const chat = str(c.input.chat)
        if (!CHAT_RE.test(chat) || !c.name.startsWith(CORE_PREFIX)) continue
        const set = chatSessions.get(chat) ?? new Set<string>()
        set.add(s.id)
        chatSessions.set(chat, set)
      }
  }
  // In the order the turns happened, not the order the folders list in (Linux and Windows list them differently).
  rows.sort((x, y) => x.at.localeCompare(y.at))
  const handoffs = handoffsOf(
    dir,
    chatSessions,
    opts.handoffsDir ?? join(homedir(), '.agenthydra', 'corch', 'handoffs'),
  )
  return { rows, summary: summarize(rows, sessions, handoffs, onAt, now, events, delivered) }
}

export function writeTrack(dir: string, opts: TrackOptions = {}): Summary {
  const { rows, summary } = buildTrack(dir, opts)
  const out = join(dir, 'track')
  mkdirSync(out, { recursive: true })
  writeFileSync(
    join(out, 'ledger.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
  )
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}

export function trackSummary(dir: string, now = Date.now(), opts: TrackOptions = {}): Summary {
  const file = join(dir, 'track', 'summary.json')
  const age = mtimeOf(file)
  if (age !== null && now - age < TEN_MINUTES)
    return JSON.parse(readFileSync(file, 'utf8')) as Summary
  return writeTrack(dir, { ...opts, now })
}

if (import.meta.main) {
  console.log(JSON.stringify(writeTrack(coreDir()), null, 2))
}
