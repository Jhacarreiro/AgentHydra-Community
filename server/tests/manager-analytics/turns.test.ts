import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeTurns, parseRouterLog } from '../../src/manager-analytics/collect'
import {
  IDLE_FINAL_MS,
  IDLE_STUCK_MS,
  type LineRef,
  promptOf,
  readLineAt,
  readLinesFrom,
  type TurnContext,
  walkTranscript,
} from '../../src/manager-analytics/turns'

let scratch = ''
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ma-turns-'))
  process.env.AGENTHYDRA_MANAGERS_DIR = scratch
})
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  delete process.env.AGENTHYDRA_MANAGERS_DIR
})

const T0 = Date.parse('2026-10-01T09:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

function prompt(uuid: string, text: string, at: number, offset: number): LineRef {
  return {
    offset,
    entry: { type: 'user', uuid, timestamp: iso(at), message: { content: text } },
  }
}

function reply(
  uuid: string,
  text: string,
  at: number,
  offset: number,
  messageId: string,
  usage: object,
): LineRef {
  return {
    offset,
    entry: {
      type: 'assistant',
      uuid,
      timestamp: iso(at),
      message: { id: messageId, model: 'example-model', content: [{ type: 'text', text }], usage },
    },
  }
}

const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  session: 's1',
  managersDir: scratch,
  deskChat: 'chat-1',
  parentChat: null,
  pick: () => ({
    manager: 'alpha',
    picked: { decision: 'stay', source: 'router', why: 'example', p: 0.9 },
  }),
  now: T0 + 5 * 60_000,
  ...over,
})

describe('walkTranscript', () => {
  test('a finished turn is final, its next owner message is its signal, and the open turn is left for the next pass', () => {
    const lines: LineRef[] = [
      prompt('p1', 'draft the example note', T0, 0),
      reply('a1', 'here is the example note', T0 + 5_000, 100, 'msg-1', {
        input_tokens: 10,
        output_tokens: 4,
      }),
      prompt('p2', 'thanks, that is perfect', T0 + 120_000, 200),
      prompt('p3', 'now the second part', T0 + 240_000, 300),
    ]
    const walk = walkTranscript(lines, 400, ctx(), null)
    expect(walk.finals.map((t) => t.id)).toEqual(['s1:p1', 's1:p2'])
    expect(walk.finals[0]).toMatchObject({
      manager: 'alpha',
      outcome: 'replied',
      trigger: 'owner',
      deskChat: 'chat-1',
    })
    expect(walk.signals).toEqual([
      expect.objectContaining({ turn: 's1:p1', from: 'owner', label: 'praise', rule: 'PRAISE' }),
      expect.objectContaining({ turn: 's1:p2', from: 'owner', label: 'new_ask', rule: 'NEW_ASK' }),
    ])
    expect(walk.cursor).toBe(300)
    expect(walk.pending).toBeNull()
  })

  test('a turn whose assistant entries repeat a message id counts its usage once', () => {
    const usage = { input_tokens: 10, output_tokens: 4 }
    const lines: LineRef[] = [
      prompt('p1', 'draft the example note', T0, 0),
      reply('a1', 'part one', T0 + 2_000, 100, 'msg-1', usage),
      reply('a2', 'part two', T0 + 3_000, 150, 'msg-1', usage),
      prompt('p2', 'now the second part', T0 + 240_000, 300),
    ]
    const [first] = walkTranscript(lines, 400, ctx(), null).finals
    expect(first.tokens.in).toBe(10)
    expect(first.tokens.out).toBe(4)
  })

  test('a manager_ask whose own result says done is answered; one with no result is not', () => {
    const ask = (id: string, chat: string, offset: number): LineRef => ({
      offset,
      entry: {
        type: 'assistant',
        uuid: `a-${id}`,
        timestamp: iso(T0 + 2_000 + offset),
        message: {
          id: `m-${id}`,
          model: 'example-model',
          content: [{ type: 'tool_use', id, name: 'manager_ask', input: { chat } }],
        },
      },
    })
    const result = (id: string, body: string, offset: number): LineRef => ({
      offset,
      entry: {
        type: 'user',
        uuid: `r-${id}`,
        timestamp: iso(T0 + 3_000 + offset),
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: body }] },
      },
    })
    const lines: LineRef[] = [
      prompt('p1', 'ask the sub managers', T0, 0),
      ask('t1', 'chat-a', 10),
      result('t1', '{"status": "done"}', 20),
      ask('t2', 'chat-b', 30),
      result('t2', '{"status": "running"}', 40),
      prompt('p2', 'next', T0 + 240_000, 300),
    ]
    const [first] = walkTranscript(lines, 400, ctx(), null).finals
    expect(first.sub.asks).toBe(2)
    expect(first.sub.unanswered).toBe(1)
  })

  test('an open turn idle 60 min is stuck when Desk says live, stays open when Desk is unreachable, and is final after 30 min when not live', () => {
    const lines: LineRef[] = [prompt('p1', 'draft the example note', T0, 0)]
    const at = (mins: number, live: boolean | null) =>
      walkTranscript(lines, 100, ctx({ now: T0 + mins * 60_000, live: () => live }), null)
    const stuck = at(IDLE_STUCK_MS / 60_000, true)
    expect(stuck.finals.map((t) => t.outcome)).toEqual(['stuck'])
    const unknown = at(IDLE_STUCK_MS / 60_000, null)
    expect(unknown.finals).toEqual([])
    expect(unknown.cursor).toBe(0)
    expect(unknown.open).toBeTruthy()
    const idle = at(IDLE_FINAL_MS / 60_000, false)
    expect(idle.finals.map((t) => t.outcome)).toEqual(['silent'])
  })

  test('re-reading from the cursor adds no finals while the open turn is still open', () => {
    const lines: LineRef[] = [
      prompt('p1', 'draft the example note', T0, 0),
      reply('a1', 'here is the example note', T0 + 5_000, 100, 'msg-1', {
        input_tokens: 1,
        output_tokens: 1,
      }),
      prompt('p2', 'now the second part', T0 + 240_000, 200),
    ]
    const first = walkTranscript(lines, 300, ctx(), null)
    const again = walkTranscript(lines.slice(2), 300, ctx(), first.pending)
    expect(again.finals).toEqual([])
  })
})

