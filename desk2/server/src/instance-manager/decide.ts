// The instance manager's judgment (shared/instance-manager.ts says what it is for). Pure: the engine (engine.ts)
// reads AgentHydra, hands what it read here, and carries out what comes back. Three questions live here and nowhere
// else: did an app go down with chats working in it (detect), why (causeOf, from its own log and its account), and
// which same-kind account should take the chats (rankTargets).

import type { DownCause, ManagedKind } from '@shared/instance-manager'

/** One app as AgentHydra reports it this look. */
export interface SeenInstance {
  ref: string
  kind: ManagedKind
  num: number
  name: string
  /** The Claude profile folder, or the Codex instance id: what the open and move calls take. */
  handle: string
  email: string | null
  plan: string | null
  running: boolean
  signedIn: boolean
}

/** A chat working right now, and the app it works in (its ref). */
export interface WorkingChat {
  id: string
  title: string
  ref: string
}

/** What the manager remembers of one app between looks. */
export interface Remembered {
  up: boolean
  lastUpAt: number | null
  /** The account's address while it was up: a signed-out app reads none, and its own account must still be told apart. */
  email?: string | null
  /** The chats that were working in it at the last look it was up, by id. */
  working: Record<string, string>
  seenAt: number
}

export type Memory = Record<string, Remembered>

/** An app that was up at the last look and is down now, with the chats it was running. */
export interface Down {
  instance: SeenInstance
  lastUpAt: number
  chats: WorkingChat[]
  /** Down because it closed (false: still running, but its account was signed out). */
  closed: boolean
}

/** A memory older than this says nothing about now: Desk was not running, so the moment an app went down is not
 *  known, and neither is what it was doing. Such an app only starts being remembered again. */
export const STALE_MEMORY_MS = 10 * 60_000

/** Up: running with its account signed in. */
export const isUp = (i: SeenInstance): boolean => i.running && i.signedIn

/**
 * Compares this look with the last one. Every app that was up and is not now, with chats working in it at the last
 * look, is a Down. The memory comes back updated: an app that is up remembers what works in it now; one that is down
 * keeps what it was running when it went (so a look that fails to act can find it again).
 */
export function detect(
  memory: Memory,
  seen: readonly SeenInstance[],
  working: readonly WorkingChat[],
  now: number,
): { memory: Memory; down: Down[] } {
  // An app AgentHydra did not list this time keeps what was known of it: a read that drops a row says nothing new.
  const next: Memory = { ...memory }
  const down: Down[] = []
  for (const inst of seen) {
    const before = memory[inst.ref]
    const fresh = before !== undefined && now - before.seenAt <= STALE_MEMORY_MS
    if (isUp(inst)) {
      const mine = working.filter((w) => w.ref === inst.ref)
      const email = inst.email ?? before?.email ?? null
      next[inst.ref] = { up: true, lastUpAt: now, email, working: Object.fromEntries(mine.map((w) => [w.id, w.title])), seenAt: now }
      continue
    }
    const email = inst.email ?? before?.email ?? null
    next[inst.ref] = { up: false, lastUpAt: before?.lastUpAt ?? null, email, working: before?.working ?? {}, seenAt: now }
    if (!fresh || !before.up) continue
    const chats = Object.entries(before.working).map(([id, title]) => ({ id, title, ref: inst.ref }))
    if (chats.length) down.push({ instance: { ...inst, email }, lastUpAt: before.lastUpAt ?? before.seenAt, chats, closed: !inst.running })
  }
  return { memory: next, down }
}

