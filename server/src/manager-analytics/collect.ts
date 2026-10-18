import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliMayteVerdict } from '../climayte-scorecard'
import { CONFIG_DIR } from '../config'
import { findTranscriptAsync } from '../transcript'
import type { SignalLabel } from './signal'
import { buildStats } from './stats'
import {
  appendJsonl,
  type CollectState,
  managersDir,
  type OpenTurn,
  ROUTES_FILE,
  readJsonl,
  readState,
  STATE_FILE,
  SUMMARY_FILE,
  TURNS_FILE,
  writeJsonAtomic,
} from './store'
import {
  IDLE_FINAL_MS,
  type JudgeRecord,
  type Picked,
  promptOf,
  readLineAt,
  readLinesFrom,
  type SignalRecord,
  type TurnRecord,
  type VerdictRecord,
  walkTranscript,
} from './turns'

const PATH_RELOOK_MS = 10 * 60_000

/** Desk chats run under `<CONFIG_DIR>/cli-instances/<id>/projects/<cwd>/<session>.jsonl` (the root core/cli-instances.ts owns). */
function findInDeskInstances(session: string): string | null {
  const root = join(CONFIG_DIR, 'cli-instances')
  let best: { path: string; mtime: number } | null = null
  try {
    for (const inst of readdirSync(root, { withFileTypes: true })) {
      if (!inst.isDirectory()) continue
      const projects = join(root, inst.name, 'projects')
      if (!existsSync(projects)) continue
      for (const proj of readdirSync(projects, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue
        const p = join(projects, proj.name, `${session}.jsonl`)
        if (!existsSync(p)) continue
        const mtime = statSync(p).mtimeMs
        if (!best || mtime > best.mtime) best = { path: p, mtime }
      }
    }
  } catch {
    return best?.path ?? null
  }
  return best?.path ?? null
}

export type MergedTurn = TurnRecord & {
  signals: SignalRecord[]
  verdicts: VerdictRecord[]
  judge: JudgeRecord | null
}

export interface RouteEntry {
  at: number
  session: string
  manager: string
  picked: Picked
  deskChat: string | null
  transcriptPath: string | null
}

export interface DeskRow {
  id: string
  parentId: string | null
  managerSlug: string | null
  title: string | null
}

export interface PassOptions {
  now?: number
  dry?: boolean
  /** Verdicts a CliMayte worker has received; the daemon supplies them, the CLI does not. */
  verdictsOf?: (worker: string) => CliMayteVerdict[] | undefined
  deskBase?: string
  desk?: Map<string, DeskRow>
}

export interface PassResult {
  turns: TurnRecord[]
  signals: SignalRecord[]
  verdicts: VerdictRecord[]
  sessions: number
  state: CollectState
  all: Map<string, MergedTurn>
  titles: Map<string, string>
}

export function mergeTurns(rows: Array<Record<string, unknown>>): Map<string, MergedTurn> {
  const out = new Map<string, MergedTurn>()
  for (const r of rows) {
    if (r.type === 'turn') {
      const id = r.id as string
      const prev = out.get(id)
      out.set(id, {
        ...(r as unknown as TurnRecord),
        signals: prev?.signals ?? [],
        verdicts: prev?.verdicts ?? [],
        judge: prev?.judge ?? null,
      })
    }
  }
  for (const r of rows) {
    const t = out.get(r.turn as string)
    if (!t) continue
    if (r.type === 'signal') t.signals.push(r as unknown as SignalRecord)
    else if (r.type === 'verdict') t.verdicts.push(r as unknown as VerdictRecord)
    else if (r.type === 'judge') t.judge = r as unknown as JudgeRecord
  }
  return out
}

export function loadMerged(): Map<string, MergedTurn> {
  return mergeTurns(readJsonl(TURNS_FILE))
}

const ROUTER_LOG_LINE = /^(\S+) session=(\S+) manager=(\S+) (SWAP|stay) \(([^)]*)\) source=(\S+)/

