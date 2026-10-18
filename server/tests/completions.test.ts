import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliMayteOrigin, PingEvent } from '../src/climayte-ping'
import {
  type CompletionDeps,
  createCompletions,
  FINISH_KEPT_MS,
  WAIT_TTL_MS,
  waitFromBody,
} from '../src/completions'

function harness(start = 1_000) {
  const sent: { origin: CliMayteOrigin; events: PingEvent[] }[] = []
  const deps = {
    file: join(mkdtempSync(join(tmpdir(), 'completions-')), 'completions.json'),
    emit: (origin: CliMayteOrigin, events: PingEvent[]) => {
      sent.push({ origin, events })
      return true
    },
    ready: () => true,
    off: () => false,
    now: () => clock.t,
    resolve: (o: CliMayteOrigin) => o,
  }
  const clock = { t: start }
  const reg = () => createCompletions(deps as CompletionDeps)
  return { sent, clock, deps, reg, c: reg() }
}

const wait = (ticket = 'desk-chat:c1', sessionId = 's1', after = 1_000) => ({
  ticket,
  origin: { sessionId, home: '/home/x' },
  label: 'Seat "Ana"',
  read: 'core_use { chat: "c", id: "a", mode: "consult" }',
  after,
})

describe('completion registry', () => {
  test('a wait then a finish delivers once, with the read hint', () => {
    const h = harness()
    h.c.waitFor(wait())
    h.clock.t = 2_000
    h.c.finished({ ticket: 'desk-chat:c1', outcome: 'done', at: 2_000 })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].origin).toMatchObject({ kind: 'chat', sessionId: 's1' })
    expect(h.sent[0].events[0].kind).toBe('finished-later')
    expect(h.sent[0].events[0].line).toBe(
      'Seat "Ana" finished; read it with core_use { chat: "c", id: "a", mode: "consult" }.',
    )
    h.c.sweep()
    expect(h.sent).toHaveLength(1)
  })

  test('a finish kept from before the wait still delivers, once', () => {
    const h = harness()
    h.c.finished({ ticket: 'desk-chat:c1', outcome: 'done', at: 1_500 })
    h.clock.t = 1_600
    h.c.waitFor(wait('desk-chat:c1', 's1', 1_200))
    expect(h.sent).toHaveLength(1)
    h.c.sweep()
    expect(h.sent).toHaveLength(1)
  })

  test('a finish before the wait was asked does not match it', () => {
    const h = harness()
    h.c.waitFor(wait('desk-chat:c1', 's1', 5_000))
    h.clock.t = 2_000
    h.c.finished({ ticket: 'desk-chat:c1', outcome: 'done', at: 2_000 })
    expect(h.sent).toHaveLength(0)
  })

  test('a finish kept for 10 minutes only', () => {
    const h = harness()
    h.c.finished({ ticket: 'desk-chat:c1', outcome: 'done', at: 1_000 })
    h.clock.t = 1_000 + FINISH_KEPT_MS + 1
    h.c.waitFor(wait('desk-chat:c1', 's1', 1_000))
    expect(h.sent).toHaveLength(0)
  })

  test('a second finish needs a new wait', () => {
    const h = harness()
    h.c.waitFor(wait())
    h.c.finished({ ticket: 'desk-chat:c1', outcome: 'done', at: 2_000 })
    h.c.finished({ ticket: 'desk-chat:c1', outcome: 'done', at: 3_000 })
    expect(h.sent).toHaveLength(1)
    h.c.waitFor(wait('desk-chat:c1', 's1', 3_000))
    expect(h.sent).toHaveLength(2)
  })

  test('seen drops the wait', () => {
    const h = harness()
    h.c.waitFor(wait())
    h.c.seen('desk-chat:c1', 's1')
    h.c.finished({ ticket: 'desk-chat:c1', outcome: 'done', at: 2_000 })
    expect(h.sent).toHaveLength(0)
  })

  test('ping off delivers nothing and keeps the wait for the next settle', () => {
    const h = harness()
    let off = true
    h.deps.off = () => off
    h.c.waitFor(wait())
    h.c.finished({ ticket: 'desk-chat:c1', outcome: 'done', at: 2_000 })
    expect(h.sent).toHaveLength(0)
    off = false
    h.c.sweep()
    expect(h.sent).toHaveLength(1)
  })

  test('an outbox that is not running keeps the wait and the finish, then delivers once it runs', () => {
    const h = harness()
    let running = false
    h.deps.ready = () => running
    h.c.waitFor(wait())
    h.c.finished({ ticket: 'desk-chat:c1', outcome: 'done', at: 2_000 })
    expect(h.sent).toHaveLength(0)
    running = true
    h.c.sweep()
    expect(h.sent).toHaveLength(1)
    h.c.sweep()
    expect(h.sent).toHaveLength(1)
  })

  test('a duplicate the outbox refuses is dropped, not retried', () => {
    const h = harness()
    const refused: CliMayteOrigin[] = []
    h.deps.emit = (origin) => {
      refused.push(origin)
      return false
    }
    h.c.waitFor(wait())
    h.c.finished({ ticket: 'desk-chat:c1', outcome: 'done', at: 2_000 })
    expect(refused).toHaveLength(1)
    h.c.sweep()
    expect(refused).toHaveLength(1)
  })

  test('a wait expires after 24 hours', () => {
    const h = harness()
    h.c.waitFor(wait())
    h.clock.t = 1_000 + WAIT_TTL_MS + 1
    h.c.finished({ ticket: 'desk-chat:c1', outcome: 'done', at: h.clock.t })
    expect(h.sent).toHaveLength(0)
  })

  test('open waits and kept finishes survive a reload', () => {
    const h = harness()
    h.c.waitFor(wait())
    h.reg().finished({ ticket: 'desk-chat:c1', outcome: 'done', at: 2_000 })
    expect(h.sent).toHaveLength(1)

    h.c.finished({ ticket: 'desk-chat:c2', outcome: 'done', at: 2_000 })
    h.reg().waitFor(wait('desk-chat:c2', 's2', 1_000))
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].origin).toMatchObject({ kind: 'chat', sessionId: 's2' })
  })

  test('a caller whose session is a CliMayte worker is reached as that worker, not as the chat', () => {
    const h = harness()
    const resolve = (o: CliMayteOrigin): CliMayteOrigin =>
      o.kind === 'chat' && o.sessionId === 'worker-session'
        ? { kind: 'worker', workerId: 'w-1' }
        : o
    const c = createCompletions({ ...h.deps, resolve } as CompletionDeps)
    c.waitFor(wait('desk-chat:c1', 'worker-session', 1_000))
    c.finished({ ticket: 'desk-chat:c1', outcome: 'done', at: 2_000 })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].origin).toEqual({ kind: 'worker', workerId: 'w-1' })
  })

  test('the wait body never carries an origin: the caller comes from the request', () => {
    const body = waitFromBody({
      ticket: 'desk-chat:c1',
      label: 'L',
      read: 'R',
      after: 1,
      origin: { sessionId: 'other' },
    })
    expect(body).toEqual({ ticket: 'desk-chat:c1', label: 'L', read: 'R', after: 1 })
    expect(waitFromBody({ ticket: 'nope:1', label: 'L', read: 'R', after: 1 })).toBeNull()
  })
})

