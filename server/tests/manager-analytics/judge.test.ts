import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeTurns } from '../../src/manager-analytics/collect'
import {
  type AskFree,
  buildPrompt,
  excerptOf,
  facetNamesOf,
  judgedToday,
  matchFacet,
  parseJudgeReply,
  rubricSections,
  runJudgePass,
  selectTurns,
} from '../../src/manager-analytics/judge'
import { readLinesFrom } from '../../src/manager-analytics/turns'

const MIN = 60_000
const SLUG = 'example-manager'
const FACETS = ['01-first-facet.md', '02-second-facet.md']
let dir = ''
let savedEnv: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ma-judge-'))
  savedEnv = process.env.AGENTHYDRA_MANAGERS_DIR
  process.env.AGENTHYDRA_MANAGERS_DIR = dir
  mkdirSync(join(dir, 'analytics'), { recursive: true })
  mkdirSync(join(dir, SLUG), { recursive: true })
  writeFileSync(
    join(dir, SLUG, 'brief.md'),
    [
      '# Example Manager',
      '## 1. What you own',
      'Invented ownership text.',
      '## 2. How you decide',
      'Not part of the rubric.',
      '## 3. How you run your employees',
      'Invented employee text.',
      '## 4. Voice',
      'Invented voice text.',
    ].join('\n'),
  )
  writeFileSync(
    join(dir, SLUG, 'persona.json'),
    JSON.stringify({
      playbook: FACETS.map((f) => ({ file: `playbook/${f}`, facet: 'x', read_when: 'y' })),
    }),
  )
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.AGENTHYDRA_MANAGERS_DIR
  else process.env.AGENTHYDRA_MANAGERS_DIR = savedEnv
  rmSync(dir, { recursive: true, force: true })
})

interface Fixture {
  session: string
  uuid: string
  manager: string
  end: number
  trigger?: string
  outcome?: string
  judged?: boolean
}

function turnRow(f: Fixture) {
  return {
    v: 1,
    type: 'turn',
    id: `${f.session}:${f.uuid}`,
    session: f.session,
    deskChat: null,
    parentChat: null,
    manager: f.manager,
    picked: null,
    trigger: f.trigger ?? 'owner',
    promptChars: 20,
    start: f.end - 1000,
    firstOutput: null,
    end: f.end,
    firstMs: null,
    totalMs: 1000,
    outcome: f.outcome ?? 'replied',
    error: null,
    replyChars: 20,
    tools: { Read: 2, Bash: 1 },
    facetsRead: [],
    sub: { opened: ['c-1'], asks: 0, answered: 0, unanswered: 0 },
    workers: ['w-abcdef12'],
    tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 },
    costUsd: null,
  }
}

function writeTurns(rows: object[]) {
  writeFileSync(
    join(dir, 'analytics', 'turns.jsonl'),
    rows.map((r) => `${JSON.stringify(r)}\n`).join(''),
  )
}

function judgeRow(turn: string, at: number) {
  return {
    v: 1,
    type: 'judge',
    turn,
    score: 5,
    criteria: { answered: 1, lane: 1, resultFirst: 1, proof: 1, delegated: 1 },
    facet: null,
    why: 'seeded',
    model: 'seed',
    costUsd: 0,
    at,
  }
}

/** A transcript file with one prompt and reply per entry; returns the routes line that points at it. */
function writeTranscript(
  session: string,
  items: Array<{ uuid: string; text: string; reply: string }>,
  startMs: number,
) {
  const file = join(dir, `${session}.jsonl`)
  const lines: string[] = []
  items.forEach((it, i) => {
    const ts = new Date(startMs + i * 2000).toISOString()
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: it.uuid,
        timestamp: ts,
        message: { content: [{ type: 'text', text: it.text }] },
      }),
    )
    lines.push(
      JSON.stringify({
        type: 'assistant',
        uuid: `a-${it.uuid}`,
        timestamp: ts,
        message: {
          id: `m-${it.uuid}`,
          model: 'example-model',
          content: [
            { type: 'tool_use', id: 't', name: 'Read', input: {} },
            { type: 'text', text: it.reply },
          ],
        },
      }),
    )
  })
  writeFileSync(file, `${lines.join('\n')}\n`)
  writeFileSync(
    join(dir, 'analytics', 'routes.jsonl'),
    `${JSON.stringify({ v: 1, session, manager: SLUG, transcriptPath: file })}\n`,
    { flag: 'a' },
  )
  return file
}

