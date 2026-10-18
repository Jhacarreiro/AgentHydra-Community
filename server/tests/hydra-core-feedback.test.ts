import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CatalogEntry, loadCatalog } from '../src/hydra-core/catalog'
import {
  doubted,
  exempt,
  type Feedback,
  feedbackPath,
  foldFeedback,
  foldIfDue,
  movers,
  needsPath,
  priorOf,
  readFeedback,
  stale,
} from '../src/hydra-core/feedback'
import { rankEntries } from '../src/hydra-core/find'
import { appendLog, readLog } from '../src/hydra-core/log'
import { matchFor, packFor } from '../src/hydra-core/pack'
import { chatPaths } from '../src/hydra-core/paths'
import { readSent, writeSent } from '../src/hydra-core/sent'
import { findTool } from '../src/hydra-core/tree'
import { CORE_TOOLS } from '../src/mcp-core'
import { scratch } from './hydra-core-fixture'

let dir = ''
const now = new Date('2026-10-14T12:00:00.000Z')
const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000)
const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  dir = scratch()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function plant(events: [number, Record<string, unknown>][]): void {
  for (const [daysAgo, e] of events) appendLog(dir, e, at(daysAgo))
}

function plantFeedback(entries: Feedback['entries'], base = 0.2): void {
  writeFileSync(
    feedbackPath(dir),
    JSON.stringify({ at: now.toISOString(), since: at(90).toISOString(), base, entries }),
  )
}

const k = (name: string, when: string, extra: Partial<CatalogEntry> = {}): CatalogEntry =>
  ({
    id: `knowledge:${name}`,
    kind: 'knowledge',
    name,
    when,
    tags: [],
    cost: 'free',
    how: '',
    load: { type: 'none' },
    ...extra,
  }) as CatalogEntry

test('B4b-1: the fold counts offered, taken, rejected and reported per entry from the last 90 days', () => {
  plant([
    [120, { event: 'pack', chat: 'c0', ids: ['knowledge:brand-notes'] }],
    [5, { event: 'pack', chat: 'c1', ids: ['knowledge:brand-notes', 'person:iris-ui'] }],
    [5, { event: 'placement', phase: 'launch', chat: 'c2', ids: ['knowledge:brand-notes'] }],
    [5, { event: 'find', chat: 'c1', need: 'brand', ids: ['instrument:screen-capture'] }],
    [4, { chat: 'c1', run: 1, step: 'start' }],
    [
      4,
      {
        chat: 'c1',
        run: 1,
        step: 'q2',
        answer: 'x',
        shown: ['person:iris-ui', 'knowledge:brand-notes'],
      },
    ],
    [
      4,
      {
        chat: 'c1',
        run: 1,
        step: 'q3pick',
        answer: '1',
        shown: ['person:iris-ui', 'knowledge:brand-notes'],
      },
    ],
    [4, { chat: 'c1', event: 'use', mode: 'become', id: 'person:ops-lead' }],
    [4, { chat: 'c1', event: 'miss', id: 'instrument:screen-capture', need: 'brand', why: 'more' }],
    [
      4,
      {
        chat: 'c1',
        event: 'miss',
        id: 'knowledge:brand-notes',
        need: 'logo',
        why: 'none',
        better: 'a logo kit',
      },
    ],
    [
      3,
      {
        chat: 'c1',
        run: 1,
        event: 'report',
        outcome: 'done',
        score: 5,
        overruled: ['person:ops-lead'],
      },
    ],
  ])
  const fb = foldFeedback(dir, now)
  // The pack and placement lines carry no `pasted` list: their knowledge and person ids may have been pasted
  // in full, so they count as pasted, not offered; the run's shown list is an offer.
  expect(fb.entries['knowledge:brand-notes']).toEqual({
    offered: 1,
    pasted: 2,
    taken: 0,
    rejected: 1,
    reported: 0,
  })
  expect(fb.entries['person:iris-ui']).toEqual({
    offered: 1,
    pasted: 1,
    taken: 1,
    rejected: 0,
    reported: 2,
  })
  expect(fb.entries['person:ops-lead']).toEqual({
    offered: 0,
    pasted: 0,
    taken: 1,
    rejected: 0,
    reported: 1,
  })
  expect(fb.entries['instrument:screen-capture']).toEqual({
    offered: 1,
    pasted: 0,
    taken: 0,
    rejected: 1,
    reported: 0,
  })
  expect(fb.base).toBeCloseTo(2 / 3, 5)
  expect(JSON.parse(readFileSync(feedbackPath(dir), 'utf8'))).toEqual(fb)
})

