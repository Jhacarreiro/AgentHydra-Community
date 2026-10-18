import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyDoc, parseHydra, renderHydra } from '../src/hydra-core/hydra-md'
import { appendLog, readLog, statsOf } from '../src/hydra-core/log'
import { chatPaths } from '../src/hydra-core/paths'
import { reportRun } from '../src/hydra-core/report-row'
import { readSent, writeSent } from '../src/hydra-core/sent'
import * as tree from '../src/hydra-core/tree'
import { answer, findTool, scope } from '../src/hydra-core/tree'
import { scratch, startChat } from './hydra-core-fixture'

let dir = ''
const now = new Date('2026-10-13T10:00:00.000Z')

type Ev = Record<string, unknown>
const events = (): Ev[] => readLog(dir).events
const of = (kind: string): Ev[] => events().filter((e) => e.event === kind)

function plantPricing(n: number): void {
  const list = Array.from({ length: n }, (_, i) => ({
    id: `knowledge:pricing-rule-${i}`,
    kind: 'knowledge',
    name: `Pricing rule ${i}`,
    when: `Pricing rule ${i} for plans`,
    tags: ['pricing'],
    cost: 'free',
    how: `read pricing rule ${i}`,
    load: { type: 'none' },
  }))
  writeFileSync(join(dir, 'catalog', 'hand-pricing.json'), JSON.stringify(list))
}