/** router.log lines for sessions routed before routes.jsonl existed. */
export function parseRouterLog(text: string): RouteEntry[] {
  const out: RouteEntry[] = []
  for (const line of text.split('\n')) {
    const m = ROUTER_LOG_LINE.exec(line)
    if (!m) continue
    const at = Date.parse(m[1])
    if (!Number.isFinite(at)) continue
    const p = /\bp=([\d.]+)/.exec(m[5])
    out.push({
      at,
      session: m[2],
      manager: m[3],
      picked: {
        decision: m[4] === 'SWAP' ? 'swap' : 'stay',
        source: m[6],
        why: m[5].replace(/\s*p=[\d.]+/, '').trim(),
        p: p ? Number(p[1]) : null,
      },
      deskChat: null,
      transcriptPath: null,
    })
  }
  return out
}

function readRoutes(): RouteEntry[] {
  return readJsonl<Record<string, unknown>>(ROUTES_FILE)
    .filter(
      (r) =>
        typeof r.session === 'string' && typeof r.manager === 'string' && typeof r.at === 'string',
    )
    .map(
      (r): RouteEntry => ({
        at: Date.parse(r.at as string),
        session: r.session as string,
        manager: r.manager as string,
        picked: {
          decision: r.decision === 'swap' ? 'swap' : 'stay',
          source: typeof r.source === 'string' ? r.source : 'unknown',
          why: typeof r.why === 'string' ? r.why : '',
          p: typeof r.p === 'number' ? r.p : null,
        },
        deskChat: typeof r.deskChat === 'string' ? r.deskChat : null,
        transcriptPath: typeof r.transcriptPath === 'string' ? r.transcriptPath : null,
      }),
    )
    .filter((r) => Number.isFinite(r.at))
}

interface SessionFile {
  manager?: string
  transcriptPath?: string
}

function readSessionFiles(): Map<string, SessionFile> {
  const dir = join(managersDir(), 'sessions')
  const out = new Map<string, SessionFile>()
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      out.set(f.slice(0, -5), JSON.parse(readFileSync(join(dir, f), 'utf8')) as SessionFile)
    } catch {
      // An unreadable session file contributes nothing; its routes still count.
    }
  }
  return out
}

/** Desk chats by Claude session id. Read-only: the Desk store is never written here. */
export function readDeskIndex(): Map<string, DeskRow> {
  const home = process.env.HYDRA_DESK_HOME || join(homedir(), '.hydra-desk-2')
  const file = join(home, 'chats.json')
  const out = new Map<string, DeskRow>()
  if (!existsSync(file)) return out
  try {
    const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
    for (const r of rows) {
      if (typeof r.sessionId !== 'string' || typeof r.id !== 'string') continue
      out.set(r.sessionId, {
        id: r.id,
        parentId: typeof r.parentId === 'string' ? r.parentId : null,
        managerSlug: typeof r.managerSlug === 'string' ? r.managerSlug : null,
        title: typeof r.title === 'string' ? r.title : null,
      })
    }
  } catch {
    // A Desk store that cannot be read leaves every chat owner-level.
  }
  return out
}

export function titlesOf(desk: Map<string, DeskRow>): Map<string, string> {
  const out = new Map<string, string>()
  for (const row of desk.values()) if (row.title) out.set(row.id, row.title)
  return out
}

export function openTurnsOf(state: CollectState): OpenTurn[] {
  return Object.values(state.transcripts).flatMap((t) => (t.open ? [t.open] : []))
}

const DESK_CHECK_MS = 3000

/** Busy (working or starting) by Desk chat id; null when the Desk does not answer in time. */
async function deskBusy(base: string): Promise<Map<string, boolean> | null> {
  const res = await fetch(`${base}/api/chats`, {
    signal: AbortSignal.timeout(DESK_CHECK_MS),
  }).catch(() => null)
  if (!res?.ok) return null
  const chats: unknown = await res.json().catch(() => null)
  if (!Array.isArray(chats)) return null
  const busy = new Map<string, boolean>()
  for (const c of chats as Array<{ id?: unknown; status?: unknown }>) {
    if (typeof c.id === 'string') busy.set(c.id, c.status === 'working' || c.status === 'starting')
  }
  return busy
}

