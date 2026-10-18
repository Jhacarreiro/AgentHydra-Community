import type { MergedTurn } from './collect'
import type { OpenTurn } from './store'
import { IDLE_FINAL_MS, type Outcome, type Picked } from './turns'

/** The playbook facets a turn falls under: the facet files it read, plus the one the judge filed it under
 *  (managers carry the playbook index in their prompt and seldom open a facet file, so the judge's call is
 *  usually the only one). */
export function facetsOf(t: Pick<MergedTurn, 'facetsRead' | 'judge'>): string[] {
  const facet = t.judge?.facet
  return facet && !t.facetsRead.includes(facet) ? [...t.facetsRead, facet] : t.facetsRead
}

export interface StatsOptions {
  now: number
  days: number | 'all'
  worst?: number
  manager?: string
  facet?: string
  open?: OpenTurn[]
  titles?: Map<string, string>
}

export interface WorstTurn {
  turn: string
  session: string
  deskChat: string | null
  title: string | null
  at: number
  outcome: Outcome
  judge: number | null
  signal: string | null
  why: string | null
}

export interface OpenRow {
  turn: string
  session: string
  deskChat: string | null
  title: string | null
  since: number
  idleMs: number
  working: boolean | null
}

export interface PickedCounts {
  jev: number
  keywords: number
  pinned: number
  atName: number
  continuation: number
  other: number
}

export interface FacetRow {
  facet: string
  turns: number
  judgeAvg: number | null
  correctionRate: number | null
}

export interface ManagerStats {
  turns: number
  responded: number
  responseRate: number | null
  outcomes: Partial<Record<Outcome, number>>
  firstP50Ms: number | null
  totalP50Ms: number | null
  totalP90Ms: number | null
  judgeAvg: number | null
  judged: number
  owner: {
    n: number
    praise: number
    correction: number
    complaint: number
    repeat: number
    keepGoing: number
    correctionRate: number | null
  }
  sub: { asks: number; unanswered: number }
  workers: { dispatched: number; pass: number; fail: number; unjudged: number }
  tokens: { in: number; out: number; cacheRead: number; cacheWrite: number }
  costUsd: number | null
  facets: FacetRow[]
  picked: PickedCounts
  /** Turns still open now; `stuckNow` counts those busy in Desk and idle 30 min or more (they finalize as stuck at 60). */
  open: number
  stuckNow: number
  openTurns: OpenRow[]
  worst: WorstTurn[]
  line: string
}

export interface StatsAnswer {
  v: 1
  at: number
  days: number | 'all'
  managers: Record<string, ManagerStats>
}

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null

const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10)

function bucketOf(p: Picked | null): keyof PickedCounts {
  if (!p) return 'other'
  if (p.source === 'jev') return 'jev'
  if (p.source === 'keywords') return 'keywords'
  if (p.source === 'desk-pin' || (p.source === 'router' && /pinned/i.test(p.why))) return 'pinned'
  if (p.source === 'at-name') return 'atName'
  if (p.source === 'continuation') return 'continuation'
  return 'other'
}

