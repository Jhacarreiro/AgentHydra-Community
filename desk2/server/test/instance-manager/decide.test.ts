// instance-manager/decide.ts: noticing an app that went down with chats working in it, why it went down (from Claude
// Desktop's own log lines and the account), and which same-kind account takes the chats.

import { expect, test } from 'bun:test'
import { type Candidate, causeOf, detect, rankTargets, type SeenInstance, STALE_MEMORY_MS } from '../../src/instance-manager/decide'

const NOW = new Date(2026, 9, 15, 3, 40, 0).getTime()

function app(num: number, fields: Partial<SeenInstance> = {}): SeenInstance {
  return {
    ref: `desktop:C:/Users/me/.claude-instances/p${num}`,
    kind: 'desktop',
    num,
    name: `p${num}`,
    handle: `C:/Users/me/.claude-instances/p${num}`,
    email: `p${num}@example.com`,
    plan: 'Max 5×',
    running: true,
    signedIn: true,
    ...fields,
  }
}

const stamp = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const log = (...lines: [number, string][]): string => lines.map(([ms, text]) => `${stamp(ms)} [info] ${text}`).join('\n')

test('an app that was up with chats working and is down now is noticed once; idle, never-up and stale apps are not', () => {
  const a = app(1)
  const b = app(2)
  const c = app(3)
  const first = detect({}, [a, b, c], [{ id: 's1', title: 'Fix the parser', ref: a.ref }, { id: 's2', title: 'Write docs', ref: a.ref }], NOW)
  expect(first.down).toEqual([])

  // a closes with its two chats; b closes with nothing working; c is signed out while still running. a's account reads
  // no address once signed out, and keeps the one it had, so the same account is still told apart.
  const second = detect(first.memory, [{ ...a, running: false, email: null }, { ...b, running: false }, { ...c, signedIn: false }], [], NOW + 20_000)
  expect(second.down.map((d) => [d.instance.num, d.closed, d.chats.map((x) => x.id), d.instance.email])).toEqual([[1, true, ['s1', 's2'], 'p1@example.com']])
  expect(second.down[0]?.lastUpAt).toBe(NOW)

  // Still down a look later: not noticed again.
  expect(detect(second.memory, [{ ...a, running: false }], [], NOW + 40_000).down).toEqual([])

  // A memory older than STALE_MEMORY_MS (Desk was not running) says nothing about what the app was doing.
  const stale = detect(first.memory, [{ ...a, running: false }], [], NOW + STALE_MEMORY_MS + 1)
  expect(stale.down).toEqual([])

  // An app the read did not list keeps its memory, so it is still noticed when it comes back down in a later read.
  const dropped = detect(first.memory, [b], [], NOW + 20_000)
  expect(detect(dropped.memory, [{ ...a, running: false }], [], NOW + 40_000).down.map((d) => d.instance.num)).toEqual([1])
})

test('why it went down: a sign-out or a dead account beats a clean quit, start-up noise is not a sign-out, and a log that stops without a quit is a crash', () => {
  const lastUp = NOW - 60_000
  const down = { closed: true, lastUpAt: lastUp, instance: { signedIn: true, plan: 'Max 5×', kind: 'desktop' as const } }
  const quit = log([lastUp - 10_000, 'beforeQuit: handler is ready for quit, so quitting'], [lastUp + 5_000, 'willQuit: handler is ready for quit, so quitting'])
  expect(causeOf(down, { status: 'live', plan: 'Max 5×' }, quit).cause).toBe('quit')

  const signOut = '[account] Login-state transition (loggedOut: false → true, uuid: a1 → <none>), clearing oauth cache'
  const quitting = 'beforeQuit: handler is ready for quit, so quitting'
  expect(causeOf(down, null, log([lastUp + 1_000, signOut], [lastUp + 2_000, quitting])).cause).toBe('logged-out')

  // What every start and a routine token refresh write is not a sign-out, nor is one undone by signing in again.
  const startNoise = log(
    [lastUp - 20_000, '[account] User is logged out, skipping account ID wait'],
    [lastUp - 10_000, 'OAuth token refresh failed (auth_error status=400 detail=<json error=invalid_grant len=85>)'],
    [lastUp + 2_000, quitting],
  )
  expect(causeOf(down, null, startNoise).cause).toBe('quit')
  const signedInAgain = log([lastUp - 5_000, signOut], [lastUp - 4_000, '[account] Login-state transition (loggedOut: true → false, uuid: <none> → a1)'], [lastUp + 2_000, quitting])
  expect(causeOf(down, null, signedInAgain).cause).toBe('quit')

  const orgOff = log([lastUp + 1_000, 'API error: This organization has been disabled.'], [lastUp + 2_000, 'willQuit: handler is ready for quit, so quitting'])
  expect(causeOf(down, null, orgOff).cause).toBe('account-dead')

  const crash = log([lastUp + 1_000, '[process-memory] trigger=interval tree_rss_sum=2100MB'])
  expect(causeOf(down, null, crash)).toEqual({ cause: 'crashed', detail: 'its log stops without a quit' })

  // A quit long before it was last seen up is an earlier session's, not this one's.
  expect(causeOf(down, null, log([lastUp - 3_600_000, 'beforeQuit: handler is ready for quit, so quitting'])).cause).toBe('crashed')

  // The account says it before the log does: signed out, or a paid plan that turned free.
  expect(causeOf({ ...down, instance: { ...down.instance, signedIn: false } }, null, quit).cause).toBe('logged-out')
  expect(causeOf(down, { status: 'loggedout', plan: null }, quit).cause).toBe('logged-out')
  expect(causeOf(down, { status: 'live', plan: 'Free' }, quit).cause).toBe('account-dead')

  expect(causeOf(down, null, null).cause).toBe('unknown')
})

test('the chats go to the same-kind account with the most room, never the same account, and a running app wins a tie', () => {
  const down = app(1, { running: false, email: 'owner@example.com' })
  const cand = (inst: SeenInstance, fiveHourPct: number | null, weeklyPct: number | null, known = true): Candidate => ({
    instance: inst,
    fiveHourPct,
    weeklyPct,
    capPct: 85,
    known,
  })
  const ranked = rankTargets(down, [
    cand(app(1), 0, 0), // the app that went down
    cand(app(2, { email: 'OWNER@example.com' }), 0, 0), // the same account in another profile
    cand(app(3, { plan: 'Max 20×', running: false }), 10, 40), // 20 x (85 - 40) = 900
    cand(app(4, { plan: 'Max 5×' }), 0, 5), // 5 x 80 = 400
    cand(app(5, { plan: 'Max 20×' }), 90, 10), // its five hours are past the line
    cand(app(6, { plan: 'Max 20×' }), null, null, false), // no real reading
    cand(app(7, { plan: 'Pro', running: false }), 0, 0), // 1 x 85
    cand(app(8, { plan: 'Pro' }), 0, 0), // the same room, already running
    cand(app(9, { kind: 'codex', ref: 'codex:x', plan: 'Pro' }), 0, 0), // another kind of app
    cand(app(10, { signedIn: false, plan: 'Max 20×' }), 0, 0),
  ])
  expect(ranked.map((r) => [r.instance.num, r.room])).toEqual([
    [3, 900],
    [4, 400],
    [8, 85],
    [7, 85],
  ])
})