function fakeAsk(reply: (count: number) => string, seen: string[] = []): AskFree {
  return async (prompt: string) => {
    seen.push(prompt)
    const count = prompt.split('### Turn ').length - 1
    return { text: reply(count), model: 'example-haiku' }
  }
}

function goodItems(count: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      n: i + 1,
      answered: 2,
      lane: 1,
      resultFirst: 2,
      proof: 0,
      delegated: 2,
      facet: FACETS[0],
      why: `turn ${i + 1} was clear`,
    })),
  )
}

describe('selectTurns', () => {
  test('takes only final replied owner or parent turns, unjudged, ended 2+ minutes ago', () => {
    const now = Date.now()
    const rows = [
      turnRow({ session: 's1', uuid: 'ok-owner', manager: SLUG, end: now - 10 * MIN }),
      turnRow({
        session: 's1',
        uuid: 'ok-parent',
        manager: SLUG,
        end: now - 9 * MIN,
        trigger: 'parent',
      }),
      turnRow({
        session: 's1',
        uuid: 'errored',
        manager: SLUG,
        end: now - 10 * MIN,
        outcome: 'error',
      }),
      turnRow({
        session: 's1',
        uuid: 'notify',
        manager: SLUG,
        end: now - 10 * MIN,
        trigger: 'notification',
      }),
      turnRow({ session: 's1', uuid: 'too-new', manager: SLUG, end: now - MIN }),
    ]
    rows.push({ ...judgeRow('s1:ok-owner', now), type: 'judge' } as never)
    const picked = selectTurns(mergeTurns(rows), now, 10)
    expect(picked.map((t) => t.id)).toEqual(['s1:ok-parent'])
  })

  test('newest first and never more than the limit', () => {
    const now = Date.now()
    const rows = [
      turnRow({ session: 's1', uuid: 'a', manager: SLUG, end: now - 10 * MIN }),
      turnRow({ session: 's1', uuid: 'b', manager: SLUG, end: now - 5 * MIN }),
      turnRow({ session: 's1', uuid: 'c', manager: SLUG, end: now - 3 * MIN }),
    ]
    const picked = selectTurns(mergeTurns(rows), now, 2)
    expect(picked.map((t) => t.id)).toEqual(['s1:c', 's1:b'])
  })
})

describe('daily cap', () => {
  test("counts only today's judge lines", () => {
    const now = Date.now()
    const yesterday = now - 36 * 60 * 60_000
    const rows = [judgeRow('x:1', now), judgeRow('x:2', now), judgeRow('x:3', yesterday)]
    expect(judgedToday(rows, now)).toBe(2)
  })

  test('a pass with the cap used up asks nothing', async () => {
    const now = Date.now()
    writeTranscript(
      's1',
      [{ uuid: 'p1', text: 'Invented ask.', reply: 'Invented answer.' }],
      now - 20 * MIN,
    )
    const rows = [turnRow({ session: 's1', uuid: 'p1', manager: SLUG, end: now - 10 * MIN })]
    for (let i = 0; i < 300; i++) rows.push(judgeRow(`seed:${i}`, now) as never)
    writeTurns(rows)
    const seen: string[] = []
    const res = await runJudgePass({ ask: fakeAsk(goodItems, seen), now })
    expect(res.candidates).toBe(0)
    expect(seen).toHaveLength(0)
  })
})

describe('rubric and facets', () => {
  test('keeps only the own, employees and voice sections, capped at 3000 characters', () => {
    const rubric = rubricSections(readFileSync(join(dir, SLUG, 'brief.md'), 'utf8'))
    expect(rubric).toContain('Invented ownership text.')
    expect(rubric).toContain('Invented employee text.')
    expect(rubric).toContain('Invented voice text.')
    expect(rubric).not.toContain('Not part of the rubric.')
    const long = `## Your own part\n${'x'.repeat(5000)}`
    expect(rubricSections(long).length).toBe(3000)
  })

  test('facet names are the playbook file basenames', () => {
    expect(
      facetNamesOf({ playbook: [{ file: 'playbook/01-a.md' }, { facet: 'no file' }] }),
    ).toEqual(['01-a.md'])
    expect(facetNamesOf({})).toEqual([])
  })
})

