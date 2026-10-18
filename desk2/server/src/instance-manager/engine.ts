// The instance manager's hands (shared/instance-manager.ts says what it is for; decide.ts judges). One look reads
// every app and what works in it, notices an app that went down with chats working in it, and moves each recovery
// one step: wait a moment for the app to come back by itself, find out why it went down, choose the same-kind
// account with the most room, open it, move the chats there with AgentHydra's own move (which starts each one again
// with a note), then watch that each one really runs. Every step is taken again on the next look until it is done,
// so a Desk restart in the middle resumes where it stopped (the plugin saves this state after every look).

import type {
  InstanceManagerStatus,
  ManagedInstance,
  ManagedKind,
  RecoveredChat,
  Recovery,
} from '@shared/instance-manager'
import { INSTANCE_MANAGER_EVERY_MS, INSTANCE_MANAGER_FROM } from '@shared/instance-manager'
import {
  type AccountProbe,
  acts,
  type Candidate,
  causeOf,
  detect,
  type Down,
  isUp,
  type Memory,
  rankTargets,
  resumeText,
  type SeenInstance,
  type WorkingChat,
} from './decide'

/** What one chat's move came to. `newId` is a Codex chat's id in its new account (a Claude chat keeps its own). */
export interface MoveResult {
  id: string
  landed: boolean
  /** It was started again in its new app (AgentHydra delivered the note into it). */
  resumed: boolean
  detail: string
  newId?: string
}

/** One chat as its new app holds it. */
export interface Landed {
  archived: boolean
  /** It wrote something after `since`: it runs. */
  activeSince: boolean
}

/** Everything the manager reads and does, so tests can stand in for AgentHydra. */
export interface InstanceManagerIO {
  /** Every Claude Desktop and Codex app AgentHydra manages; null when AgentHydra did not answer. */
  instances(): Promise<SeenInstance[] | null>
  /** The chats working now in those apps; null when the list did not load. */
  working(seen: readonly SeenInstance[]): Promise<WorkingChat[] | null>
  /** The same-kind accounts with their usage, to choose where chats go. */
  candidates(kind: ManagedKind, seen: readonly SeenInstance[]): Promise<Candidate[]>
  /** What the account answers now, over the network; null when it could not be asked. */
  probe(inst: SeenInstance): Promise<AccountProbe | null>
  /** The tail of the app's own log; null when it keeps none the manager can read. */
  appLog(inst: SeenInstance): Promise<string | null>
  /** Opens the app (without taking focus). */
  open(inst: SeenInstance): Promise<{ ok: boolean; detail: string }>
  /** Starts moving the chats. A Claude move runs in AgentHydra and answers an operation to poll; a Codex move answers
   *  its results at once. `busy` is a refusal that clears by itself (another move holds AgentHydra's route). */
  startMove(
    from: SeenInstance,
    to: SeenInstance,
    ids: string[],
    text: string,
    key: string,
    terminateLive: boolean,
  ): Promise<{ operationId: string } | { results: MoveResult[] } | { error: string; busy?: boolean }>
  /** A started move: null while it runs. */
  moveResult(operationId: string): Promise<{ results: MoveResult[] } | { error: string } | null>
  /** The chats in an app, by id; null when the list did not load. */
  chatsIn(inst: SeenInstance, ids: readonly string[], since: number): Promise<Map<string, Landed> | null>
  now(): number
}

/** An app that goes down is given this long to come back by itself before anything is moved. */
export const GRACE_MS = 45_000
/** An app being opened that is not up after this is passed over for the next account. */
export const OPEN_TIMEOUT_MS = 3 * 60_000
/** A freshly opened app is given this long, once up, before chats are moved into it. */
export const OPEN_SETTLE_MS = 15_000
/** A move still running after this is called failed (AgentHydra's own batch deadline is longer per chat). */
export const MOVE_TIMEOUT_MS = 45 * 60_000
/** A moved chat not seen running this long after its move is stuck: a person should look. */
export const WATCH_MS = 10 * 60_000
/** With no account that has room, it keeps looking this long, then gives up. */
export const NO_ROOM_MS = 60 * 60_000
/** More apps than this going down within one grace is the PC or a person (a restart, a quit-all), never one account. */
export const MAX_DOWN_AT_ONCE = 2
/** A judgment that would leave the chats is not made on a read that failed: the reads are tried again this long. */
export const READ_RETRY_MS = 2 * 60_000
/** Apps opened for one recovery (its own opens and ones it waited on for another) before it gives up: never a loop. */
export const MAX_OPENS = 2
/** Accounts one recovery tries (opened or refused to open) before it gives up. */
export const MAX_TRIES = 3
/** Settled recoveries kept for the page; one still under way is always kept. */
export const RECOVERIES_KEPT = 30

