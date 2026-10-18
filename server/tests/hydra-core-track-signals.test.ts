import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildTrack } from '../src/hydra-core/track'
import { scratch } from './hydra-core-fixture'

const T = Date.parse('2026-10-13T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const line = (o: object) => `${JSON.stringify(o)}\n`
const user = (sid: string, at: number, text: string) =>
  line({
    type: 'user',
    sessionId: sid,
    cwd: 'C:/Users/me/app',
    timestamp: iso(at),
    message: { role: 'user', content: text },
  })
const call = (sid: string, at: number, id: string, name: string, input: object) =>
  line({
    type: 'assistant',
    sessionId: sid,
    timestamp: iso(at),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  })
const result = (sid: string, at: number, id: string, text: string) =>
  line({
    type: 'user',
    sessionId: sid,
    timestamp: iso(at),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  })

let dir = ''
let roots: string[] = []
const handoffs = () => join(dir, 'handoffs')

function transcript(text: string): void {
  mkdirSync(join(dir, 'projects', 'proj'), { recursive: true })
  writeFileSync(join(dir, 'projects', 'proj', 'sx.jsonl'), text)
}
const log = (...rows: object[]) => appendFileSync(join(dir, 'log.jsonl'), rows.map(line).join(''))
const build = () => buildTrack(dir, { roots, handoffsDir: handoffs(), now: T + 60_000 })

beforeEach(() => {
  dir = scratch()
  roots = [join(dir, 'projects')]
  mkdirSync(handoffs(), { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('A5-F5: a core_use of a person counts as used, and unused is offered-not-taken per entry', () => {
  transcript(
    user('sx', T, 'design the page') +
      call('sx', T + 1000, 's1', 'mcp__agenthydra__core_scope', { chat: 'alpha' }) +
      result('sx', T + 1500, 's1', 'matches: person:iris-ui knowledge:brand-notes') +
      call('sx', T + 2000, 'u1', 'mcp__agenthydra__core_use', {
        chat: 'alpha',
        id: 'person:iris-ui',
        mode: 'consult',
      }) +
      result('sx', T + 2500, 'u1', 'ok'),
  )
  log(
    { at: iso(T + 1000), chat: 'alpha', run: 1, step: 'start' },
    {
      at: iso(T + 1200),
      event: 'pack',
      chat: 'alpha',
      session: 'sx',
      ids: ['person:iris-ui', 'knowledge:brand-notes'],
      pasted: [],
    },
    {
      at: iso(T + 2000),
      chat: 'alpha',
      event: 'seat-opened',
      mode: 'consult',
      id: 'person:iris-ui',
    },
  )
  const { rows, summary } = build()
  expect(rows[0]?.used).toContain('person:iris-ui')
  expect(rows[0]?.notTaken).toEqual(['knowledge:brand-notes'])
  expect(summary.picks).toEqual({ total: 1 })
  expect(summary.entries).toEqual({
    offered: 2,
    taken: 1,
    neverTaken: 1,
    notTaken: [{ id: 'knowledge:brand-notes', offered: 1 }],
  })
})

test('A5-F5: a pick answer by number counts its entry as taken', () => {
  log({
    at: iso(T),
    chat: 'alpha',
    run: 1,
    step: 'q8pick',
    answer: '2',
    kw: 'picks',
    shown: ['knowledge:brand-notes', 'person:iris-ui'],
  })
  expect(build().summary.entries).toMatchObject({ offered: 2, taken: 1, neverTaken: 1 })
})

test('A5-F6: offered ids are only the five catalog kinds, and usedNotOffered only calls that map to an entry', () => {
  transcript(
    user('sx', T, 'take a screenshot') +
      call('sx', T + 1000, 'f1', 'mcp__agenthydra__core_find', { need: 'screens' }) +
      result('sx', T + 1500, 'f1', 'local:true file:line py:194 lead:Example person:iris-ui') +
      call('sx', T + 2000, 'b1', 'mcp__browser__browser_click', {}) +
      result('sx', T + 2500, 'b1', 'ok') +
      call('sx', T + 3000, 'c1', 'mcp__screen-capture__shot', {}) +
      result('sx', T + 3500, 'c1', 'ok'),
  )
  const { rows, summary } = build()
  expect(rows[0]?.offered).toEqual(['person:iris-ui'])
  expect(rows[0]?.used).toEqual(['instrument:screen-capture'])
  expect(rows[0]?.usedNotOffered).toEqual(['instrument:screen-capture'])
  expect(summary.usedNotOffered).toBe(1)
})

test('A5-F11: runs and reports come from the log, deliveries with no turn are their own number', () => {
  transcript(
    user('sx', T, 'fix it') +
      call('sx', T + 1000, 's1', 'mcp__agenthydra__core_scope', { chat: 'alpha' }) +
      result('sx', T + 1500, 's1', 'q1'),
  )
  log(
    { at: iso(T + 1000), chat: 'alpha', run: 1, step: 'start' },
    { at: iso(T + 1100), chat: 'alpha', run: 1, step: 'end', verdict: 'go' },
    { at: iso(T + 1200), event: 'pack', chat: 'alpha', session: 'sx', ids: [] },
    { at: iso(T + 2000), chat: 'gamma', run: 1, step: 'start' },
    { at: iso(T + 2100), chat: 'gamma', run: 1, step: 'end', verdict: 'hydra' },
    { at: iso(T + 3000), chat: 'gamma', run: 2, step: 'start' },
    { at: iso(T + 3200), event: 'pack', chat: 'gamma', session: 'ghost', ids: [] },
    { at: iso(T + 4000), chat: 'alpha', run: 1, event: 'report', outcome: 'done', score: 4 },
    { at: iso(T + 4100), chat: 'gamma', run: 2, event: 'report', outcome: 'partial' },
    { at: iso(T + 4200), chat: 'gamma', run: 9, event: 'report', outcome: 'done' },
    { at: iso(T + 4300), chat: 'delta', run: null, event: 'report', outcome: 'failed' },
  )
  const { summary } = build()
  expect(summary.scopes).toEqual({ total: 3, go: 1, hydra: 1, none: 1 })
  expect(summary.reports).toMatchObject({ runs: 3, reported: 2, rate: 0.667, noRun: 1 })
  expect(summary.deliveries).toEqual({ total: 2, matched: 1, noTurn: 1 })
})