const SRC = join(import.meta.dir, '..', 'src')
const ANSWER = /status: '(working|started)'/
// Answers that are not wired yet: a CliMayte worker seat or consult job, whose ticket (climayte-worker) is reserved.
const UNWIRED: { file: string; line: string }[] = [
  { file: 'hydra-core/use.ts', line: "status: 'working'," },
  { file: 'hydra-core/use.ts', line: ": { job, status: 'working', read: readHint(e) }" },
  {
    file: 'hydra-core/use.ts',
    line: "if (args.mode === 'hire') return { status: 'started', job }",
  },
]

describe('every working answer is registered or unwired on purpose', () => {
  test('a file that answers working or started calls waitFor, or the line is listed as unwired', () => {
    const bad: string[] = []
    for (const rel of readdirSync(SRC, { recursive: true }) as string[]) {
      if (!rel.endsWith('.ts')) continue
      const text = readFileSync(join(SRC, rel), 'utf8').replace(/\\/g, '/')
      const hits = text.split('\n').filter((l) => ANSWER.test(l))
      if (!hits.length) continue
      const wired = /waitFor\(/.test(text)
      for (const line of hits) {
        const trimmed = line.trim()
        const listed = UNWIRED.some((u) => u.file === rel.replace(/\\/g, '/') && u.line === trimmed)
        if (!wired && !listed) bad.push(`${rel}: ${trimmed}`)
      }
    }
    expect(bad).toEqual([])
  })
})