/** A recovery as the manager tracks it: what the page shows, plus where its steps stand. */
export interface Tracked extends Recovery {
  fromInstance: SeenInstance
  toInstance: SeenInstance | null
  /** Accounts already tried and passed over (did not open). */
  passed: string[]
  /** Apps opened for it so far (MAX_OPENS). */
  opens?: number
  openedAt?: number
  upSince?: number
  operationId?: string
  movedAt?: number
  /** A Codex chat's id in its new account, by its old id. */
  newIds: Record<string, string>
}

export interface Saved {
  memory: Memory
  recoveries: Tracked[]
}

const SETTLED: readonly Recovery['state'][] = ['came-back', 'left', 'done', 'failed']

export const settled = (r: Recovery): boolean => SETTLED.includes(r.state)

/** The page's shape of a tracked recovery. */
export function shown(r: Tracked): Recovery {
  return {
    id: r.id,
    kind: r.kind,
    from: r.from,
    to: r.to,
    cause: r.cause,
    causeDetail: r.causeDetail,
    state: r.state,
    detail: r.detail,
    at: r.at,
    updatedAt: r.updatedAt,
    chats: r.chats.map((c) => ({ ...c })),
  }
}

const label = (i: SeenInstance): string => `#${i.num} ${i.name}`
const place = (i: SeenInstance) => ({ ref: i.ref, num: i.num, name: i.name })
/** Still in its first wait: its cause is not judged yet. */
const unjudged = (r: Tracked): boolean => r.state === 'waiting' && r.cause === 'unknown' && r.causeDetail === ''
const SEVERAL = 'several apps went down at once: that is the PC or a person, not one account, so nothing was moved'

export interface InstanceManager {
  look(enabled: boolean): Promise<void>
  status(enabled: boolean, nextCheckAt: number | null): InstanceManagerStatus
  saved(): Saved
}