function exchange(i: number): Array<LineRef['entry']> {
  const at = T0 + i * 60_000
  return [
    {
      type: 'user',
      uuid: `p${i}`,
      timestamp: iso(at),
      message: { content: `draft example note number ${i} for the team` },
    },
    {
      type: 'assistant',
      uuid: `a${i}`,
      timestamp: iso(at + 5_000),
      message: {
        id: `m${i}`,
        model: 'example-model',
        content: [{ type: 'text', text: `here is example note ${i}` }],
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    },
  ]
}

function writeTranscript(name: string, entries: Array<LineRef['entry']>): string {
  const path = join(scratch, name)
  writeFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(''))
  return path
}

describe('readLinesFrom and readLineAt', () => {
  test('a transcript read in small chunks gives the same lines and turns as one read', async () => {
    const path = writeTranscript(
      'chunked.jsonl',
      Array.from({ length: 30 }, (_, i) => exchange(i)).flat(),
    )
    const whole = await readLinesFrom(path, 0)
    const chunked = await readLinesFrom(path, 0, 37)
    expect(whole.lines).toHaveLength(60)
    expect(chunked.lines.map((l) => [l.offset, l.entry.uuid])).toEqual(
      whole.lines.map((l) => [l.offset, l.entry.uuid]),
    )
    expect(chunked.endOffset).toBe(whole.endOffset)

    const late = ctx({ now: T0 + 3 * 3_600_000 })
    const one = walkTranscript(whole.lines, whole.endOffset, late, null)
    const small = walkTranscript(chunked.lines, chunked.endOffset, late, null)
    expect(one.finals).toHaveLength(29)
    expect(small.finals.map((t) => t.id)).toEqual(one.finals.map((t) => t.id))
    expect(small.cursor).toBe(one.cursor)
    expect(small.open?.turn).toBe(one.open?.turn)
  })

  test('readLineAt returns the prompt at an offset that falls mid-chunk', async () => {
    const path = writeTranscript('line-at.jsonl', [...exchange(0), ...exchange(1)])
    const second = (await readLinesFrom(path, 0)).lines.find((l) => l.entry.uuid === 'p1')
    const line = await readLineAt(path, second?.offset ?? -1, 5)
    expect(line?.offset).toBe(second?.offset)
    expect(promptOf(line as LineRef)?.text).toBe('draft example note number 1 for the team')
  })
})