test('B4b-2: the prior raises a taken entry and lowers a rejected one, only past 10 offers', () => {
  const entries = [
    k('alpha', 'release checklist notes'),
    k('beta', 'release checklist notes'),
    k('gamma', 'release checklist notes'),
  ]
  const fb: Feedback = {
    at: now.toISOString(),
    since: at(90).toISOString(),
    base: 0.2,
    entries: {
      'knowledge:alpha': { offered: 20, taken: 0, rejected: 6, reported: 0 },
      'knowledge:gamma': { offered: 20, taken: 10, rejected: 0, reported: 0 },
    },
  }
  const plain = rankEntries(entries, 'release checklist')
  const ranked = rankEntries(entries, 'release checklist', { feedback: fb })
  expect(plain.map((s) => s.entry.id)).toEqual([
    'knowledge:alpha',
    'knowledge:beta',
    'knowledge:gamma',
  ])
  expect(ranked.map((s) => s.entry.id)).toEqual([
    'knowledge:gamma',
    'knowledge:beta',
    'knowledge:alpha',
  ])
  const base = plain[0].score
  expect(ranked[0].score).toBeCloseTo(base * (1 + 0.5 * (11 / 22 - 0.2)), 5)
  expect(ranked[2].score).toBeCloseTo(base * (1 + 0.5 * (1 / 22 - 0.2)), 5)
  // Under 10 offers an entry keeps a fair start, however it fared.
  const young: Feedback = {
    ...fb,
    entries: { 'knowledge:alpha': { offered: 9, taken: 0, rejected: 9, reported: 0 } },
  }
  expect(priorOf(young, { id: 'knowledge:alpha' })).toBe(1)
  expect(priorOf(null, { id: 'knowledge:alpha' })).toBe(1)
  // Bounded: a perfect record moves the score by at most half.
  const best: Feedback = {
    ...fb,
    base: 0,
    entries: { 'knowledge:alpha': { offered: 400, taken: 400, rejected: 0, reported: 0 } },
  }
  expect(priorOf(best, { id: 'knowledge:alpha' })).toBe(1.25)
})

test('B4b-3: a pack drops knowledge offered as a pointer 50+ times and never taken', () => {
  writeFileSync(
    join(dir, 'catalog', 'hand-extra.json'),
    JSON.stringify([k('zeta-notes', 'quarterly ledger', { how: 'open it' })]),
  )
  // A score of MATCH_MIN: a one-line pointer, where taking it (core_find, core_use) is logged.
  const prompt = 'quarterly ledger'
  // Base 0: the prior is about 1, so only the stale rule can drop it.
  plantFeedback({ 'knowledge:zeta-notes': { offered: 60, taken: 0, rejected: 0, reported: 0 } }, 0)
  const pack = packFor(
    dir,
    { chat: 'p1', session: 's1', cwd: 'C:/Users/me/app', prompt, lead: null, dry: true },
    now,
  )
  expect(pack.ids).not.toContain('knowledge:zeta-notes')
  // Taken once, it stays.
  plantFeedback({ 'knowledge:zeta-notes': { offered: 60, taken: 1, rejected: 0, reported: 0 } }, 0)
  const kept = packFor(
    dir,
    { chat: 'p3', session: 's1', cwd: 'C:/Users/me/app', prompt, lead: null, dry: true },
    now,
  )
  expect(kept.ids).toContain('knowledge:zeta-notes')
})