const deskBaseUrl = () => `http://127.0.0.1:${Number(process.env.HYDRA_DESK_PORT) || 7798}`

const PICK_WINDOW_MS = 60_000

function pickerFor(
  entries: RouteEntry[],
  sessionFile: SessionFile | undefined,
  desk: DeskRow | undefined,
) {
  const sorted = [...entries].sort((a, b) => a.at - b.at)
  return (promptTs: number): { manager: string; picked: Picked | null } | null => {
    const near = sorted.filter((e) => e.at <= promptTs && promptTs - e.at <= PICK_WINDOW_MS).pop()
    const before = near ?? sorted.filter((e) => e.at <= promptTs).pop() ?? sorted[0]
    if (before) return { manager: before.manager, picked: before.picked }
    if (sessionFile?.manager) return { manager: sessionFile.manager, picked: null }
    if (desk?.managerSlug) {
      return {
        manager: desk.managerSlug,
        picked: { decision: 'stay', source: 'desk-pin', why: 'pinned in Desk', p: null },
      }
    }
    return null
  }
}

export async function collectPass(opts: PassOptions = {}): Promise<PassResult> {
  const now = opts.now ?? Date.now()
  const state = readState()
  const desk = opts.desk ?? readDeskIndex()
  const routes = readRoutes()
  const routerLogPath = join(managersDir(), 'router.log')
  const routerLog = existsSync(routerLogPath)
    ? parseRouterLog(readFileSync(routerLogPath, 'utf8'))
    : []
  const sessionFiles = readSessionFiles()
  const byRoute = new Map<string, RouteEntry[]>()
  for (const e of [...routes, ...routerLog]) {
    const list = byRoute.get(e.session) ?? []
    list.push(e)
    byRoute.set(e.session, list)
  }
  const sessions = new Set<string>([...byRoute.keys(), ...sessionFiles.keys()])
  const merged = loadMerged()
  const existingIds = new Set(merged.keys())
  const checkDesk = openTurnsOf(state).some((o) => now - o.lastTs >= IDLE_FINAL_MS)
  const busy = checkDesk ? await deskBusy(opts.deskBase ?? deskBaseUrl()) : null
  const live = (deskChat: string) => (busy ? (busy.get(deskChat) ?? false) : null)

  const newTurns: TurnRecord[] = []
  const newSignals: SignalRecord[] = []
  for (const session of sessions) {
    const row = desk.get(session)
    const sf = sessionFiles.get(session)
    const entries = byRoute.get(session) ?? []
    const kept = state.transcripts[session]
    let pathLookedAt = kept?.pathLookedAt
    let path: string | null =
      [...entries].reverse().find((e) => e.transcriptPath)?.transcriptPath ??
      sf?.transcriptPath ??
      null
    if (!path || !existsSync(path)) {
      path = kept?.path && existsSync(kept.path) ? kept.path : null
      const quiet = path ? now - statSync(path).mtimeMs >= PATH_RELOOK_MS : true
      if (quiet && now - (pathLookedAt ?? 0) >= PATH_RELOOK_MS) {
        pathLookedAt = now
        path = (await findTranscriptAsync(session))?.path ?? findInDeskInstances(session) ?? path
      }
    }
    if (!path || !existsSync(path)) continue
    const cur = kept ?? { path, cursor: 0, prevTurn: null }
    if (cur.path !== path) {
      // A different file: its offsets are not ours.
      cur.path = path
      cur.cursor = 0
      cur.prevTurn = null
      cur.lastPrompt = null
      cur.open = null
    }
    const { lines, endOffset } = await readLinesFrom(path, cur.cursor)
    const seedLine = cur.lastPrompt == null ? null : await readLineAt(path, cur.lastPrompt)
    const seedText = seedLine ? promptOf(seedLine)?.text : undefined
    const walk = walkTranscript(
      lines,
      endOffset,
      {
        session,
        managersDir: managersDir(),
        deskChat: row?.id ?? null,
        parentChat: row?.parentId ?? null,
        pick: pickerFor(entries, sf, row),
        live,
        now,
      },
      cur.prevTurn,
      seedText ? [seedText] : [],
    )
    for (const t of walk.finals) if (!existingIds.has(t.id)) newTurns.push(t)
    for (const s of walk.signals) {
      newSignals.push({
        v: 1,
        type: 'signal',
        turn: s.turn,
        from: s.from,
        label: s.label as SignalLabel,
        rule: s.rule,
        at: s.at,
      })
    }
    state.transcripts[session] = {
      path,
      cursor: walk.cursor,
      prevTurn: walk.pending,
      lastPrompt: walk.lastPrompt ?? cur.lastPrompt ?? null,
      open: walk.open,
      pathLookedAt,
    }
  }
  state.lastPassAt = now

  const turnsAll = new Map<string, MergedTurn>(merged)
  for (const t of newTurns) turnsAll.set(t.id, { ...t, signals: [], verdicts: [], judge: null })
  for (const s of newSignals) turnsAll.get(s.turn)?.signals.push(s)

  const newVerdicts: VerdictRecord[] = []
  if (opts.verdictsOf) {
    const seen = new Set<string>()
    for (const t of turnsAll.values()) {
      for (const v of t.verdicts) seen.add(`${t.id}|${v.worker}|${v.at}`)
    }
    for (const t of turnsAll.values()) {
      for (const worker of t.workers) {
        for (const v of opts.verdictsOf(worker) ?? []) {
          const key = `${t.id}|${worker}|${v.at}`
          if (seen.has(key)) continue
          seen.add(key)
          const rec: VerdictRecord = {
            v: 1,
            type: 'verdict',
            turn: t.id,
            worker,
            verdict: v.verdict,
            at: v.at,
          }
          newVerdicts.push(rec)
          t.verdicts.push(rec)
        }
      }
    }
  }

  return {
    turns: newTurns,
    signals: newSignals,
    verdicts: newVerdicts,
    sessions: sessions.size,
    state,
    all: turnsAll,
    titles: titlesOf(desk),
  }
}