describe('repeat across passes', () => {
  test('a prompt repeated in a later pass is a repeat only when the earlier prompt is seeded', () => {
    const text = 'draft the example note about the quarterly figures'
    const lines: LineRef[] = [prompt('p2', text, T0 + 60_000, 0)]
    const seeded = walkTranscript(lines, 200, ctx(), 'turn-1', [text])
    const unseeded = walkTranscript(lines, 200, ctx(), 'turn-1')
    expect(seeded.signals.map((s) => s.label)).toEqual(['repeat'])
    expect(unseeded.signals.map((s) => s.label)).not.toContain('repeat')
  })
})

describe('turns that are not answers', () => {
  const usage = { input_tokens: 1, output_tokens: 1 }

  test('a turn that ends with "No response requested." is silent, and cancelled when a tool call was interrupted', () => {
    const interrupted: LineRef = {
      offset: 260,
      entry: {
        type: 'user',
        timestamp: iso(T0 + 3_000),
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content: '[Tool call interrupted: the session ended before this call finished.]',
            },
          ],
        },
      },
    }
    const lines: LineRef[] = [
      prompt('p1', 'check the example group', T0, 0),
      reply('a1', 'No response requested.', T0 + 2_000, 100, 'msg-1', usage),
      prompt('p2', 'check the example group again', T0 + 60_000, 200),
      reply('a2', 'Waiting on the example group.', T0 + 61_000, 250, 'msg-2', usage),
      interrupted,
      reply('a3', 'No response requested.', T0 + 64_000, 300, 'msg-3', usage),
      prompt('p3', 'and the third part', T0 + 120_000, 400),
    ]
    const [first, second] = walkTranscript(lines, 500, ctx(), null).finals
    expect(first.outcome).toBe('silent')
    expect(second.outcome).toBe('cancelled')
  })

  test('a daemon wake prompt is a notification, not an owner message', () => {
    const lines: LineRef[] = [
      prompt('p1', '[AgentHydra · CliMayte] Not from the user. Ping 2, 1 update.', T0, 0),
      reply('a1', 'The example worker passed.', T0 + 2_000, 100, 'msg-1', usage),
      prompt('p2', 'now the second part', T0 + 60_000, 200),
    ]
    const [first] = walkTranscript(lines, 300, ctx(), null).finals
    expect(first.trigger).toBe('notification')
    expect(first.outcome).toBe('replied')
  })
})

describe('mergeTurns', () => {
  test('signals and judge rows attach to their turn by id', () => {
    const rows = [
      { type: 'turn', id: 's1:p1', session: 's1', manager: 'alpha' },
      { type: 'signal', turn: 's1:p1', from: 'owner', label: 'correction', rule: 'CORRECT', at: 1 },
      { type: 'judge', turn: 's1:p1', score: 7 },
      { type: 'signal', turn: 'missing', from: 'owner', label: 'praise', rule: 'PRAISE', at: 2 },
    ]
    const merged = mergeTurns(rows)
    const t = merged.get('s1:p1')
    expect(merged.size).toBe(1)
    expect(t?.signals.map((s) => s.label)).toEqual(['correction'])
    expect(t?.judge).toMatchObject({ score: 7 })
  })
})

describe('parseRouterLog', () => {
  test('reads a SWAP line into a route with its source and confidence', () => {
    const text =
      '2026-10-01T09:00:00.000Z session=abc manager=alpha SWAP (keywords p=0.82) source=keywords message=1\n'
    expect(parseRouterLog(text)).toEqual([
      {
        at: T0,
        session: 'abc',
        manager: 'alpha',
        picked: { decision: 'swap', source: 'keywords', why: 'keywords', p: 0.82 },
        deskChat: null,
        transcriptPath: null,
      },
    ])
  })
})
