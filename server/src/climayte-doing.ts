// What a CliMayte worker is doing now and since when, for the Desk's task rows: read from the worker's
// own state (its hold reason or question, its newest narration line, its newest tool step, and when
// each last changed), so it costs no model call.
import type { CliMayteWorker } from './climayte-lib'

/** hold: waiting on the scheduler or on its manager; said: its own narration; step: a tool step or a
 *  check; wait: a tool step that blocks on a background job (Monitor, climayte_wait.py). */
export type DoingKind = 'hold' | 'said' | 'step' | 'wait'

export interface Doing {
  doing: string | null
  doingSince: number | null
  doingKind: DoingKind | null
}

const DOING_MAX = 120
const REASON_MAX = 70
const SAID_PREFIX = 'said: '

/** The state a worker is in, for the time it has been in it. A held worker's key is the head of its
 *  error, so the figures in the reason (the CPU share each tick) do not restart the clock. */
export function stateKey(w: CliMayteWorker): string {
  if (w.status === 'queued' || w.status === 'waiting')
    return `${w.status}|${(w.error ?? '').split(/[:.]/)[0]}`
  return w.status
}

function cutWords(s: string, max: number): string {
  if (s.length <= max) return s
  const head = s.slice(0, max - 3)
  const space = head.lastIndexOf(' ')
  const at = space > max / 2 ? head.slice(0, space) : head
  return `${at.replace(/[\s,:;]+$/, '')}...`
}

const firstLine = (s: string): string =>
  s
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) ?? ''

const isWaitStep = (line: string | null): boolean =>
  !!line && (/^Monitor\b/.test(line) || line.includes('climayte_wait.py'))

const sayingOf = (said: string): string =>
  said.replace(/^ETA:\s*\d+(?:\.\d+)?\s*min\b[.,;:]?\s*/i, '').trim()

const NONE: Doing = { doing: null, doingSince: null, doingKind: null }

function holdOf(w: CliMayteWorker, stateSince: number | null): Doing {
  const reason = w.error ? cutWords(w.error.split(/[.;](?=\s|$)/)[0]!.trim(), REASON_MAX) : ''
  const doing = reason || (w.status === 'waiting' ? 'Waiting' : 'Queued')
  return { doing, doingSince: stateSince, doingKind: 'hold' }
}

function runningOf(w: CliMayteWorker, stateSince: number | null): Doing {
  const stepSince = Math.max(w.stepAt ?? 0, stateSince ?? 0) || null
  // A line said before this run began (the last message's report, or before a move) is not what it does now.
  const stale = w.saidAt !== undefined && stateSince !== null && w.saidAt < stateSince
  const said = w.saidLine && !stale ? sayingOf(w.saidLine) : ''
  const wait = isWaitStep(w.lastActivity)
  if (wait) {
    const base = said || w.lastActivity!
    return {
      doing: cutWords(`Waiting: ${base}`, DOING_MAX),
      doingSince: stepSince,
      doingKind: 'wait',
    }
  }
  if (said)
    return {
      doing: cutWords(said, DOING_MAX),
      doingSince: w.saidAt ?? stepSince,
      doingKind: 'said',
    }
  if (w.lastActivity)
    return { doing: cutWords(w.lastActivity, DOING_MAX), doingSince: stepSince, doingKind: 'step' }
  return { doing: 'Working', doingSince: stepSince, doingKind: 'step' }
}

export function doingOf(w: CliMayteWorker): Doing {
  const stateSince = w.stateAt?.at ?? w.createdAt ?? null
  if (
    w.question &&
    (w.status === 'queued' ||
      w.status === 'waiting' ||
      w.status === 'running' ||
      w.status === 'checking')
  ) {
    const ask = firstLine(w.question.text)
    return {
      doing: cutWords(
        ask ? `Waiting for your answer: ${ask}` : 'Waiting for your answer',
        DOING_MAX,
      ),
      doingSince: w.question.at ?? stateSince,
      doingKind: 'hold',
    }
  }
  switch (w.status) {
    case 'running':
      return runningOf(w, stateSince)
    case 'checking':
      return { doing: 'Running its check', doingSince: stateSince, doingKind: 'step' }
    case 'queued':
    case 'waiting':
      return holdOf(w, stateSince)
    default:
      return NONE
  }
}

/** The text of the newest `said:` line in a worker's summary lines, without its prefix. */
export function newestSaid(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (line.startsWith(SAID_PREFIX)) return line.slice(SAID_PREFIX.length)
  }
  return null
}
