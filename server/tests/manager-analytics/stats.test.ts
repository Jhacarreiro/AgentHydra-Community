import { describe, expect, test } from 'bun:test'
import type { MergedTurn } from '../../src/manager-analytics/collect'
import { buildStats } from '../../src/manager-analytics/stats'

const T0 = Date.parse('2026-10-01T09:00:00.000Z')
const DAY = 86_400_000

function turn(over: Partial<MergedTurn>): MergedTurn {
  return {
    v: 1,
    type: 'turn',
    id: 's1:p1',
    session: 's1',
    deskChat: 'chat-1',
    parentChat: null,
    manager: 'alpha',
    picked: { decision: 'stay', source: 'router', why: 'example', p: 0.9 },
    trigger: 'owner',
    promptChars: 20,
    start: T0,
    firstOutput: T0 + 2_000,
    end: T0 + 9_000,
    firstMs: 2_000,
    totalMs: 9_000,
    outcome: 'replied',
    error: null,
    replyChars: 40,
    tools: {},
    facetsRead: [],
    sub: { opened: 0, asks: 0, answered: 0, unanswered: 0 },
    workers: [],
    tokens: { in: 10, out: 4, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.001,
    signals: [],
    verdicts: [],
    judge: null,
    ...over,
  } as unknown as MergedTurn
}

const NOW = T0 + 60_000

describe('buildStats', () => {
  test('a manager line reads turns, answered rate and corrections', () => {
    const all = new Map<string, MergedTurn>([
      [
        's1:p1',
        turn({
          id: 's1:p1',
          signals: [
            {
              v: 1,
              type: 'signal',
              turn: 's1:p1',
              from: 'owner',
              label: 'correction',
              rule: 'CORRECT',
              at: T0,
            },
          ] as never,
        }),
      ],
      [
        's1:p2',
        turn({ id: 's1:p2', start: T0 + 1_000, outcome: 'error', error: 'example failure' }),
      ],
    ])
    const answer = buildStats(all, { now: NOW, days: 7 })
    expect(answer.managers.alpha.line).toBe('2 turns · 50% answered · 1 correction')
    expect(answer.managers.alpha.owner.correction).toBe(1)
    expect(answer.managers.alpha.outcomes).toEqual({ replied: 1, error: 1 })
  })

  test('worst turns put the lowest judge score first and carry the Desk chat title', () => {
    const all = new Map<string, MergedTurn>([
      ['s1:p1', turn({ id: 's1:p1', judge: { score: 9 } as never })],
      [
        's1:p2',
        turn({ id: 's1:p2', start: T0 + 1_000, judge: { score: 3, why: 'example miss' } as never }),
      ],
    ])
    const titles = new Map([['chat-1', 'Example chat one']])
    const [first] = buildStats(all, { now: NOW, days: 7, worst: 1, titles }).managers.alpha.worst
    expect(first).toMatchObject({
      turn: 's1:p2',
      judge: 3,
      why: 'example miss',
      title: 'Example chat one',
    })
    expect(first).not.toHaveProperty('link')
  })

  test('open turns count per manager, with idle time, live state and the stuck count', () => {
    const ago = (min: number) => NOW - min * 60_000
    const open = [
      {
        turn: 's1:p9',
        session: 's1',
        deskChat: 'chat-1',
        manager: 'alpha',
        since: ago(41),
        lastTs: ago(40),
        working: true,
      },
      {
        turn: 's2:p3',
        session: 's2',
        deskChat: 'chat-2',
        manager: 'beta',
        since: ago(3),
        lastTs: ago(2),
        working: null,
      },
    ]
    const titles = new Map([
      ['chat-1', 'Example chat one'],
      ['chat-2', 'Example chat two'],
    ])
    const answer = buildStats(new Map(), { now: NOW, days: 7, open, titles })
    expect(answer.managers.alpha).toMatchObject({ turns: 0, open: 1, stuckNow: 1 })
    expect(answer.managers.alpha.openTurns).toEqual([
      {
        turn: 's1:p9',
        session: 's1',
        deskChat: 'chat-1',
        title: 'Example chat one',
        since: ago(41),
        idleMs: 40 * 60_000,
        working: true,
      },
    ])
    expect(answer.managers.beta).toMatchObject({ open: 1, stuckNow: 0 })
  })

  test('router picks are counted by source', () => {
    const picks = [
      { decision: 'stay', source: 'jev', why: 'example', p: 0.9 },
      { decision: 'stay', source: 'keywords', why: 'example', p: 0.5 },
      { decision: 'stay', source: 'router', why: 'pinned by AGENTHYDRA_MANAGER', p: null },
      { decision: 'stay', source: 'desk-pin', why: 'pinned in Desk', p: null },
      { decision: 'stay', source: 'at-name', why: 'example', p: null },
      { decision: 'stay', source: 'continuation', why: 'example', p: null },
      null,
    ]
    const all = new Map<string, MergedTurn>(
      picks.map((p, i): [string, MergedTurn] => [
        `s1:p${i}`,
        turn({ id: `s1:p${i}`, start: T0 + i * 1_000, picked: p as never }),
      ]),
    )
    expect(buildStats(all, { now: NOW, days: 7 }).managers.alpha.picked).toEqual({
      jev: 1,
      keywords: 1,
      pinned: 2,
      atName: 1,
      continuation: 1,
      other: 1,
    })
  })

  test('turns older than the look-back window are left out', () => {
    const all = new Map<string, MergedTurn>([
      ['s1:old', turn({ id: 's1:old', start: T0 - 10 * DAY })],
      ['s1:new', turn({ id: 's1:new' })],
    ])
    expect(buildStats(all, { now: NOW, days: 7 }).managers.alpha.turns).toBe(1)
    expect(buildStats(all, { now: NOW, days: 'all' }).managers.alpha.turns).toBe(2)
  })

  test('a manager filter keeps only that manager', () => {
    const all = new Map<string, MergedTurn>([
      ['s1:p1', turn({ id: 's1:p1' })],
      ['s2:p1', turn({ id: 's2:p1', session: 's2', manager: 'beta' })],
    ])
    expect(Object.keys(buildStats(all, { now: NOW, days: 7, manager: 'beta' }).managers)).toEqual([
      'beta',
    ])
  })

  test('a turn the judge filed under a facet counts for that facet without a facet file read', () => {
    const judge = {
      v: 1,
      type: 'judge',
      turn: 's1:p1',
      score: 6,
      criteria: {},
      facet: '02-example.md',
      why: 'example reason',
      model: 'example-model',
      costUsd: null,
      at: T0,
    } as never
    const all = new Map<string, MergedTurn>([['s1:p1', turn({ id: 's1:p1', judge })]])
    expect(buildStats(all, { now: NOW, days: 7 }).managers.alpha.facets).toEqual([
      { facet: '02-example.md', turns: 1, judgeAvg: 6, correctionRate: null },
    ])
    expect(
      Object.keys(buildStats(all, { now: NOW, days: 7, facet: '02-example.md' }).managers),
    ).toEqual(['alpha'])
  })
})