/** Claude Desktop's log lines: "2026-10-15 03:22:20 [info] beforeQuit: handler is ready for quit, so quitting". */
const LOG_LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\b/
const QUIT = /\b(beforeQuit|willQuit|before-quit|will-quit)\b/
// Only the lines a real sign-out writes (read from 12 profiles' logs, 2026-10-15). Claude Desktop also writes "User is
// logged out, skipping account ID wait" at every start before the account loads, and "invalid_grant" on a routine token
// refresh it recovers from; either would turn a person's clean quit into a sign-out.
const LOGGED_OUT =
  /(Login-state transition \(loggedOut: false\b|\bAccount logged out\b|synthesizing logged-out|\bOAuth token (has been |was )?revoked\b)/i
/** Signed in again after it: an earlier sign-out line no longer says anything. */
const LOGGED_IN = /Login-state transition \(loggedOut: true\b/i
const ACCOUNT_DEAD =
  /\b(organization (has been |is |was )?(disabled|suspended|deactivated)|account (has been |is |was )?(disabled|suspended|banned|deactivated)|subscription (has |is )?(expired|ended|lapsed|cancell?ed)|plan (has |is )?(expired|ended)|payment (failed|required)|billing (issue|problem))\b/i

/** A log line's own time, read as this PC's local time (the app writes local time), ms; null when it has none. */
export function lineTime(line: string): number | null {
  const m = LOG_LINE.exec(line)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

/**
 * Why an app went down, from the tail of its log: the lines written from a minute before it was last seen up.
 * A sign-out or a dead account in those lines wins; then a clean quit; a log that stops without either is a crash.
 * null when there is no log to read (the caller says unknown).
 */
export function causeFromLog(log: string | null, since: number): { cause: DownCause; detail: string } | null {
  if (log === null) return null
  const from = since - 60_000
  const lines = log.split(/\r?\n/).filter((l) => {
    const t = lineTime(l)
    return t !== null && t >= from
  })
  const dead = lines.findLast((l) => ACCOUNT_DEAD.test(l))
  if (dead) return { cause: 'account-dead', detail: `its log: ${clip(dead)}` }
  const outAt = lines.findLastIndex((l) => LOGGED_OUT.test(l))
  if (outAt >= 0 && outAt > lines.findLastIndex((l) => LOGGED_IN.test(l)))
    return { cause: 'logged-out', detail: `its log: ${clip(lines[outAt] as string)}` }
  const quit = lines.findLast((l) => QUIT.test(l))
  if (quit) return { cause: 'quit', detail: `it quit cleanly (${clip(quit)})` }
  return { cause: 'crashed', detail: lines.length ? 'its log stops without a quit' : 'its log has nothing since it was last seen up' }
}

/** What the account says now, as AgentHydra resolves it over the network. */
export interface AccountProbe {
  status: string // live | cache | offline | loggedout | unknown (AgentHydra's CMAccountStatus)
  plan: string | null
}

/**
 * The cause, from everything known: the app's sign-in (still running but signed out), the account probe, then its log.
 * A sign-out the app or the account shows beats what the log says; a plan that turned free beats a clean quit.
 */
export function causeOf(
  d: Pick<Down, 'closed' | 'lastUpAt'> & { instance: Pick<SeenInstance, 'signedIn' | 'plan' | 'kind'> },
  probe: AccountProbe | null,
  log: string | null,
): { cause: DownCause; detail: string } {
  if (!d.instance.signedIn) return { cause: 'logged-out', detail: 'its account is no longer signed in' }
  if (probe?.status === 'loggedout') return { cause: 'logged-out', detail: 'AgentHydra reads its account as signed out' }
  if (probe && /\bfree\b/i.test(probe.plan ?? '') && !/\bfree\b/i.test(d.instance.plan ?? 'free'))
    return { cause: 'account-dead', detail: `its plan is ${probe.plan} now (it was ${d.instance.plan})` }
  const fromLog = causeFromLog(log, d.lastUpAt)
  if (fromLog) return fromLog
  return { cause: 'unknown', detail: d.instance.kind === 'codex' ? 'the Codex app closed; it keeps no log to say why' : 'its log could not be read' }
}

/** The causes the manager acts on. A clean quit is a person's (or an update's, which brings the app straight back); an
 *  unknown cause may be one too, so it is left alone. A Codex app keeps no log: only its account (signed out, or a plan
 *  turned free) says it went down for a reason the manager acts on. */
export function acts(cause: DownCause): boolean {
  return cause !== 'quit' && cause !== 'unknown'
}

function clip(line: string): string {
  const t = line.replace(LOG_LINE, '').replace(/^\s*\[\w+\]\s*/, '').trim()
  return t.length > 140 ? `${t.slice(0, 139)}…` : t
}

/** A same-kind account that could take the chats, with its usage. */
export interface Candidate {
  instance: SeenInstance
  fiveHourPct: number | null
  weeklyPct: number | null
  /** The fleet's line (85) or the account's own lower one. */
  capPct: number
  /** The usage reading is real (AgentHydra's severity is not 'unknown'). */
  known: boolean
}

export interface Ranked {
  instance: SeenInstance
  tierX: number
  usedPct: number
  /** tierX x the room left on its tighter window: how much work it can still take, in Pro-sized windows. */
  room: number
}

/**
 * How much one percent of this plan is worth. Claude: Max 20x = 20, Max 5x = 5, Team = 2, Pro or unknown = 1.
 * Codex: Pro = 10, Pro Lite = 3, Team or Business = 2, Plus or unknown = 1. Only the digits of "Max N" are read, as the
 * '×' can arrive mojibaked.
 */
export function tierOf(kind: ManagedKind, plan: string | null): number {
  const p = (plan ?? '').toLowerCase()
  if (kind === 'desktop') {
    const m = /max\D*(\d+)/.exec(p)
    if (m) return Number(m[1])
    return /team|enterprise/.test(p) ? 2 : 1
  }
  if (/pro\s*lite|prolite/.test(p)) return 3
  if (/\bpro\b/.test(p)) return 10
  return /team|business|enterprise/.test(p) ? 2 : 1
}

/**
 * The same-kind accounts that may take the chats, best first. Never the app that went down, nor another app signed
 * into the same account (it is down with it). A reading of 'unknown' is not room; nor is a window at or past the
 * account's line. Best is the most room (tier x what is left of its tighter window: the highest plan with the most
 * left this week and this five hours); a running app wins a tie, so nothing is opened that need not be.
 */
export function rankTargets(down: SeenInstance, candidates: readonly Candidate[]): Ranked[] {
  const email = down.email?.toLowerCase() ?? null
  const ranked: Ranked[] = []
  for (const c of candidates) {
    const i = c.instance
    if (i.kind !== down.kind || i.ref === down.ref || !i.signedIn) continue
    if (email !== null && i.email?.toLowerCase() === email) continue
    if (!c.known) continue
    const windows = [c.fiveHourPct, c.weeklyPct].filter((p): p is number => typeof p === 'number')
    if (!windows.length) continue
    const usedPct = Math.max(...windows)
    if (usedPct >= c.capPct) continue
    const tierX = tierOf(i.kind, i.plan)
    ranked.push({ instance: i, tierX, usedPct, room: Math.round(tierX * (c.capPct - usedPct) * 10) / 10 })
  }
  return ranked.sort((a, b) => b.room - a.room || Number(b.instance.running) - Number(a.instance.running) || a.instance.num - b.instance.num)
}

/** The text a moved chat is started again with. */
export function resumeText(from: string, to: string, cause: DownCause, causeDetail: string, sender: string): string {
  const why =
    cause === 'logged-out'
      ? 'its account was signed out'
      : cause === 'account-dead'
        ? 'its account stopped working'
        : cause === 'crashed'
          ? 'the app crashed'
          : 'the app closed'
  return [
    `[${sender}] Not from the user.`,
    `Your app (${from}) went down while you were working: ${why} (${causeDetail}).`,
    `You were moved to ${to} and this message starts you again.`,
    'Any tool call that was running when the app went down was lost: check its result again before relying on it.',
    'Carry on with your task from where you left off.',
  ].join(' ')
}