test('B4b-fix-1b: knowledge pasted in full is never dropped as stale nor held to the doubted bar', () => {
  const notes = join(dir, 'brand-notes.md')
  writeFileSync(notes, 'Brand notes: colours and type for the dashboard.\n')
  // Counts that dropped it before: offered 60 and 500, never taken, rejected more often than taken. Base 0 keeps
  // the prior about 1, so only the stale rule and the doubted bar are in play.
  for (const offered of [60, 500]) {
    plantFeedback({ 'knowledge:brand-notes': { offered, taken: 0, rejected: 5, reported: 0 } }, 0)
    // A score of 22 (a name hit): pasted in full in the pack and in the per-message match.
    const prompt = 'the brand notes: colours and type rules for the dashboard'
    const pack = packFor(
      dir,
      { chat: `p${offered}`, session: 's1', cwd: 'C:/Users/me/app', prompt, lead: null, dry: true },
      now,
    )
    expect(pack.ids).toContain('knowledge:brand-notes')
    expect(pack.text).toContain('Brand notes: colours and type for the dashboard.')
    const chat = `m${offered}`
    fs.mkdirSync(chatPaths(dir, chat).root, { recursive: true })
    writeSent(chatPaths(dir, chat).sent, { s1: [] }, 's1', now)
    const m = matchFor(
      dir,
      { chat, session: 's1', cwd: 'C:/Users/me/app', prompt, placement: 'file' },
      now,
    )
    expect(m.ids).toContain('knowledge:brand-notes')
    expect(m.text).toContain('Brand notes: colours and type for the dashboard.')
    // A score of 16 puts it below INLINE_MIN in the pack: a pointer, where the stale rule drops it.
    const weak = packFor(
      dir,
      {
        chat: `w${offered}`,
        session: 's1',
        cwd: 'C:/Users/me/app',
        prompt: 'which brand colours and type rules apply to the dashboard',
        lead: null,
        dry: true,
      },
      now,
    )
    expect(weak.ids).not.toContain('knowledge:brand-notes')
  }
})

test('B4b-fix-1a: a pinned ruling and a folder rule are exempt from every feedback effect', () => {
  const text = join(dir, 'house-ruling.md')
  writeFileSync(text, 'House ruling: never force-push a shared branch.\n')
  const file = { type: 'file', path: text } as const
  // No pinned- prefix on the id: the catalog marks a pinned entry by the file it came from.
  writeFileSync(
    join(dir, 'catalog', 'generated-pinned.json'),
    JSON.stringify([k('house-ruling', 'quarterly ledger', { how: 'read it', load: file })]),
  )
  writeFileSync(
    join(dir, 'catalog', 'hand-extra.json'),
    JSON.stringify([
      k('plain-ruling', 'quarterly ledger', { how: 'read it', load: file }),
      k('repo-rules', 'quarterly ledger', {
        how: 'read it',
        load: file,
        tags: ['repo'],
        folders: ['C:/Users/me/other'],
      }),
    ]),
  )
  const never = { offered: 500, taken: 0, rejected: 9, reported: 0 }
  plantFeedback({
    'knowledge:house-ruling': never,
    'knowledge:plain-ruling': never,
    'knowledge:repo-rules': never,
  })
  const catalog = loadCatalog(dir).entries
  const pinned = catalog.get('knowledge:house-ruling') as CatalogEntry
  const plain = catalog.get('knowledge:plain-ruling') as CatalogEntry
  const rule = catalog.get('knowledge:repo-rules') as CatalogEntry
  expect(pinned.pinned).toBe(true)
  expect(plain.pinned).toBeUndefined()
  const fb = readFeedback(dir)
  for (const e of [pinned, rule]) {
    expect(exempt(e)).toBe(true)
    expect(priorOf(fb, e)).toBe(1)
    expect(stale(fb, e)).toBe(false)
    expect(doubted(fb, e)).toBe(false)
  }
  expect(exempt(plain)).toBe(false)
  expect(priorOf(fb, plain)).toBeLessThan(1)
  // A score of exactly MATCH_MIN, offered as a pointer: the pinned ruling is attached at the normal bar, the
  // same entry outside the pinned catalog is not.
  const pack = packFor(
    dir,
    {
      chat: 'x1',
      session: 's1',
      cwd: 'C:/Users/me/app',
      prompt: 'quarterly ledger',
      lead: null,
      dry: true,
    },
    now,
  )
  expect(pack.ids).toContain('knowledge:house-ruling')
  expect(pack.ids).not.toContain('knowledge:plain-ruling')
  const inFolder = packFor(
    dir,
    {
      chat: 'x2',
      session: 's1',
      cwd: 'C:/Users/me/other',
      prompt: 'quarterly ledger',
      lead: null,
      dry: true,
    },
    now,
  )
  expect(inFolder.ids).toContain('knowledge:repo-rules')
  const learned = movers(fb, catalog)
  expect([...learned.up, ...learned.down].map((m) => m.id)).toEqual(['knowledge:plain-ruling'])
})

