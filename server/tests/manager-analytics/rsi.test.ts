import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MergedTurn } from '../../src/manager-analytics/collect'
import {
  autoRsiTick,
  list,
  next,
  type RsiDeps,
  settleTrials,
  start,
  status,
} from '../../src/manager-analytics/rsi'

const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const HOUR = 3_600_000
const DAY = 86_400_000
const SLUG = 'example-mgr'
const FACET = 'tools.md'
const BRIEF = 'Example brief, invented for tests.\n'
const FACET_TEXT = 'Example facet, invented for tests.\n'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rsi-test-'))
  process.env.AGENTHYDRA_MANAGERS_DIR = dir
  const pdir = join(dir, SLUG)
  mkdirSync(join(pdir, 'playbook'), { recursive: true })
  writeFileSync(
    join(pdir, 'persona.json'),
    JSON.stringify({
      slug: SLUG,
      brief: 'brief.md',
      playbook: [{ file: `playbook/${FACET}`, facet: 'tools', read_when: 'example' }],
      sources: [],
      keywords: [],
    }),
  )
  writeFileSync(join(pdir, 'brief.md'), BRIEF)
  writeFileSync(join(pdir, 'playbook', FACET), FACET_TEXT)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.AGENTHYDRA_MANAGERS_DIR
  delete process.env.AGENTHYDRA_MANAGER_RSI_AUTO
})

function turn(i: number, at: number, score: number): MergedTurn {
  const id = `s1:p${i}`
  return {
    v: 1,
    type: 'turn',
    id,
    session: 's1',
    deskChat: 'chat-1',
    parentChat: null,
    manager: SLUG,
    picked: null,
    trigger: 'owner',
    promptChars: 20,
    start: at,
    firstOutput: null,
    end: at + 1000,
    firstMs: null,
    totalMs: 1000,
    outcome: 'replied',
    error: null,
    replyChars: 40,
    tools: {},
    facetsRead: [FACET],
    sub: { opened: [], asks: 0, answered: 0, unanswered: 0 },
    workers: [],
    tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 },
    costUsd: null,
    signals: [],
    verdicts: [],
    judge: {
      v: 1,
      type: 'judge',
      turn: id,
      score,
      criteria: { accuracy: score > 6 ? 2 : 1, tone: 2 },
      facet: 'tools',
      why: 'example reason',
      model: 'example-model',
      costUsd: null,
      at: at + 2000,
    },
  } as unknown as MergedTurn
}

function turnsOf(list: MergedTurn[]): Map<string, MergedTurn> {
  return new Map(list.map((t) => [t.id, t]))
}

function baseline(count: number, score: number, from = NOW - 2 * DAY): MergedTurn[] {
  return Array.from({ length: count }, (_, i) => turn(i, from + i * 1000, score))
}

function fake(turns: Map<string, MergedTurn>, now: number, extra: Partial<RsiDeps> = {}): RsiDeps {
  return {
    turns,
    now,
    dispatch: async () => 'w-1',
    workerStatus: async () => ({ status: 'done', checkPassed: true }),
    runCheck: async () => ({ ok: true, output: 'ok' }),
    ...extra,
  }
}

function brief(): string {
  return readFileSync(join(dir, SLUG, 'brief.md'), 'utf8')
}

async function startAndGoLive(turns: Map<string, MergedTurn>) {
  const started = await start({ manager: SLUG }, fake(turns, NOW))
  if (!started.ok) throw new Error(started.reason)
  await settleTrials(fake(turns, NOW + HOUR))
  return started
}