export interface PassReport extends Omit<PassResult, 'all' | 'titles'> {
  summary: ReturnType<typeof buildStats>
}

/** One collector pass. Dry runs compute the same answer and write nothing. */
export async function runPass(
  opts: PassOptions & { days?: number | 'all' } = {},
): Promise<PassReport> {
  const { all, titles, ...result } = await collectPass(opts)
  if (!opts.dry) {
    appendJsonl(TURNS_FILE, [...result.turns, ...result.signals, ...result.verdicts])
    writeJsonAtomic(STATE_FILE, result.state)
  }
  const summary = buildStats(all, {
    now: opts.now ?? Date.now(),
    days: opts.days ?? 7,
    worst: 5,
    open: openTurnsOf(result.state),
    titles,
  })
  if (!opts.dry) writeJsonAtomic(SUMMARY_FILE, summary)
  return { ...result, summary }
}

const PASS_EVERY_MS = 60_000
const FIRST_PASS_MS = 30_000

/** Daemon timer: first pass 30 s after boot, then every 60 s; a pass that is still running is not overlapped. */
export function startManagerAnalytics(verdictsOf: PassOptions['verdictsOf']): void {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await runPass({ verdictsOf })
    } catch (e) {
      console.error(`[manager-analytics] pass failed: ${(e as Error).message}`)
    } finally {
      running = false
    }
  }
  setTimeout(() => {
    tick()
    setInterval(tick, PASS_EVERY_MS)
  }, FIRST_PASS_MS)
}
