import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatPaths } from '../src/hydra-core/paths'
import { reportRun } from '../src/hydra-core/report-row'
import { buildTrack, trackSummary } from '../src/hydra-core/track'
import { scratch } from './hydra-core-fixture'

const T = Date.parse('2026-10-13T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const line = (o: object) => `${JSON.stringify(o)}\n`
const user = (sid: string, cwd: string, at: number, text: string) =>
  line({
    type: 'user',
    sessionId: sid,
    cwd,
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
const logRow = (o: object) => line(o)

let dir: string
let roots: string[]
let handoffsDir: string

beforeEach(() => {
  dir = scratch()
  roots = [join(dir, 'projects')]
  handoffsDir = join(dir, 'handoffs')
  mkdirSync(handoffsDir, { recursive: true })
  const cwd = 'C:/Users/me/app'
  const write = (project: string, name: string, text: string) => {
    mkdirSync(join(dir, 'projects', project), { recursive: true })
    writeFileSync(join(dir, 'projects', project, name), text)
  }
  // compliant turn, unused pick, then a skipped scope that uses a capability never offered
  write(
    'proj-main',
    'sa.jsonl',
    user('sa', cwd, T, 'first') +
      call('sa', T + 1000, 's1', 'mcp__agenthydra__core_scope', { chat: 'alpha' }) +
      result('sa', T + 1500, 's1', 'in scope: person:iris-ui') +
      call('sa', T + 3000, 'p1', 'mcp__agenthydra__core_use', {
        chat: 'alpha',
        id: 'person:ops-lead',
        mode: 'consult',
      }) +
      result('sa', T + 3500, 'p1', 'ok') +
      user('sa', cwd, T + 10000, 'second') +
      call('sa', T + 11000, 'k1', 'Skill', { skill: 'brand-notes' }) +
      result('sa', T + 11500, 'k1', 'done'),
  )
  // second session on the same chat key: a handoff
  write(
    'proj-two',
    'sc.jsonl',
    user('sc', cwd, T + 100000, 'again') +
      call('sc', T + 101000, 's2', 'mcp__agenthydra__core_scope', { chat: 'alpha' }) +
      result('sc', T + 101500, 's2', 'in scope: person:iris-ui'),
  )
  // worker session: excluded from the ledger
  write(
    'corch-w1',
    'w.jsonl',
    user('w', 'C:/Users/me/corch', T + 200000, 'do the task') +
      call('w', T + 201000, 'w1', 'mcp__agenthydra__core_scope', { chat: 'worker' }) +
      result('w', T + 201500, 'w1', 'in scope'),
  )
  // plain session with no core use
  write(
    'proj-plain',
    'n.jsonl',
    user('n', cwd, T + 300000, 'hello') +
      call('n', T + 300500, 'b1', 'Bash', { command: 'ls' }) +
      result('n', T + 301000, 'b1', 'x'),
  )
  appendFileSync(
    join(dir, 'log.jsonl'),
    logRow({ at: iso(T + 1000), chat: 'alpha', run: 1, step: 'start' }) +
      logRow({
        at: iso(T + 1100),
        chat: 'alpha',
        run: 1,
        step: 'q1',
        answer: 'x',
        shown: ['person:iris-ui'],
      }) +
      logRow({ at: iso(T + 2000), chat: 'alpha', run: 1, step: 'end', verdict: 'go' }) +
      logRow({
        at: iso(T + 2500),
        chat: 'alpha',
        run: 1,
        event: 'report',
        outcome: 'done',
        note: '',
        overruled: [],
        score: 4,
        missing: 'no ops data',
      }) +
      logRow({ at: iso(T + 101000), chat: 'alpha', run: 2, step: 'start' }) +
      logRow({ at: iso(T + 102000), chat: 'alpha', run: 2, step: 'end', verdict: 'hydra' }),
  )
  mkdirSync(chatPaths(dir, 'alpha').root, { recursive: true })
  writeFileSync(chatPaths(dir, 'alpha').hydraMd, 'kept\n')
  writeFileSync(
    join(dir, 'catalog', 'hand-skills.json'),
    JSON.stringify([
      {
        id: 'skill:brand-notes',
        kind: 'skill',
        name: 'Brand notes',
        when: 'Brand rules',
        tags: ['brand'],
        cost: 'free',
        how: 'run the skill',
        load: { type: 'skill', name: 'brand-notes' },
      },
    ]),
  )
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('ledger rows follow each turn: scope, compliance, picks and offered capabilities', () => {
  const { rows } = buildTrack(dir, { roots, handoffsDir, now: T })
  expect(rows.length).toBe(3)
  expect(rows.some((r) => r.project === 'corch-w1')).toBe(false)
  const [compliant, skipped] = rows
  expect(compliant?.compliant).toBe(true)
  expect(compliant?.method).toBe('scope')
  expect(compliant?.scopes).toEqual([{ chat: 'alpha', run: 1, verdict: 'go' }])
  expect(compliant?.offered).toContain('person:iris-ui')
  expect(compliant?.used).toEqual(['person:ops-lead'])
  expect(compliant?.notTaken).toEqual(['person:iris-ui'])
  expect(compliant?.reports.map((r) => r.score)).toEqual([4])
  expect(skipped?.compliant).toBe(false)
  expect(skipped?.method).toBe('none')
  expect(skipped?.used).toEqual(['skill:brand-notes'])
  expect(skipped?.usedNotOffered).toEqual(['skill:brand-notes'])
})

test('summary counts compliance, verdicts, reports, handoffs and skipped workers', () => {
  const { summary } = buildTrack(dir, { roots, handoffsDir, now: T })
  expect(summary.sessions).toEqual({ transcripts: 4, workers: 1, noCore: 1, eligible: 2 })
  expect(summary.turns).toEqual({ total: 3, compliant: 2, compliancePct: 66.7 })
  expect(summary.scopes).toEqual({ total: 2, go: 1, hydra: 1, none: 0 })
  expect(summary.reports).toEqual({
    runs: 2,
    reported: 1,
    rate: 0.5,
    noRun: 0,
    scored: 1,
    meanScore: 4,
  })
  expect(summary.picks).toEqual({ total: 1 })
  expect(summary.usedNotOffered).toBe(2)
  expect(summary.missing).toEqual([{ chat: 'alpha', run: 1, text: 'no ops data' }])
  expect(summary.handoffs).toEqual({ chats: 1, handoffs: 1, kept: 1, lost: 0, linkedFiles: 0 })
})

test('a pack-only turn counts as pack and its pack ids are offered', () => {
  appendFileSync(
    join(dir, 'log.jsonl'),
    logRow({
      at: iso(T + 10500),
      event: 'pack',
      chat: 'alpha',
      session: 'sa',
      mode: 'delta',
      ids: ['skill:brand-notes'],
      bytes: 300,
      ms: 5,
    }) +
      logRow({
        at: iso(T + 10600),
        event: 'pack',
        chat: 'beta',
        session: 'zz',
        mode: 'first',
        ids: ['person:other-chat'],
        bytes: 300,
        ms: 5,
      }),
  )
  const { rows } = buildTrack(dir, { roots, handoffsDir, now: T })
  const packed = rows[1]
  expect(packed?.method).toBe('pack')
  expect(packed?.compliant).toBe(true)
  expect(packed?.offered).toContain('skill:brand-notes')
  expect(packed?.offered).not.toContain('person:other-chat')
  expect(packed?.usedNotOffered).toEqual([])
})

test('a turn with a scope call and a matched pack counts as both', () => {
  appendFileSync(
    join(dir, 'log.jsonl'),
    logRow({
      at: iso(T + 1200),
      event: 'pack',
      chat: 'alpha',
      session: 'sa',
      mode: 'first',
      ids: ['person:iris-ui'],
      bytes: 400,
      ms: 10,
    }),
  )
  const { rows } = buildTrack(dir, { roots, handoffsDir, now: T })
  expect(rows[0]?.method).toBe('both')
  expect(rows[0]?.compliant).toBe(true)
})

test('the packs summary counts first, delta and empty delta packs and their means', () => {
  appendFileSync(
    join(dir, 'log.jsonl'),
    logRow({
      at: iso(T + 1000),
      event: 'pack',
      chat: 'alpha',
      session: 'sa',
      mode: 'first',
      ids: ['person:iris-ui'],
      bytes: 400,
      ms: 10,
    }) +
      logRow({
        at: iso(T + 11000),
        event: 'pack',
        chat: 'alpha',
        session: 'sa',
        mode: 'delta',
        ids: [],
        bytes: 0,
        ms: 2,
      }) +
      logRow({
        at: iso(T + 12000),
        event: 'pack',
        chat: 'alpha',
        session: 'sa',
        mode: 'delta',
        ids: ['skill:brand-notes'],
        bytes: 200,
        ms: 7,
      }),
  )
  const { summary } = buildTrack(dir, { roots, handoffsDir, now: T })
  expect(summary.packs).toEqual({
    total: 3,
    first: 1,
    delta: 2,
    emptyDelta: 1,
    meanBytes: 200,
    meanMs: 6,
  })
  expect(summary.methods).toEqual({ scope: 1, pack: 1, both: 1, none: 0 })
})

test('a handoff whose hydra.md is gone counts as lost', () => {
  rmSync(chatPaths(dir, 'alpha').hydraMd)
  const { summary } = buildTrack(dir, { roots, handoffsDir, now: T })
  expect(summary.handoffs).toEqual({ chats: 1, handoffs: 1, kept: 0, lost: 1, linkedFiles: 0 })
})

test('trackSummary reuses a summary younger than ten minutes and rebuilds an older one', () => {
  const base = Date.now()
  const first = trackSummary(dir, base, { roots, handoffsDir })
  expect(trackSummary(dir, base + 60_000, { roots, handoffsDir }).builtAt).toBe(first.builtAt)
  const later = trackSummary(dir, base + 11 * 60_000, { roots, handoffsDir })
  expect(later.builtAt).toBe(new Date(base + 11 * 60_000).toISOString())
})

test('C5 NEW-2: text a pack pasted in full is not offered, so it is never reported as never taken', () => {
  const own = scratch()
  try {
    mkdirSync(join(own, 'projects', 'proj-p'), { recursive: true })
    mkdirSync(join(own, 'handoffs'), { recursive: true })
    writeFileSync(
      join(own, 'projects', 'proj-p', 'pp.jsonl'),
      user('pp', 'C:/Users/me/app', T, 'hello'),
    )
    appendFileSync(
      join(own, 'log.jsonl'),
      logRow({
        at: iso(T + 500),
        event: 'pack',
        chat: 'p',
        session: 'pp',
        mode: 'full',
        ids: ['knowledge:pinned-rule', 'skill:brand-notes'],
        pasted: ['knowledge:pinned-rule'],
      }) +
        logRow({
          at: iso(T + 600),
          event: 'pack',
          chat: 'p',
          session: 'pp',
          mode: 'full',
          ids: ['knowledge:old-rule'],
        }) +
        logRow({ at: iso(T + 700), event: 'find', chat: 'p', ids: ['knowledge:found'] }),
    )
    const opts = { roots: [join(own, 'projects')], handoffsDir: join(own, 'handoffs'), now: T }
    const { rows, summary } = buildTrack(own, opts)
    const row = rows.find((r) => r.session === 'pp')
    expect(row?.offered).toEqual(['skill:brand-notes'])
    expect(summary.entries.notTaken.map((n) => n.id).sort()).toEqual([
      'knowledge:found',
      'skill:brand-notes',
    ])
  } finally {
    rmSync(own, { recursive: true, force: true })
  }
})

test('reportRun writes a score and missing note and rejects a score outside 1-5', () => {
  expect(() => reportRun(dir, { chat: 'alpha', outcome: 'done', note: '', score: 6 })).toThrow()
  reportRun(
    dir,
    { chat: 'alpha', outcome: 'done', note: 'ok', score: 5, missing: ' a tool ' },
    new Date(T),
  )
  const log = readFileSync(join(dir, 'log.jsonl'), 'utf8')
  expect(log.trimEnd().split('\n').at(-1)).toContain('"score":5')
  expect(log.trimEnd().split('\n').at(-1)).toContain('"missing":"a tool"')
})

test('a turn served only by a per-message placement answer counts as served, even when the answer is empty', () => {
  const own = scratch()
  try {
    const projects = join(own, 'projects', 'proj-slot')
    mkdirSync(projects, { recursive: true })
    mkdirSync(join(own, 'handoffs'), { recursive: true })
    writeFileSync(
      join(projects, 'sl.jsonl'),
      user('sl', 'C:/Users/me/app', T, 'hello') + user('sl', 'C:/Users/me/app', T + 50000, 'again'),
    )
    appendFileSync(
      join(own, 'log.jsonl'),
      logRow({
        at: iso(T + 500),
        event: 'placement',
        phase: 'message',
        chat: 'slot',
        session: 'sl',
        placement: 'slot',
        chars: 0,
        ids: [],
      }) +
        logRow({
          at: iso(T + 50500),
          event: 'placement',
          phase: 'message',
          chat: 'slot',
          session: 'sl',
          placement: 'slot',
          chars: 40,
          ids: ['knowledge:x'],
          pasted: [],
        }),
    )
    const { rows } = buildTrack(own, {
      roots: [join(own, 'projects')],
      handoffsDir: join(own, 'handoffs'),
      now: T,
    })
    const served = rows.filter((r) => r.session === 'sl')
    expect(served.map((r) => r.served)).toEqual([true, true])
    expect(served.map((r) => r.compliant)).toEqual([true, true])
    expect(served.map((r) => r.method)).toEqual(['pack', 'pack'])
    expect(served[1]?.offered).toContain('knowledge:x')
  } finally {
    rmSync(own, { recursive: true, force: true })
  }
})
