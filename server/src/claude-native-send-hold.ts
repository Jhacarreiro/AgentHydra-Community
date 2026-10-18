// server/src/claude-native-send-hold.ts - a native send to a busy chat waits here, not in the app.
//
// The app's own peer delivery takes a message into a busy chat's deferred sends and answers `queued`.
// That answer means lost, not held. On 2026-10-12 the app's log shows the sequence for one message
// (ids and times as seen in the log of the another_meh profile, local time UTC-5):
//   "Sending message to session local_<x>"                 the send arrives mid-turn, answered queued
//   "[Stop hook] Query completed for session local_<x>"    the turn ends
//   "drained 1 deferred send(s) for local_<x>"             the same second: the app writes it to the engine
//   "CLI undelivered input <msgid> ... without running it" the engine never runs it
//   "drew no acknowledgement from the CLI in 90018ms"      settled as undelivered, silently
// So the native send never hands the app a message for a busy chat, and a `queued` or `sent` answer
// is not done. It stays journalled as `unconfirmed` until the chat is idle and the app's settle window
// has passed; then the transcript decides: the message's unique ref present means it arrived, absent
// means it is sent once more (one resend at most). `delivered` (a turn started) is the only answer
// that counts as done at once.
//
// Exactly once: `sending` is written before the app is called, and a daemon that stops mid-send finds
// it `unconfirmed` on restart, so the transcript decides, not a blind resend. Two daemons (self-update
// overlaps the old and new process) share one journal: each send first claims `claims/<id>.<n>.lock`
// with an exclusive create, which is atomic across processes and survives restarts. Only the claimant
// calls the app. A claim whose process died before `sending` was written stays held: it is not sent
// twice, and it needs a manual check if it never settles.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export type HeldSendState =
  | 'held'
  | 'sending'
  | 'unconfirmed'
  | 'delivered'
  | 'not-arrived'
  | 'expired'

export interface HeldSend {
  id: string
  profileDir: string
  cliSessionId: string
  text: string
  fromName: string
  state: HeldSendState
  createdAt: number
  updatedAt: number
  /** When the app was last called with it (the settle window counts from here). */
  sentAt?: number
  /** Sends made so far: one, plus at most one resend after the transcript showed no ref. */
  attempts: number
  /** When a held note stops being news: the sender's limit from hold(), else the 24 h expiry. */
  staleAt?: number
  reason?: string
}

/** What the sender answers. `busy`: nothing was sent, the chat is busy. `delivered`: a turn started,
 *  done. Anything else (`queued`, `sent`, or no answer) means the app took it and the transcript must
 *  decide. `unavailable` without `busy`: nothing reached the app. `refused`: the app refused it before
 *  sending (archived, stopped until a person sends): final, never sent again. */
export interface HoldSendResult {
  ok: boolean
  unavailable: boolean
  busy?: boolean
  refused?: boolean
  delivery?: 'delivered' | 'queued' | 'sent' | 'held' | null
  reason?: string
}

export interface HoldDeps {
  journalPath: string
  send(req: {
    profileDir: string
    cliSessionId: string
    text: string
    fromName: string
  }): Promise<HoldSendResult>
  /** Whether the message's ref is in the chat's transcript. */
  transcriptHas(req: { profileDir: string; cliSessionId: string }, ref: string): boolean
  /** Whether the chat is idle by the app's own state (no query, start or cycle in flight). */
  isIdle(req: { profileDir: string; cliSessionId: string }): Promise<boolean>
  now?: () => number
  newId?: () => string
  /** A held message older than this is never sent: its chat stayed busy for too long. */
  expiryMs?: number
  /** How long the app may take to settle a message it has taken before the transcript is checked. */
  settleMs?: number
  intervalMs?: number
}

const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000
const DEFAULT_SETTLE_MS = 120_000
const DEFAULT_INTERVAL_MS = 15_000
const MAX_ATTEMPTS = 2

export function readHoldJournal(path: string): HeldSend[] {
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return Array.isArray(parsed) ? (parsed as HeldSend[]) : []
}

function writeHoldJournal(path: string, entries: HeldSend[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(entries, null, 2))
  renameSync(tmp, path)
}

/** The unique ref that goes into every held message's text, so the transcript check is exact. */
export function holdRef(id: string): string {
  return `ref ${id}`
}