describe('parseJudgeReply', () => {
  test('a good array parses and sums the five criteria', () => {
    const out = parseJudgeReply(goodItems(2), 2, FACETS)
    expect(out).toHaveLength(2)
    expect(out[0].criteria).toEqual({
      answered: 2,
      lane: 1,
      resultFirst: 2,
      proof: 0,
      delegated: 2,
    })
    expect(out[0].facet).toBe(FACETS[0])
  })

  test('a fenced reply with prose around it parses', () => {
    const reply = `Here are the scores:\n\`\`\`json\n${goodItems(1)}\n\`\`\`\nDone.`
    expect(parseJudgeReply(reply, 1, FACETS)).toHaveLength(1)
  })

  test('a partial reply keeps the rows that are whole and drops the rest', () => {
    const reply = `[{"n":1,"answered":2,"lane":2,"resultFirst":2,"proof":2,"delegated":2,"facet":null,"why":"ok"},{"n":2,"answered":1,"lane":"x"},{"n":9,"answered":0,"lane":0,"resultFirst":0,"proof":0,"delegated":0}]`
    const out = parseJudgeReply(reply, 3, FACETS)
    expect(out.map((o) => o.n)).toEqual([1])
  })

  test('criteria are clamped to 0 to 2 and an unknown facet becomes null', () => {
    const reply = `[{"n":1,"answered":7,"lane":-3,"resultFirst":1,"proof":2,"delegated":1,"facet":"99-made-up.md","why":"${'w'.repeat(300)}"}]`
    const [row] = parseJudgeReply(reply, 1, FACETS)
    expect(row.criteria).toEqual({ answered: 2, lane: 0, resultFirst: 1, proof: 2, delegated: 1 })
    expect(row.facet).toBeNull()
    expect(row.facetDropped).toBe('99-made-up.md')
    expect(row.why.length).toBe(200)
  })

  test('a facet named without .md, with its folder or by its number still finds its file', () => {
    expect(matchFacet('02-second-facet', FACETS)).toBe(FACETS[1])
    expect(matchFacet('playbook/01-first-facet.md', FACETS)).toBe(FACETS[0])
    expect(matchFacet('1', FACETS)).toBe(FACETS[0])
    expect(matchFacet('02-misspelt.md', FACETS)).toBe(FACETS[1])
    expect(matchFacet('second facet', FACETS)).toBeNull()
    expect(matchFacet('0', FACETS)).toBeNull()
    const reply = `[{"n":1,"answered":2,"lane":2,"resultFirst":2,"proof":2,"delegated":2,"facet":"01-first-facet","why":"ok"}]`
    const [row] = parseJudgeReply(reply, 1, FACETS)
    expect(row.facet).toBe(FACETS[0])
    expect(row.facetDropped).toBeUndefined()
  })

  test('garbage parses to nothing', () => {
    expect(parseJudgeReply('I cannot score these turns, sorry.', 2, FACETS)).toEqual([])
    expect(parseJudgeReply('[not json at all', 2, FACETS)).toEqual([])
  })
})