describe('next', () => {
  test('names the weakest manager and its failing pattern with enough judged turns', async () => {
    const r = await next({ now: NOW, turns: turnsOf(baseline(8, 4)) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manager).toBe(SLUG)
    expect(r.pattern?.criterion).toBe('accuracy')
    expect(r.worst.length).toBe(5)
  })

  test('says there is nothing to improve with too few judged turns', async () => {
    const r = await next({ now: NOW, turns: turnsOf(baseline(7, 4)) })
    expect(r.ok).toBe(false)
  })

  test('takes the facet from the judge when the turns read no facet file', async () => {
    const filed = baseline(8, 4).map(
      (t) =>
        ({ ...t, facetsRead: [], judge: { ...t.judge, facet: FACET } }) as unknown as MergedTurn,
    )
    const r = await next({ now: NOW, turns: turnsOf(filed) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.facet?.facet).toBe(FACET)
  })
})

describe('start', () => {
  test('backs up the brief and facet, dispatches a worker, and refuses while the trial is open', async () => {
    const turns = turnsOf(baseline(8, 4))
    let dispatched = 0
    const first = await start(
      { manager: SLUG },
      fake(turns, NOW, {
        dispatch: async (job) => {
          dispatched++
          expect(job.check).toBe(`python -I check_persona.py ${SLUG}`)
          return 'w-1'
        },
      }),
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(dispatched).toBe(1)
    const backup = join(dir, 'analytics', 'rsi', first.trial, 'before', 'brief.md')
    expect(readFileSync(backup, 'utf8')).toBe(BRIEF)

    const second = await start({ manager: SLUG }, fake(turns, NOW + HOUR))
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.reason).toContain('still editing')
    expect(dispatched).toBe(1)
  })
})

describe('autoRsiTick', () => {
  test('a first tick with enough data starts one trial and records it', async () => {
    const turns = turnsOf(baseline(8, 4))
    const state = await autoRsiTick(NOW, fake(turns, NOW))
    expect(state?.lastResult.startsWith('started ')).toBe(true)
    expect(list().length).toBe(1)
    const onDisk = JSON.parse(readFileSync(join(dir, 'analytics', 'rsi-auto.json'), 'utf8'))
    expect(onDisk).toEqual({ v: 1, lastAutoAt: NOW, lastResult: state?.lastResult })
  })

  test('a second tick within 24 hours does nothing', async () => {
    const turns = turnsOf(baseline(8, 4))
    await autoRsiTick(NOW, fake(turns, NOW))
    let dispatched = 0
    const again = await autoRsiTick(
      NOW + HOUR,
      fake(turns, NOW + HOUR, {
        dispatch: async () => {
          dispatched++
          return 'w-2'
        },
      }),
    )
    expect(again).toBeNull()
    expect(dispatched).toBe(0)
    expect(list().length).toBe(1)
  })

  test('a tick 25 hours later with an open trial records it as skipped', async () => {
    const turns = turnsOf(baseline(8, 4))
    await autoRsiTick(NOW, fake(turns, NOW))
    const later = NOW + 25 * HOUR
    const state = await autoRsiTick(later, fake(turns, later))
    expect(state?.lastAutoAt).toBe(later)
    expect(state?.lastResult).toContain('skipped: ')
    expect(state?.lastResult).toContain('is still editing')
    expect(list().length).toBe(1)
  })

  test('too little data records a skip with the judged counts', async () => {
    const turns = turnsOf(baseline(7, 4))
    const state = await autoRsiTick(NOW, fake(turns, NOW))
    expect(state?.lastResult).toContain('skipped: ')
    expect(state?.lastResult).toContain(`"${SLUG}":7`)
    expect(list().length).toBe(0)
  })

  test('AGENTHYDRA_MANAGER_RSI_AUTO=0 does nothing', async () => {
    process.env.AGENTHYDRA_MANAGER_RSI_AUTO = '0'
    const turns = turnsOf(baseline(8, 4))
    const state = await autoRsiTick(NOW, fake(turns, NOW))
    expect(state).toBeNull()
    expect(existsSync(join(dir, 'analytics', 'rsi-auto.json'))).toBe(false)
    expect(status().enabled).toBe(false)
  })
})

describe('settle', () => {
  test('editing becomes live when the worker is done and the check passed', async () => {
    const turns = turnsOf(baseline(8, 4))
    await start({ manager: SLUG }, fake(turns, NOW))
    const changes = await settleTrials(fake(turns, NOW + HOUR))
    expect(changes.changes.map((c) => c.status)).toEqual(['live'])
    expect(list()[0]?.status).toBe('live')
  })

  test('editing becomes failed and restores the backup when the worker fails', async () => {
    const turns = turnsOf(baseline(8, 4))
    await start({ manager: SLUG }, fake(turns, NOW))
    writeFileSync(join(dir, SLUG, 'brief.md'), 'worker half-edit\n')
    const changes = await settleTrials(
      fake(turns, NOW + HOUR, {
        workerStatus: async () => ({ status: 'failed', checkPassed: null }),
      }),
    )
    expect(changes.changes.map((c) => c.status)).toEqual(['failed'])
    expect(brief()).toBe(BRIEF)
  })

  test('live becomes kept when the judge average rises and corrections do not', async () => {
    const turns = turnsOf(baseline(8, 4))
    await startAndGoLive(turns)
    for (const t of baseline(8, 8, NOW + 2 * HOUR)) turns.set(t.id, t)
    const changes = await settleTrials(fake(turns, NOW + 3 * HOUR))
    expect(changes.changes.map((c) => c.status)).toEqual(['kept'])
    expect(list()[0]?.status).toBe('kept')
  })

  test('live becomes reverted, restoring the backup and re-running the check, when nothing improved', async () => {
    const turns = turnsOf(baseline(8, 4))
    await start({ manager: SLUG }, fake(turns, NOW))
    writeFileSync(join(dir, SLUG, 'brief.md'), 'worker edit\n')
    await settleTrials(fake(turns, NOW + HOUR))
    for (const t of baseline(8, 4, NOW + 2 * HOUR)) turns.set(t.id, t)
    let checked = 0
    const changes = await settleTrials(
      fake(turns, NOW + 3 * HOUR, {
        runCheck: async () => {
          checked++
          return { ok: true, output: 'ok' }
        },
      }),
    )
    expect(changes.changes.map((c) => c.status)).toEqual(['reverted'])
    expect(brief()).toBe(BRIEF)
    expect(checked).toBe(1)
  })

  test('live becomes conflict and keeps the owner edit when files changed after going live', async () => {
    const turns = turnsOf(baseline(8, 4))
    await startAndGoLive(turns)
    writeFileSync(join(dir, SLUG, 'brief.md'), 'owner edit\n')
    for (const t of baseline(8, 4, NOW + 2 * HOUR)) turns.set(t.id, t)
    let checked = 0
    const changes = await settleTrials(
      fake(turns, NOW + 3 * HOUR, {
        runCheck: async () => {
          checked++
          return { ok: true, output: 'ok' }
        },
      }),
    )
    expect(changes.changes.map((c) => c.status)).toEqual(['conflict'])
    expect(brief()).toBe('owner edit\n')
    expect(checked).toBe(0)
    expect(existsSync(join(dir, 'analytics', 'rsi.jsonl'))).toBe(true)
  })
})