/** Claims the right to make attempt `n` of a message. Exclusive create: exactly one process wins. */
function claimAttempt(journalPath: string, id: string, n: number): boolean {
  const dir = join(dirname(journalPath), 'claims')
  mkdirSync(dir, { recursive: true })
  try {
    closeSync(openSync(join(dir, `${id}.${n}.lock`), 'wx'))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/** Gives attempt `n` back when the app was never called with it (busy, or refused before sending). */
function releaseAttempt(journalPath: string, id: string, n: number): void {
  rmSync(join(dirname(journalPath), 'claims', `${id}.${n}.lock`), { force: true })
}

export function createNativeSendHold(deps: HoldDeps) {
  const now = deps.now ?? (() => Date.now())
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const expiryMs = deps.expiryMs ?? DEFAULT_EXPIRY_MS
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS
  const entries: HeldSend[] = readHoldJournal(deps.journalPath)
  // A `sending` entry at start means the daemon stopped mid-send: the app may have taken it, so it
  // is settled by the transcript, not sent again blind.
  for (const e of entries) {
    if (e.state === 'sending') {
      e.state = 'unconfirmed'
      e.sentAt = e.updatedAt
      e.reason = 'the daemon stopped during the send; the transcript decides'
      e.updatedAt = now()
    }
  }
  if (entries.length) writeHoldJournal(deps.journalPath, entries)
  let timer: ReturnType<typeof setInterval> | undefined
  let draining: Promise<void> | undefined

  function save(): void {
    writeHoldJournal(deps.journalPath, entries)
  }

  function setState(e: HeldSend, state: HeldSendState, reason?: string): void {
    e.state = state
    e.updatedAt = now()
    if (reason !== undefined) e.reason = reason
    save()
  }

  const pending = () => entries.some((e) => e.state === 'held' || e.state === 'unconfirmed')

  function ensureTimer(): void {
    if (timer || !pending()) return
    timer = setInterval(() => {
      try {
        drain().catch((e) =>
          console.error('[send-hold] drain failed:', e instanceof Error ? e.message : String(e)),
        )
      } catch (e) {
        console.error('[send-hold] drain failed:', e instanceof Error ? e.message : String(e))
      }
    }, deps.intervalMs ?? DEFAULT_INTERVAL_MS)
    timer.unref?.()
  }

  function stopTimerIfIdle(): void {
    if (timer && !pending()) {
      clearInterval(timer)
      timer = undefined
    }
  }

  /** Journals a message for a busy chat. The app is not called until the chat is idle. `limitMs`: the
   *  note is not sent once it is that old (the sender knows how long it stays news); unset, the expiry. */
  function hold(
    req: { profileDir: string; cliSessionId: string; text: string; fromName: string },
    limitMs?: number,
  ) {
    const at = now()
    const id = newId()
    const staleAt = at + (limitMs ?? expiryMs)
    const entry: HeldSend = {
      id,
      ...req,
      state: 'held',
      createdAt: at,
      updatedAt: at,
      attempts: 0,
      staleAt,
    }
    entries.push(entry)
    save()
    ensureTimer()
    return { ok: true, unavailable: false, delivery: 'held' as const, id }
  }

  /** The text the app receives: the message with its unique ref, so the transcript can find it. */
  function bodyOf(e: HeldSend): string {
    return `${e.text}\n(${holdRef(e.id)})`
  }

  /** Takes the journal's current state from disk: another daemon may have sent or settled entries. */
  function sync(): void {
    entries.splice(0, entries.length, ...readHoldJournal(deps.journalPath))
  }

  async function sendOnce(e: HeldSend): Promise<void> {
    const n = e.attempts + 1
    if (!claimAttempt(deps.journalPath, e.id, n)) {
      // Another process made this attempt: its result, not a second send, is what counts now.
      sync()
      return
    }
    setState(e, 'sending')
    e.attempts = n
    e.sentAt = now()
    const r = await deps
      .send({
        profileDir: e.profileDir,
        cliSessionId: e.cliSessionId,
        text: bodyOf(e),
        fromName: e.fromName,
      })
      .catch((err): HoldSendResult => ({ ok: false, unavailable: true, reason: String(err) }))
    if (r.refused) {
      // The app refused it before sending: the refusal is the answer, so the note is not retried.
      setState(e, 'not-arrived', r.reason ?? 'the app refused it')
    } else if (r.busy || (!r.ok && r.unavailable)) {
      // Nothing reached the app: the message stays held, and is sent when the chat is idle.
      releaseAttempt(deps.journalPath, e.id, n)
      e.attempts -= 1
      setState(e, 'held', r.reason ?? 'the chat is busy')
    } else if (r.ok && r.delivery === 'delivered') {
      setState(e, 'delivered', 'a turn started on it')
    } else {
      setState(
        e,
        'unconfirmed',
        `the app answered ${r.delivery ?? 'no receipt'}: ${r.reason ?? ''}`.trim(),
      )
    }
  }

  /** An unconfirmed message: once the settle window has passed and the chat is idle, the transcript
   *  decides. Present: arrived. Absent: sent once more, and at the second absence it is final. */
  async function settle(e: HeldSend): Promise<void> {
    if (now() - (e.sentAt ?? e.updatedAt) < settleMs) return
    const req = { profileDir: e.profileDir, cliSessionId: e.cliSessionId }
    if (!(await deps.isIdle(req).catch(() => false))) return
    if (deps.transcriptHas(req, holdRef(e.id))) {
      setState(e, 'delivered', 'found in the transcript')
    } else if (e.attempts < MAX_ATTEMPTS) {
      // The app settled the earlier copy without running it: one more send, and only then.
      setState(e, 'held', 'not in the transcript after the settle window; sent once more')
      await sendOnce(e)
    } else {
      setState(e, 'not-arrived', 'not in the transcript after two sends; not sent again')
    }
  }

  /** Walks the held and unconfirmed messages oldest first, one at a time. */
  async function drain(): Promise<void> {
    if (draining) return draining
    draining = (async () => {
      try {
        const ids = entries
          .filter((x) => x.state === 'held' || x.state === 'unconfirmed')
          .map((x) => x.id)
        for (const id of ids) {
          // Re-read the journal per message: another daemon may have sent or settled it meanwhile.
          sync()
          const e = entries.find((x) => x.id === id)
          if (!e || (e.state !== 'held' && e.state !== 'unconfirmed')) continue
          if (e.state === 'held' && now() > (e.staleAt ?? e.createdAt + expiryMs)) {
            setState(
              e,
              'expired',
              'the chat stayed busy past the time this note was worth sending; it was never sent',
            )
            continue
          }
          if (e.state === 'held') await sendOnce(e)
          else await settle(e)
        }
      } finally {
        draining = undefined
        stopTimerIfIdle()
      }
    })()
    return draining
  }

  function stop(): void {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  // A journal left by a stopped daemon holds messages still to send: the timer resumes them without a new hold.
  ensureTimer()

  return { hold, drain, stop, list: () => entries.map((e) => ({ ...e })) }
}