beforeEach(() => {
  dir = scratch()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('A5-F3: a none answer at q6pick logs a miss for every id shown, with the better text', () => {
  startChat(dir, 'f3-lead', 'redesign the pricing page')
  scope(dir, 'f3-lead', now)
  const q6 = answer(dir, 'f3-lead', { answer: 'yes 3: redesign the pricing page' }, now)
  const shown = (q6.matches as { id: string }[]).map((m) => m.id)
  expect(shown.length).toBeGreaterThan(0)
  answer(dir, 'f3-lead', { answer: 'none: a lead who has priced a product before' }, now)
  const misses = of('miss')
  expect(misses.map((m) => m.id)).toEqual(shown)
  expect(misses[0]).toMatchObject({
    chat: 'f3-lead',
    why: 'none',
    better: 'a lead who has priced a product before',
  })
})

test('A5-F3: a none answer at q7pick and q8pick logs the page shown as misses', () => {
  const chat = 'f3-team'
  startChat(dir, chat, 'Rebuild the dashboard layout')
  scope(dir, chat, now)
  answer(dir, chat, { answer: 'yes: rebuild the dashboard layout' }, now)
  answer(dir, chat, { answer: 'delegate' }, now)
  answer(dir, chat, { answer: '3' }, now)
  answer(dir, chat, { answer: '2' }, now)
  answer(dir, chat, { answer: 'dashboard' }, now)
  answer(dir, chat, { answer: 'none' }, now)
  const q7 = answer(dir, chat, { answer: 'design: dashboard layout' }, now)
  expect(q7.step).toBe('q7pick')
  const team = (q7.matches as { id: string }[]).map((m) => m.id)
  const before = of('miss').length
  answer(dir, chat, { answer: 'none' }, now)
  const q7misses = of('miss').slice(before)
  expect(q7misses.map((m) => m.id)).toEqual(team)
  expect(q7misses[0]).toMatchObject({ why: 'none', need: 'dashboard layout' })
  const q8 = answer(dir, chat, { answer: 'dashboard styling' }, now)
  expect(q8.step).toBe('q8pick')
  const know = (q8.matches as { id: string }[]).map((m) => m.id)
  const mid = of('miss').length
  answer(dir, chat, { answer: 'none: the colour tokens file' }, now)
  const q8misses = of('miss').slice(mid)
  expect(q8misses.map((m) => m.id)).toEqual(know)
  expect(q8misses[0]).toMatchObject({ why: 'none', better: 'the colour tokens file' })
})

test('A5-F4: every core_find logs a find line with its ids and total, not only the empty ones', () => {
  const r = findTool(dir, { need: 'dashboard layout', chat: 'f4' }, now)
  expect(r.matches.length).toBeGreaterThan(0)
  findTool(dir, { need: 'nothing here zzz', chat: 'f4' }, now)
  const finds = of('find')
  expect(finds.length).toBe(2)
  expect(finds[0]).toMatchObject({
    chat: 'f4',
    need: 'dashboard layout',
    ids: r.matches.map((m) => m.id),
    total: r.total,
  })
  expect(finds[1]).toMatchObject({ ids: [], total: 0 })
})

test('A5-F7: more with no page in memory recomputes the previous page and logs its misses', () => {
  plantPricing(12)
  const first = findTool(dir, { need: 'pricing rule plans', chat: 'f7-other' }, now)
  const fresh = findTool(dir, { need: 'pricing rule plans', chat: 'f7-fresh', more: true }, now)
  const misses = of('miss').filter((m) => m.chat === 'f7-fresh')
  expect(misses.map((m) => m.id)).toEqual(first.matches.map((m) => m.id))
  expect(fresh.matches.map((m) => m.id)).not.toEqual(first.matches.map((m) => m.id))
})

test('A5-F7: a call with no chat never shares a page with another chat-less caller', () => {
  plantPricing(12)
  const need = 'pricing rule plans'
  findTool(dir, { need }, now)
  const a = findTool(dir, { need, more: true }, now)
  const b = findTool(dir, { need, more: true }, now)
  expect(b.matches.map((m) => m.id)).toEqual(a.matches.map((m) => m.id))
})

test('A5-F7: the page memory keeps only the last 200 keys', () => {
  plantPricing(12)
  const need = 'pricing rule plans'
  findTool(dir, { need, chat: 'f7-cap' }, now)
  const page2 = findTool(dir, { need, chat: 'f7-cap', more: true }, now)
  for (let i = 0; i < 200; i++) findTool(dir, { need, chat: `f7-filler-${i}` }, now)
  const again = findTool(dir, { need, chat: 'f7-cap', more: true }, now)
  expect(again.matches.map((m) => m.id)).toEqual(page2.matches.map((m) => m.id))
})

test('A5-F8: core_report refuses an outcome other than done, partial or failed', () => {
  expect(() => reportRun(dir, { chat: 'f8', outcome: 'banana', note: '' })).toThrow(/outcome/)
  expect(of('report')).toEqual([])
})

test('A5-F8: a report with no open run is stored, and the reply warns that no run is open', () => {
  const r = reportRun(dir, { chat: 'f8-none', outcome: 'done', note: 'ok' }) as Ev
  expect(r.run).toBeNull()
  expect(String(r.warning)).toContain('no run')
  expect(of('report')).toHaveLength(1)
  startChat(dir, 'f8-open', 'fix the typo in README')
  scope(dir, 'f8-open', now)
  expect((reportRun(dir, { chat: 'f8-open', outcome: 'done', note: '' }) as Ev).warning).toBe(
    undefined,
  )
})

test('A5-F9: a catalog skip is logged once per file, id and why until the file changes', () => {
  const bad = join(dir, 'catalog', 'hand-bad.json')
  writeFileSync(
    bad,
    JSON.stringify([
      {
        id: 'person:no-tier',
        kind: 'person',
        name: 'No Tier',
        when: 'x',
        tags: [],
        cost: 'free',
        how: 'x',
        load: { type: 'none' },
      },
    ]),
  )
  for (let i = 0; i < 3; i++) findTool(dir, { need: 'dashboard', chat: 'f9' }, now)
  expect(of('skip')).toHaveLength(1)
  const later = new Date(Date.now() + 60_000)
  utimesSync(bad, later, later)
  findTool(dir, { need: 'dashboard', chat: 'f9' }, now)
  expect(of('skip')).toHaveLength(2)
})

test('A5-F9: log.jsonl rotates into log-YYYY-MM.jsonl at a new month, and readLog takes a since-date', () => {
  appendLog(dir, { event: 'old' }, new Date('2026-09-30T23:00:00Z'))
  appendLog(dir, { event: 'new' }, new Date('2026-10-01T01:00:00Z'))
  expect(existsSync(join(dir, 'log-2026-09.jsonl'))).toBe(true)
  expect(readFileSync(join(dir, 'log.jsonl'), 'utf8')).not.toContain('"old"')
  expect(readLog(dir).events.map((e) => e.event)).toEqual(['old', 'new'])
  expect(readLog(dir, new Date('2026-10-01T00:00:00Z')).events.map((e) => e.event)).toEqual(['new'])
})

test('A5-F9: log.jsonl rotates past 20 MB within a month', () => {
  const big = `${JSON.stringify({ at: '2026-10-02T00:00:00.000Z', event: 'pad', x: 'y'.repeat(1000) })}\n`
  writeFileSync(join(dir, 'log.jsonl'), big.repeat(21 * 1024))
  appendLog(dir, { event: 'after' }, new Date('2026-10-03T00:00:00Z'))
  expect(existsSync(join(dir, 'log-2026-10.jsonl'))).toBe(true)
  expect(readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
})

test('A5-F10: core_stats counts questions asked and defaulted, pushback by chat, none misses and finds', () => {
  const chat = 'f10'
  startChat(dir, chat, 'Rebuild the dashboard layout')
  writeFileSync(chatPaths(dir, chat).hydraMd, renderHydra(emptyDoc(now)))
  scope(dir, chat, now)
  answer(dir, chat, { answer: 'yes: dashboard layout' }, now)
  answer(dir, chat, { answer: 'new' }, now)
  answer(dir, chat, { answer: 'myself' }, now)
  findTool(dir, { need: 'dashboard', chat }, now)
  findTool(dir, { need: 'nothing here zzz', chat }, now)
  appendLog(dir, { event: 'president-block', chat }, now)
  appendLog(dir, { event: 'president-block', chat }, now)
  appendLog(dir, { event: 'miss', id: 'person:iris-ui', need: 'x', why: 'none' }, now)
  const s = statsOf(dir) as Ev
  expect(s.questions).toMatchObject({
    q1: { asked: 1, defaulted: 0 },
    q2: { asked: 1, defaulted: 1 },
    q3: { asked: 1, defaulted: 1 },
  })
  expect(s.pushback).toEqual({ [chat]: 2 })
  expect(s.noneMisses).toEqual({ 'person:iris-ui': 1 })
  expect(s.finds).toEqual({ total: 2, empty: 1 })
})

test('A5-F2: the done reply asks once for core_report, and core_stats shows the report rate', () => {
  const chat = 'f2'
  startChat(dir, chat, 'fix the typo in README')
  scope(dir, chat, now)
  const done = answer(dir, chat, { answer: 'no 1' }, now)
  expect(String(done.report)).toContain('core_report')
  expect(String(done.report)).toContain('outcome')
  expect(String(done.report)).toContain('score')
  startChat(dir, chat, 'and the other typo')
  scope(dir, chat, now)
  answer(dir, chat, { answer: 'no' }, now)
  reportRun(dir, { chat, outcome: 'done', note: '', score: 4 })
  expect((statsOf(dir) as Ev).reportRate).toEqual({ runs: 2, reported: 1, rate: 0.5 })
})

test('A5-F12: hydra.md keeps the last 20 scope-log lines', () => {
  const doc = emptyDoc(now)
  doc.scopeLog = Array.from({ length: 25 }, (_, i) => `- line ${i}`)
  const back = parseHydra(renderHydra(doc))
  expect(back?.scopeLog).toHaveLength(20)
  expect(back?.scopeLog[0]).toBe('- line 5')
  expect(back?.scopeLog[19]).toBe('- line 24')
})

test('A5-F12: sent.json drops sessions not seen in 7 days and keeps the lead owed', () => {
  const file = chatPaths(dir, 'f12').sent
  const t0 = new Date('2026-10-01T00:00:00Z')
  writeSent(file, { old: ['person:iris-ui'], '(lead owed)': ['person:ops-lead'] }, 'old', t0)
  const later = new Date('2026-10-09T00:00:00Z')
  writeSent(file, { ...readSent(file), fresh: ['knowledge:brand-notes'] }, 'fresh', later)
  const sent = readSent(file)
  expect(Object.keys(sent).sort()).toEqual(['(lead owed)', 'fresh'])
  writeSent(
    file,
    { ...readSent(file), fresh: ['knowledge:brand-notes', 'person:iris-ui'] },
    'fresh',
    later,
  )
  expect(readSent(file).fresh).toHaveLength(2)
})

test('A5-F13: tree.ts has no second report writer', () => {
  expect('report' in tree).toBe(false)
})
