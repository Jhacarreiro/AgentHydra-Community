/**
 * The completion registry: one place for work that outlives the call that started it. Whatever does the work
 * reports `finished` when it ends; whatever is waiting registers `waitFor`, and that caller is told once, through
 * the CliMayte outbox, with the line `<label> finished; read it with <read>.`
 *
 * A ticket is `<kind>:<id>`: `desk-chat:<chat id>` now; `hswarm-job:<id>` and `climayte-worker:<id>` are reserved.
 * A finish nobody waits on is kept 10 minutes, so a wait that lands just after the work ended still matches. A wait
 * expires after 24 h. Both persist in the daemon's state folder, so a restart keeps open waits. While the outbox is
 * not running or `ping-off` exists, waits and finishes are kept for the next sweep.
 *
 * The deps are injected (routes/completions.ts wires the real outbox): tests pass a fake emit and a fake clock.
 */

import type { CliMayteOrigin, PingEvent } from './climayte-ping'
import { type JsonStoreSpec, readJsonStore, writeJsonStoreAtomic } from './core/json-store'

export const FINISH_KEPT_MS = 10 * 60_000
export const WAIT_TTL_MS = 24 * 3_600_000
export const TICKET = /^(desk-chat|hswarm-job|climayte-worker):\S+$/
export type CompletionOutcome = 'done' | 'failed' | 'cancelled'

export interface WaitInput {
  ticket: string
  origin: { sessionId: string; home: string }
  label: string
  read: string
  /** When the work was asked, epoch ms: only a finish at or after it counts. */
  after: number
}

export interface FinishInput {
  ticket: string
  outcome: CompletionOutcome
  at: number
}

export interface CompletionDeps {
  /** The state file, e.g. `<state>/completions/completions.json`. */
  file: string
  /** The origin as the outbox delivers it: a chat that runs as a CliMayte worker is reached as that worker. */
  resolve(origin: CliMayteOrigin): CliMayteOrigin
  /** The CliMayte outbox's emit: false when it did not queue the event (the key is already recorded). */
  emit(origin: CliMayteOrigin, events: PingEvent[]): boolean
  /** Whether the CliMayte outbox is running. */
  ready(): boolean
  /** Whether pings are switched off (`ping-off`). */
  off(): boolean
  now(): number
}

export interface Completions {
  waitFor(input: WaitInput): void
  finished(input: FinishInput): void
  seen(ticket: string, sessionId: string): void
  /** Re-checks waits against kept finishes (after pings come back on, or on a timer). */
  sweep(): void
}

interface Wait {
  ticket: string
  sessionId: string
  home: string
  label: string
  read: string
  after: number
  since: number
}

interface Finish {
  ticket: string
  outcome: CompletionOutcome
  at: number
  kept: number
}

interface State {
  waits: Wait[]
  finishes: Finish[]
}

const spec = (file: string): JsonStoreSpec<State> => ({
  path: file,
  decode: (p) => {
    const s = p as Partial<State> | null
    return s && Array.isArray(s.waits) && Array.isArray(s.finishes)
      ? { waits: s.waits, finishes: s.finishes }
      : null
  },
  empty: () => ({ waits: [], finishes: [] }),
})

const OUTCOMES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled'])
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function ticketOf(v: unknown): string | null {
  return typeof v === 'string' && TICKET.test(v) ? v : null
}

/** A wait's body without its caller: the route takes the caller from the request, never from the body. */
export function waitFromBody(body: Record<string, unknown>): Omit<WaitInput, 'origin'> | null {
  const ticket = ticketOf(body.ticket)
  const label = text(body.label)
  const read = text(body.read)
  const after = Number(body.after)
  if (!ticket || !label || !read || !Number.isFinite(after)) return null
  return { ticket, label, read, after }
}

export function finishFromBody(body: Record<string, unknown>, now: number): FinishInput | null {
  const ticket = ticketOf(body.ticket)
  const at = body.at === undefined ? now : Number(body.at)
  if (!ticket || !OUTCOMES.has(String(body.outcome)) || !Number.isFinite(at)) return null
  return { ticket, outcome: body.outcome as CompletionOutcome, at }
}

export function createCompletions(deps: CompletionDeps): Completions {
  const read = readJsonStore(spec(deps.file))
  const state: State = read.status === 'ok' ? read.value : { waits: [], finishes: [] }

  const save = () => writeJsonStoreAtomic(deps.file, state)

  const matches = (w: Wait, f: Finish) => w.ticket === f.ticket && f.at >= w.after

  const prune = (t: number) => {
    state.finishes = state.finishes.filter(
      (f) => t - f.kept <= FINISH_KEPT_MS || state.waits.some((w) => matches(w, f)),
    )
  }

  const settle = () => {
    const t = deps.now()
    state.waits = state.waits.filter((w) => t - w.since <= WAIT_TTL_MS)
    prune(t)
    if (deps.ready() && !deps.off()) {
      for (const f of [...state.finishes]) {
        const hit = state.waits.filter((w) => matches(w, f))
        if (!hit.length) continue
        for (const w of hit) {
          deps.emit(
            deps.resolve({
              kind: 'chat',
              sessionId: w.sessionId,
              home: w.home,
              transcript: null,
              how: 'completion wait',
            }),
            [
              {
                key: `done:${f.ticket}:${f.at}`,
                kind: 'finished-later',
                workerId: null,
                group: '',
                at: t,
                line: `${w.label} finished; read it with ${w.read}.`,
              },
            ],
          )
        }
        state.waits = state.waits.filter((w) => !hit.includes(w))
        state.finishes = state.finishes.filter((x) => x !== f)
      }
    }
    save()
  }

  return {
    waitFor({ ticket, origin, label, read: how, after }) {
      // Before the new wait exists: a finish that outlived its 10 minutes is not matched by a wait that came later.
      prune(deps.now())
      state.waits = state.waits.filter(
        (w) => !(w.ticket === ticket && w.sessionId === origin.sessionId),
      )
      state.waits.push({
        ticket,
        sessionId: origin.sessionId,
        home: origin.home,
        label,
        read: how,
        after,
        since: deps.now(),
      })
      settle()
    },
    finished({ ticket, outcome, at }) {
      state.finishes.push({ ticket, outcome, at, kept: deps.now() })
      settle()
    },
    seen(ticket, sessionId) {
      state.waits = state.waits.filter((w) => !(w.ticket === ticket && w.sessionId === sessionId))
      save()
    },
    sweep: settle,
  }
}