export function createInstanceManager(io: InstanceManagerIO, initial: Saved): InstanceManager {
  let memory: Memory = initial.memory
  let recoveries: Tracked[] = initial.recoveries
  let seen: SeenInstance[] = []
  let working: WorkingChat[] = []
  let checkedAt: number | null = null
  let lastError: string | null = null

  function change(r: Tracked, state: Recovery['state'], detail: string): void {
    r.state = state
    r.detail = detail
    r.updatedAt = io.now()
  }

  function setChat(r: Tracked, id: string, state: RecoveredChat['state'], detail: string): void {
    const c = r.chats.find((x) => x.id === id)
    if (c) {
      c.state = state
      c.detail = detail
      r.updatedAt = io.now()
    }
  }

  /** A chat already in a recovery that is still under way is not taken into a second one. */
  function inFlight(id: string): boolean {
    return recoveries.some((r) => !settled(r) && r.chats.some((c) => c.id === id))
  }

  function begin(d: Down, now: number, alone: boolean, enabled: boolean): void {
    const chats = d.chats.filter((c) => !inFlight(c.id))
    if (!chats.length) return
    const r: Tracked = {
      id: `${d.instance.ref}@${now}`,
      kind: d.instance.kind,
      from: place(d.instance),
      to: null,
      cause: 'unknown',
      causeDetail: '',
      state: 'waiting',
      detail: d.closed ? 'the app closed; giving it a moment to come back by itself' : 'its account was signed out; giving it a moment',
      at: now,
      updatedAt: now,
      chats: chats.map((c) => ({ id: c.id, title: c.title, state: 'pending', detail: 'was working when the app went down' })),
      fromInstance: d.instance,
      toInstance: null,
      passed: [],
      newIds: {},
    }
    if (!alone) change(r, 'left', SEVERAL)
    else if (!enabled) change(r, 'left', 'the instance manager was off, so nothing was moved')
    recoveries.unshift(r)
  }

  /** Chooses the account to take the chats and opens it, or moves straight in when it is already up. */
  async function choose(r: Tracked, now: number): Promise<void> {
    if (r.passed.length >= MAX_TRIES) {
      change(r, 'failed', `${r.passed.length} accounts were tried and none took the chats; they stay where they were for a person`)
      return
    }
    const candidates = await io.candidates(r.kind, seen)
    const ranked = rankTargets(r.fromInstance, candidates).filter((t) => !r.passed.includes(t.instance.ref))
    const best = ranked[0]
    if (!best) {
      if (now - r.at >= NO_ROOM_MS) change(r, 'failed', `no ${kindName(r.kind)} account had room for an hour; the chats stay where they were`)
      else change(r, 'waiting', `no ${kindName(r.kind)} account has room now; it looks again`)
      return
    }
    const to = best.instance
    if (!isUp(to) && (r.opens ?? 0) >= MAX_OPENS) {
      change(r, 'failed', `${r.opens} accounts were opened for these chats and none came up; they stay where they were for a person`)
      return
    }
    r.toInstance = to
    r.to = { ...place(to), opened: false }
    if (isUp(to)) {
      await startMove(r)
      return
    }
    // Another recovery is opening the same app: wait for that one rather than opening it twice.
    const other = recoveries.find((o) => o !== r && o.state === 'opening' && o.toInstance?.ref === to.ref)
    const opened = other ? { ok: true, detail: '' } : await io.open(to)
    if (!opened.ok) {
      r.passed.push(to.ref)
      change(r, 'waiting', `${label(to)} did not open (${opened.detail}); the next account is tried`)
      return
    }
    r.to.opened = true
    r.opens = (r.opens ?? 0) + 1
    r.openedAt = other?.openedAt ?? io.now()
    r.upSince = undefined
    change(r, 'opening', `opening ${label(to)} (${best.instance.plan ?? 'plan unknown'}, ${best.usedPct}% used)`)
  }

  async function startMove(r: Tracked): Promise<void> {
    const to = r.toInstance
    if (!to) return
    const ids = r.chats.filter((c) => c.state === 'pending').map((c) => c.id)
    if (!ids.length) {
      change(r, 'done', 'no chat was left to move')
      return
    }
    const from = seen.find((i) => i.ref === r.fromInstance.ref) ?? r.fromInstance
    if (isUp(from)) {
      change(r, 'came-back', `${label(from)} came back by itself before the move; its chats are where they were`)
      return
    }
    const text = resumeText(label(from), label(to), r.cause, r.causeDetail, INSTANCE_MANAGER_FROM)
    // A source app still running signed out may hold engines that cannot work any more: they are stopped. Read now, not
    // when it went down, so an app that has since closed or signed in again is never asked to stop anything.
    const started = await io.startMove(from, to, ids, text, `instance-manager:${r.id}:${to.ref}`, from.running && !from.signedIn)
    if ('error' in started) {
      if (started.busy) change(r, r.state, `waiting for another move in AgentHydra to finish (${started.error})`)
      else change(r, 'failed', `the move was refused: ${started.error}`)
      return
    }
    r.movedAt = io.now()
    if ('operationId' in started) {
      r.operationId = started.operationId
      change(r, 'moving', `moving ${ids.length} chat${ids.length === 1 ? '' : 's'} to ${label(to)}`)
      return
    }
    settleMove(r, started.results)
  }

  function settleMove(r: Tracked, results: MoveResult[]): void {
    const to = r.toInstance
    if (!to) return
    for (const c of r.chats) {
      if (c.state !== 'pending') continue
      const m = results.find((x) => x.id === c.id)
      if (!m) setChat(r, c.id, 'failed', 'the move did not report on it')
      else if (!m.landed) setChat(r, c.id, 'failed', m.detail || 'it did not land')
      else {
        if (m.newId) r.newIds[c.id] = m.newId
        setChat(
          r,
          c.id,
          'moved',
          m.resumed
            ? `landed in ${label(to)} and was started again`
            : r.kind === 'codex'
              ? `landed in ${label(to)}; continue it from the Codex app (AgentHydra cannot start a Codex app's chat by itself)`
              : `landed in ${label(to)}, but was not started again: ${m.detail || 'no reason given'}`,
        )
      }
    }
    const landed = r.chats.filter((c) => c.state === 'moved').length
    if (!landed) change(r, 'failed', `no chat landed in ${label(to)}`)
    else change(r, 'watching', `${landed} of ${r.chats.length} landed in ${label(to)}; watching that they run`)
  }

  async function watch(r: Tracked, now: number): Promise<void> {
    const to = r.toInstance
    if (!to) return
    const moved = r.chats.filter((c) => c.state === 'moved')
    const since = r.movedAt ?? r.updatedAt
    if (moved.length) {
      const ids = moved.map((c) => r.newIds[c.id] ?? c.id)
      const there = await io.chatsIn(to, ids, since)
      const workingNow = new Set(working.filter((w) => w.ref === to.ref).map((w) => w.id))
      for (const c of moved) {
        const id = r.newIds[c.id] ?? c.id
        const row = there?.get(id)
        if (workingNow.has(id) || row?.activeSince) setChat(r, c.id, 'running', `runs again in ${label(to)}`)
        else if (row?.archived) setChat(r, c.id, 'stuck', `landed in ${label(to)} but is archived there`)
      }
    }
    const left = r.chats.filter((c) => c.state === 'moved')
    // A Codex chat that landed is as far as the manager can take it: the person continues it in the Codex app.
    if (left.length && r.kind === 'codex') {
      finish(r, to)
      return
    }
    if (left.length && now - since < WATCH_MS) return
    for (const c of left) setChat(r, c.id, 'stuck', `landed in ${label(to)} but has not run since; open it there`)
    finish(r, to)
  }

  function finish(r: Tracked, to: SeenInstance): void {
    const running = r.chats.filter((c) => c.state === 'running').length
    const moved = r.chats.filter((c) => c.state === 'running' || c.state === 'moved' || c.state === 'stuck').length
    const verb = r.kind === 'codex' ? 'moved to' : 'run again in'
    const count = r.kind === 'codex' ? moved : running
    change(r, 'done', `${count} of ${r.chats.length} chat${r.chats.length === 1 ? '' : 's'} ${verb} ${label(to)}`)
  }

  /** One step of one recovery. */
  async function step(r: Tracked, now: number): Promise<void> {
    const from = seen.find((i) => i.ref === r.from.ref)
    if (unjudged(r) && now - r.at < GRACE_MS) return
    if ((r.state === 'waiting' || r.state === 'opening') && from && isUp(from)) {
      const opened = r.state === 'opening' && r.toInstance ? ` (${label(r.toInstance)}, opened for them, stays open)` : ''
      change(r, 'came-back', `${label(from)} came back by itself; its chats are where they were${opened}`)
      return
    }
    if (unjudged(r)) {
      const inst = from ? { ...from, email: from.email ?? r.fromInstance.email } : r.fromInstance
      const [probe, log] = await Promise.all([io.probe(inst), io.appLog(inst)])
      const why = causeOf({ closed: !inst.running, lastUpAt: lastUpOf(r), instance: inst }, probe, log)
      const unread = probe === null || (inst.kind === 'desktop' && log === null)
      if (!acts(why.cause) && unread && now - r.at < GRACE_MS + READ_RETRY_MS) {
        change(r, 'waiting', `could not read why ${label(inst)} went down yet; reading again`)
        return
      }
      r.cause = why.cause
      r.causeDetail = why.detail
      r.fromInstance = inst
      if (!acts(why.cause)) {
        change(r, 'left', why.cause === 'quit' ? `${why.detail}: a person closed it, so its chats stay` : `${why.detail}; nothing was moved`)
        return
      }
      await choose(r, now)
      return
    }
    if (r.state === 'waiting') {
      await choose(r, now)
      return
    }
    if (r.state === 'opening') {
      const to = r.toInstance ? seen.find((i) => i.ref === r.toInstance?.ref) : undefined
      if (to && isUp(to)) {
        r.toInstance = to
        r.upSince ??= now
        if (now - r.upSince >= OPEN_SETTLE_MS) await startMove(r)
        return
      }
      if (now - (r.openedAt ?? r.updatedAt) >= OPEN_TIMEOUT_MS) {
        if (r.toInstance) r.passed.push(r.toInstance.ref)
        r.toInstance = null
        r.to = null
        change(r, 'waiting', 'the account opened for it did not come up in time; the next one is tried')
      }
      return
    }
    if (r.state === 'moving') {
      if (!r.operationId) {
        await startMove(r)
        return
      }
      const res = await io.moveResult(r.operationId)
      if (res === null) {
        if (now - (r.movedAt ?? r.updatedAt) >= MOVE_TIMEOUT_MS) change(r, 'failed', 'the move did not finish in time; AgentHydra keeps its record')
        return
      }
      if ('error' in res) {
        for (const c of r.chats) if (c.state === 'pending') setChat(r, c.id, 'failed', res.error)
        change(r, 'failed', `the move failed: ${res.error}`)
        return
      }
      settleMove(r, res.results)
      return
    }
    if (r.state === 'watching') await watch(r, now)
  }

  function lastUpOf(r: Tracked): number {
    return memory[r.from.ref]?.lastUpAt ?? r.at
  }

  async function look(enabled: boolean): Promise<void> {
    const now = io.now()
    const all = await io.instances()
    if (all === null) {
      lastError = 'AgentHydra did not answer; nothing was judged'
      return
    }
    const live = await io.working(all)
    if (live === null) {
      // Without what works where, a down app's chats are unknown: nothing new is noticed, nothing remembered changes.
      seen = all
      lastError = 'the list of working chats did not load; nothing was judged'
      return
    }
    seen = all
    working = live
    lastError = null
    const d = detect(memory, all, live, now)
    memory = d.memory
    // Apps going down one look apart (a restart closes them over several seconds) count together within one grace.
    const recent = recoveries.filter((r) => now - r.at < GRACE_MS)
    const alone = recent.length + d.down.length <= MAX_DOWN_AT_ONCE
    if (!alone) for (const r of recent) if (unjudged(r)) change(r, 'left', SEVERAL)
    for (const down of d.down) begin(down, now, alone, enabled)
    if (enabled) {
      for (const r of recoveries) {
        if (settled(r)) continue
        try {
          await step(r, now)
        } catch (err) {
          change(r, r.state, `this step failed and is tried again: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } else {
      for (const r of recoveries) if (!settled(r) && !r.detail.startsWith('paused')) change(r, r.state, `paused: the instance manager is off (${r.detail})`)
    }
    const done = recoveries.filter(settled)
    if (done.length > RECOVERIES_KEPT) {
      const drop = new Set(done.slice(RECOVERIES_KEPT))
      recoveries = recoveries.filter((r) => !drop.has(r))
    }
    checkedAt = now
  }

  function status(enabled: boolean, nextCheckAt: number | null): InstanceManagerStatus {
    const rows: ManagedInstance[] = seen
      .map((i) => ({
        ref: i.ref,
        kind: i.kind,
        num: i.num,
        name: i.name,
        plan: i.plan,
        running: i.running,
        signedIn: i.signedIn,
        working: working.filter((w) => w.ref === i.ref).length,
        lastUpAt: memory[i.ref]?.lastUpAt ?? null,
      }))
      .sort((a, b) => (a.kind === b.kind ? a.num - b.num : a.kind === 'desktop' ? -1 : 1))
    return {
      enabled,
      everyMs: INSTANCE_MANAGER_EVERY_MS,
      checkedAt,
      nextCheckAt,
      instances: rows,
      recoveries: recoveries.map(shown),
      error: lastError,
    }
  }

  return { look, status, saved: () => ({ memory, recoveries }) }
}

function kindName(kind: ManagedKind): string {
  return kind === 'desktop' ? 'Claude Desktop' : 'Codex'
}