test('B4b-fix-1c: the fold counts pasted text apart from pointer offers; the prior and core_stats see offers only', () => {
  writeFileSync(
    join(dir, 'catalog', 'hand-extra.json'),
    JSON.stringify([k('zeta-notes', 'quarterly ledger', { how: 'open it' })]),
  )
  // The pack's log line names what it pasted in full.
  const brand = 'the brand notes: colours and type rules for the dashboard'
  packFor(
    dir,
    { chat: 'f1', session: 's1', cwd: 'C:/Users/me/app', prompt: brand, lead: null },
    now,
  )
  packFor(
    dir,
    { chat: 'f2', session: 's1', cwd: 'C:/Users/me/app', prompt: 'quarterly ledger', lead: null },
    now,
  )
  const packs = readLog(dir).events.filter((e) => e.event === 'pack')
  expect(packs[0].pasted).toContain('knowledge:brand-notes')
  expect(packs[1].ids).toContain('knowledge:zeta-notes')
  expect(packs[1].pasted).not.toContain('knowledge:zeta-notes')
  fs.mkdirSync(chatPaths(dir, 'f3').root, { recursive: true })
  writeSent(chatPaths(dir, 'f3').sent, { s1: [] }, 's1', now)
  const placed = matchFor(
    dir,
    { chat: 'f3', session: 's1', cwd: 'C:/Users/me/app', prompt: brand, placement: 'file' },
    now,
  )
  expect(placed.ids).toContain('knowledge:brand-notes')
  const line = readLog(dir).events.find((e) => e.event === 'placement' && e.phase === 'message')
  expect(line?.pasted).toContain('knowledge:brand-notes')

  // Pasted 60 times and never taken: before, 60 offers that lowered its prior and listed it in core_stats.
  rmSync(join(dir, 'log.jsonl'), { force: true })
  for (let i = 0; i < 60; i++)
    plant([
      [
        5,
        {
          event: 'pack',
          chat: `c${i}`,
          ids: ['knowledge:brand-notes', 'knowledge:zeta-notes'],
          pasted: ['knowledge:brand-notes'],
        },
      ],
    ])
  const fb = foldFeedback(dir, now)
  expect(fb.entries['knowledge:brand-notes']).toMatchObject({ offered: 0, pasted: 60, taken: 0 })
  expect(fb.entries['knowledge:zeta-notes']).toMatchObject({ offered: 60, pasted: 0, taken: 0 })
  expect(fb.base).toBe(0)
  const catalog = loadCatalog(dir).entries
  expect(priorOf(fb, catalog.get('knowledge:brand-notes') as CatalogEntry)).toBe(1)
  expect(stale(fb, catalog.get('knowledge:brand-notes') as CatalogEntry)).toBe(false)
  expect(stale(fb, catalog.get('knowledge:zeta-notes') as CatalogEntry)).toBe(true)
  const learned = movers(fb, catalog)
  expect([...learned.up, ...learned.down].map((m) => m.id)).not.toContain('knowledge:brand-notes')
})

test('B4b-3: an entry rejected more often than taken needs a score above MATCH_MIN', () => {
  writeFileSync(
    join(dir, 'catalog', 'hand-extra.json'),
    JSON.stringify([k('zeta-notes', 'quarterly ledger', { how: 'open it' })]),
  )
  // "quarterly" and "ledger" each hit the when (2): a score of exactly MATCH_MIN (4).
  const prompt = 'quarterly ledger'
  const fresh = packFor(
    dir,
    { chat: 'r1', session: 's1', cwd: 'C:/Users/me/app', prompt, lead: null, dry: true },
    now,
  )
  expect(fresh.ids).toContain('knowledge:zeta-notes')
  plantFeedback({ 'knowledge:zeta-notes': { offered: 5, taken: 1, rejected: 3, reported: 0 } })
  const raised = packFor(
    dir,
    { chat: 'r2', session: 's1', cwd: 'C:/Users/me/app', prompt, lead: null, dry: true },
    now,
  )
  expect(raised.ids).not.toContain('knowledge:zeta-notes')
})