function statsFor(
  turns: MergedTurn[],
  open: OpenTurn[],
  opts: { worst: number; titles: Map<string, string>; now: number },
): ManagerStats {
  const n = turns.length
  const picked: PickedCounts = {
    jev: 0,
    keywords: 0,
    pinned: 0,
    atName: 0,
    continuation: 0,
    other: 0,
  }
  for (const t of turns) picked[bucketOf(t.picked)] += 1
  const openTurns: OpenRow[] = open
    .map((o) => ({
      turn: o.turn,
      session: o.session,
      deskChat: o.deskChat,
      title: o.deskChat ? (opts.titles.get(o.deskChat) ?? null) : null,
      since: o.since,
      idleMs: opts.now - o.lastTs,
      working: o.working,
    }))
    .sort((a, b) => b.idleMs - a.idleMs)
  const responded = turns.filter((t) => t.outcome === 'replied').length
  const outcomes: Partial<Record<Outcome, number>> = {}
  for (const t of turns) outcomes[t.outcome] = (outcomes[t.outcome] ?? 0) + 1

  const ownerSignals = turns.flatMap((t) => t.signals.filter((s) => s.from === 'owner'))
  const count = (label: string) => ownerSignals.filter((s) => s.label === label).length
  const correction = count('correction')
  const owner = {
    n: ownerSignals.length,
    praise: count('praise'),
    correction,
    complaint: count('complaint'),
    repeat: count('repeat'),
    keepGoing: count('keep_going'),
    correctionRate: ownerSignals.length ? correction / ownerSignals.length : null,
  }

  const judged = turns
    .filter((t) => t.judge)
    .map((t) => (t.judge as NonNullable<MergedTurn['judge']>).score)
  const workerIds = new Set(turns.flatMap((t) => t.workers))
  const lastVerdict = new Map<string, 'pass' | 'fail'>()
  for (const t of turns) {
    for (const v of [...t.verdicts].sort((a, b) => a.at - b.at))
      lastVerdict.set(v.worker, v.verdict)
  }
  const verdicts = [...workerIds]
    .map((w) => lastVerdict.get(w))
    .filter((v): v is 'pass' | 'fail' => !!v)
  const tokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }
  for (const t of turns) {
    tokens.in += t.tokens.in
    tokens.out += t.tokens.out
    tokens.cacheRead += t.tokens.cacheRead
    tokens.cacheWrite += t.tokens.cacheWrite
  }
  const costs = turns.map((t) => t.costUsd).filter((c): c is number => c !== null)

  const facetNames = new Set(turns.flatMap(facetsOf))
  const facets: FacetRow[] = [...facetNames].sort().map((facet) => {
    const ts = turns.filter((t) => facetsOf(t).includes(facet))
    const sig = ts.flatMap((t) => t.signals.filter((s) => s.from === 'owner'))
    const judgedHere = ts
      .filter((t) => t.judge)
      .map((t) => (t.judge as NonNullable<MergedTurn['judge']>).score)
    return {
      facet,
      turns: ts.length,
      judgeAvg: round1(mean(judgedHere)),
      correctionRate: sig.length
        ? sig.filter((s) => s.label === 'correction').length / sig.length
        : null,
    }
  })

  const worst: WorstTurn[] = [...turns]
    .sort((a, b) => {
      const sa = a.judge?.score ?? (a.outcome === 'replied' ? 10 : 3)
      const sb = b.judge?.score ?? (b.outcome === 'replied' ? 10 : 3)
      return sa - sb || b.start - a.start
    })
    .slice(0, opts.worst)
    .map((t) => {
      const next = t.signals.find((s) => s.from === 'owner')
      return {
        turn: t.id,
        session: t.session,
        deskChat: t.deskChat,
        title: t.deskChat ? (opts.titles.get(t.deskChat) ?? null) : null,
        at: t.start,
        outcome: t.outcome,
        judge: t.judge?.score ?? null,
        signal: next?.label ?? null,
        why: t.judge?.why ?? t.error,
      }
    })

  const judgeAvg = round1(mean(judged))
  const pct = n ? Math.round((responded / n) * 100) : null
  const line = [
    `${n} turns`,
    pct === null ? null : `${pct}% answered`,
    judgeAvg === null ? null : `judge ${judgeAvg.toFixed(1)}`,
    `${correction} correction${correction === 1 ? '' : 's'}`,
  ]
    .filter((x) => x !== null)
    .join(' · ')

  return {
    turns: n,
    responded,
    responseRate: n ? responded / n : null,
    outcomes,
    firstP50Ms: percentile(
      turns.flatMap((t) => (t.firstMs === null ? [] : [t.firstMs])),
      0.5,
    ),
    totalP50Ms: percentile(
      turns.map((t) => t.totalMs),
      0.5,
    ),
    totalP90Ms: percentile(
      turns.map((t) => t.totalMs),
      0.9,
    ),
    judgeAvg,
    judged: judged.length,
    owner,
    sub: {
      asks: turns.reduce((a, t) => a + t.sub.asks, 0),
      unanswered: turns.reduce((a, t) => a + t.sub.unanswered, 0),
    },
    workers: {
      dispatched: workerIds.size,
      pass: verdicts.filter((v) => v === 'pass').length,
      fail: verdicts.filter((v) => v === 'fail').length,
      unjudged: workerIds.size - verdicts.length,
    },
    tokens,
    costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    facets,
    picked,
    open: openTurns.length,
    stuckNow: openTurns.filter((r) => r.working === true && r.idleMs >= IDLE_FINAL_MS).length,
    openTurns,
    worst,
    line,
  }
}

/** The manager_stats answer, computed from the merged turn records; the same shape is written to summary.json. */
export function buildStats(all: Map<string, MergedTurn>, opts: StatsOptions): StatsAnswer {
  const since = opts.days === 'all' ? -Infinity : opts.now - opts.days * 86_400_000
  const turns = [...all.values()].filter((t) => t.start >= since)
  const worstN = opts.worst ?? 5
  const titles = opts.titles ?? new Map<string, string>()
  const bySlug = new Map<string, MergedTurn[]>()
  for (const t of turns) {
    if (opts.manager && t.manager !== opts.manager) continue
    if (opts.facet && !facetsOf(t).includes(opts.facet)) continue
    const list = bySlug.get(t.manager) ?? []
    list.push(t)
    bySlug.set(t.manager, list)
  }
  const openBySlug = new Map<string, OpenTurn[]>()
  for (const o of opts.open ?? []) {
    if (opts.manager && o.manager !== opts.manager) continue
    const list = openBySlug.get(o.manager) ?? []
    list.push(o)
    openBySlug.set(o.manager, list)
  }
  const managers: Record<string, ManagerStats> = {}
  for (const slug of [...new Set([...bySlug.keys(), ...openBySlug.keys()])].sort()) {
    managers[slug] = statsFor(bySlug.get(slug) ?? [], openBySlug.get(slug) ?? [], {
      worst: worstN,
      titles,
      now: opts.now,
    })
  }
  return { v: 1, at: opts.now, days: opts.days, managers }
}