describe('runJudgePass', () => {
  test('batches per manager, up to 20 turns a call, and writes one judge line per scored turn', async () => {
    const now = Date.now()
    const turns: Array<{ uuid: string; text: string; reply: string }> = []
    for (let i = 1; i <= 25; i++)
      turns.push({ uuid: `p${i}`, text: `Invented ask ${i}.`, reply: `Invented answer ${i}.` })
    writeTranscript('s1', turns, now - 60 * MIN)
    writeTurns(
      turns.map((t, i) =>
        turnRow({ session: 's1', uuid: t.uuid, manager: SLUG, end: now - (30 - i) * MIN }),
      ),
    )
    const seen: string[] = []
    const res = await runJudgePass({ ask: fakeAsk(goodItems, seen), now })
    expect(res.batches).toBe(2)
    expect(seen.map((p) => p.split('### Turn ').length - 1)).toEqual([20, 5])
    expect(res.written).toHaveLength(25)
    const lines = readFileSync(join(dir, 'analytics', 'turns.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"type":"judge"'))
      .map((l) => JSON.parse(l))
    expect(lines).toHaveLength(25)
    expect(lines[0]).toMatchObject({
      v: 1,
      type: 'judge',
      score: 7,
      model: 'example-haiku free',
      costUsd: 0,
      at: now,
    })
    expect(lines[0].turn).toMatch(/^s1:p/)
  })

  test('a garbage reply writes no line and records the failure', async () => {
    const now = Date.now()
    writeTranscript(
      's1',
      [{ uuid: 'p1', text: 'Invented ask.', reply: 'Invented answer.' }],
      now - 20 * MIN,
    )
    writeTurns([turnRow({ session: 's1', uuid: 'p1', manager: SLUG, end: now - 10 * MIN })])
    const res = await runJudgePass({ ask: fakeAsk(() => 'no array here'), now })
    expect(res.written).toEqual([])
    expect(res.failed).toHaveLength(1)
    expect(readFileSync(join(dir, 'analytics', 'turns.jsonl'), 'utf8')).not.toContain(
      '"type":"judge"',
    )
  })

  test('an ask that throws writes no line and the other managers still run', async () => {
    const now = Date.now()
    const other = 'example-other'
    mkdirSync(join(dir, other), { recursive: true })
    writeFileSync(join(dir, other, 'brief.md'), '## Your voice\nInvented.\n')
    writeTranscript(
      's1',
      [{ uuid: 'p1', text: 'Invented ask.', reply: 'Invented answer.' }],
      now - 20 * MIN,
    )
    writeFileSync(
      join(dir, 'analytics', 'routes.jsonl'),
      `${JSON.stringify({ v: 1, session: 's2', manager: other, transcriptPath: join(dir, 's1.jsonl') })}\n`,
      { flag: 'a' },
    )
    writeTurns([
      turnRow({ session: 's1', uuid: 'p1', manager: SLUG, end: now - 10 * MIN }),
      turnRow({ session: 's2', uuid: 'p1', manager: other, end: now - 10 * MIN }),
    ])
    let calls = 0
    const ask: AskFree = async (prompt) => {
      calls++
      if (prompt.includes(SLUG)) throw new Error('Free account busy')
      return { text: goodItems(1), model: 'example-haiku' }
    }
    const res = await runJudgePass({ ask, now })
    expect(calls).toBe(2)
    expect(res.failed).toEqual([{ manager: SLUG, error: 'Free account busy' }])
    expect(res.written.map((w) => w.turn)).toEqual(['s2:p1'])
  })

  test('a dry pass computes the same rows and writes nothing', async () => {
    const now = Date.now()
    writeTranscript(
      's1',
      [{ uuid: 'p1', text: 'Invented ask.', reply: 'Invented answer.' }],
      now - 20 * MIN,
    )
    writeTurns([turnRow({ session: 's1', uuid: 'p1', manager: SLUG, end: now - 10 * MIN })])
    const res = await runJudgePass({ ask: fakeAsk(goodItems), now, dry: true, limit: 5 })
    expect(res.written).toHaveLength(1)
    expect(readFileSync(join(dir, 'analytics', 'turns.jsonl'), 'utf8')).not.toContain(
      '"type":"judge"',
    )
  })
})

describe('excerpt and prompt', () => {
  test('the excerpt is the prompt and the last reply before the next real prompt, capped', async () => {
    const now = Date.now()
    const file = writeTranscript(
      's1',
      [
        { uuid: 'p1', text: 'x'.repeat(2000), reply: 'first reply' },
        { uuid: 'p2', text: 'second ask', reply: 'y'.repeat(3000) },
      ],
      now - 20 * MIN,
    )
    const { lines } = await readLinesFrom(file, 0)
    const ex = excerptOf(lines, 'p1')
    expect(ex?.prompt.length).toBe(1500)
    expect(ex?.reply).toBe('first reply')
    expect(excerptOf(lines, 'missing')).toBeNull()
  })

  test('the prompt lists the turn tools, sub-managers and workers', () => {
    const turn = mergeTurns([turnRow({ session: 's1', uuid: 'p1', manager: SLUG, end: 1 })]).get(
      's1:p1',
    )
    if (!turn) throw new Error('fixture turn missing')
    const text = buildPrompt(SLUG, 'rubric', FACETS, [
      { n: 1, excerpt: { prompt: 'Invented ask.', reply: 'Invented answer.' }, turn },
    ])
    expect(text).toContain('Read x2, Bash x1')
    expect(text).toContain('Sub-managers opened: 1. Workers dispatched: 1.')
    expect(text).toContain('[{"n":1,')
  })
})