test('B4b-4: feedback-needs.md lists none `better` texts and report `missing` texts, deduped, newest first', () => {
  plant([
    [
      9,
      {
        chat: 'c1',
        event: 'miss',
        id: 'knowledge:a',
        need: 'logo',
        why: 'none',
        better: 'a logo kit',
      },
    ],
    [
      9,
      {
        chat: 'c1',
        event: 'miss',
        id: 'knowledge:b',
        need: 'logo',
        why: 'none',
        better: 'a logo kit',
      },
    ],
    [6, { chat: 'c2', run: 1, event: 'report', outcome: 'partial', missing: 'the refund policy' }],
    [
      2,
      {
        chat: 'c3',
        event: 'miss',
        id: 'knowledge:a',
        need: 'logo',
        why: 'none',
        better: 'A logo kit',
      },
    ],
    [1, { chat: 'c3', event: 'miss', id: 'knowledge:a', need: 'x', why: 'more' }],
  ])
  foldFeedback(dir, now)
  const lines = readFileSync(needsPath(dir), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('- '))
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain('A logo kit')
  expect(lines[0]).toContain(at(2).toISOString().slice(0, 10))
  expect(lines[1]).toContain('the refund policy')
})

test('B4b-5: core_stats shows the prior top movers, up and down', async () => {
  plantFeedback(
    {
      'knowledge:up': { offered: 30, taken: 20, rejected: 0, reported: 0 },
      'knowledge:down': { offered: 30, taken: 0, rejected: 9, reported: 0 },
      'knowledge:young': { offered: 3, taken: 3, rejected: 0, reported: 0 },
    },
    0.2,
  )
  const m = movers(readFeedback(dir))
  expect(m.up.map((x) => x.id)).toEqual(['knowledge:up'])
  expect(m.down.map((x) => x.id)).toEqual(['knowledge:down'])
  expect(m.up[0].prior).toBeGreaterThan(1)
  const stats = CORE_TOOLS.find((t) => t.name === 'core_stats')
  const out = (await stats?.run({})) as {
    learned?: { up: { id: string }[]; down: { id: string }[] }
  }
  expect(out.learned?.up[0]?.id).toBe('knowledge:up')
  expect(out.learned?.down[0]?.id).toBe('knowledge:down')
})

test('B4b-1: the fold never runs inside a pack, match or find request; a timer folds a stale file', () => {
  plant([[3, { event: 'pack', chat: 'c1', ids: ['knowledge:brand-notes'] }]])
  const prompt = 'brand colours for the dashboard'
  packFor(dir, { chat: 'q1', session: 's1', cwd: 'C:/Users/me/app', prompt, lead: null }, now)
  matchFor(
    dir,
    { chat: 'q2', session: 's1', cwd: 'C:/Users/me/app', prompt, placement: 'file' },
    now,
  )
  findTool(dir, { chat: 'q1', need: 'brand colours' }, now)
  expect(existsSync(feedbackPath(dir))).toBe(false)
  expect(foldIfDue(dir, now)).toBe(true)
  expect(existsSync(feedbackPath(dir))).toBe(true)
  expect(foldIfDue(dir, now)).toBe(false)
  const old = new Date(now.getTime() - 25 * 60 * 60 * 1000)
  utimesSync(feedbackPath(dir), old, old)
  expect(foldIfDue(dir, now)).toBe(true)
})

test('B4b-1: rank code reads feedback.json once per change (cached by mtime)', () => {
  plantFeedback({ 'knowledge:x': { offered: 20, taken: 10, rejected: 0, reported: 0 } })
  const spy = spyOn(fs, 'readFileSync')
  readFeedback(dir)
  readFeedback(dir)
  const reads = spy.mock.calls.filter((c) => String(c[0]).endsWith('feedback.json')).length
  spy.mockRestore()
  expect(reads).toBeLessThanOrEqual(1)
})

test('B4b-6: a rotation whose rename fails (log.jsonl held on Windows) never throws out of appendLog', () => {
  appendLog(dir, { event: 'first' }, new Date('2026-09-30T00:00:00Z'))
  const spy = spyOn(fs, 'renameSync').mockImplementation(() => {
    throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
  })
  try {
    expect(() =>
      appendLog(dir, { event: 'second' }, new Date('2026-10-02T00:00:00Z')),
    ).not.toThrow()
  } finally {
    spy.mockRestore()
  }
  expect(readLog(dir).events.map((e) => e.event)).toEqual(['first', 'second'])
  appendLog(dir, { event: 'third' }, new Date('2026-10-02T00:01:00Z'))
  expect(existsSync(join(dir, 'log-2026-09.jsonl'))).toBe(true)
  expect(readLog(dir).events.map((e) => e.event)).toEqual(['first', 'second', 'third'])
})

test('C5 NEW-1: a windowed read still finds a line filed under the month before the window', () => {
  appendLog(dir, { event: 'first' }, new Date('2026-09-30T00:00:00Z'))
  const spy = spyOn(fs, 'renameSync').mockImplementation(() => {
    throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
  })
  try {
    appendLog(dir, { event: 'blocked' }, new Date('2026-10-02T00:00:00Z'))
  } finally {
    spy.mockRestore()
  }
  appendLog(dir, { event: 'later' }, new Date('2026-10-02T00:01:00Z'))
  // The rotation finally runs: the October line 'blocked' now sits in log-2026-09.jsonl.
  appendLog(dir, { event: 'after' }, new Date('2026-11-02T00:00:00Z'))
  expect(existsSync(join(dir, 'log-2026-09.jsonl'))).toBe(true)
  const since = new Date('2026-10-01T00:00:00Z')
  expect(readLog(dir, since).events.map((e) => e.event)).toEqual(['blocked', 'later', 'after'])
})

test('B4b-6: sent.json keeps a session seen in the last week even when its list did not change', () => {
  const file = chatPaths(dir, 'seen').sent
  const t0 = new Date('2026-10-01T00:00:00Z')
  writeSent(file, { a: ['knowledge:brand-notes'] }, 'a', t0)
  writeSent(file, readSent(file), 'a', new Date(t0.getTime() + 6 * DAY))
  writeSent(
    file,
    { ...readSent(file), b: ['person:iris-ui'] },
    'b',
    new Date(t0.getTime() + 9 * DAY),
  )
  expect(Object.keys(readSent(file)).sort()).toEqual(['a', 'b'])
  writeSent(file, readSent(file), 'b', new Date(t0.getTime() + 14 * DAY))
  expect(Object.keys(readSent(file))).toEqual(['b'])
})

test('B4b-6: a per-message match with nothing new still marks its session seen', () => {
  const file = chatPaths(dir, 'm1').sent
  const t0 = new Date('2026-10-01T00:00:00Z')
  writeSent(file, { s1: ['knowledge:brand-notes'], other: [] }, 's1', t0)
  matchFor(
    dir,
    { chat: 'm1', session: 's1', cwd: 'C:/Users/me/app', prompt: 'ok', placement: 'file' },
    new Date(t0.getTime() + 6 * DAY),
  )
  writeSent(file, readSent(file), 'other', new Date(t0.getTime() + 9 * DAY))
  expect(readSent(file).s1).toEqual(['knowledge:brand-notes'])
})

// Run in a fresh process: earlier test files in the same run repoint AGENTHYDRA_HOME and AGENTHYDRA_CORE_DIR.
test('B4b-8: the test preload points AGENTHYDRA_CORE_DIR at its scratch folder, never the live core', () => {
  const env = { ...process.env }
  delete env.AGENTHYDRA_HOME
  delete env.AGENTHYDRA_CORE_DIR
  const body =
    'console.log(JSON.stringify([process.env.AGENTHYDRA_HOME ?? "", process.env.AGENTHYDRA_CORE_DIR ?? ""]))'
  const proc = Bun.spawnSync(
    [
      process.execPath,
      '--preload',
      join(import.meta.dir, '..', '..', 'tests', 'setup.ts'),
      '-e',
      body,
    ],
    { env },
  )
  const [home, preset] = JSON.parse(
    proc.stdout.toString().trim().split('\n').pop() ?? '[]',
  ) as string[]
  expect(home).not.toBe('')
  expect(preset).toBe(join(home, 'core'))
  expect(preset).not.toContain(join('.agenthydra', 'core'))
}, 30_000)
