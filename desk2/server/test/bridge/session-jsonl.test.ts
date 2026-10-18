import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@shared/protocol'
import { historyToItems, parseJsonl } from '../../src/engine/normalize'
import { claudeProjectRoots, createJsonlReader, encodeProjectDir, findSessionJsonl, lastContextTokens, readTail, sessionJsonlItems, sessionJsonlOlder, sessionJsonlWork, workerJsonlItems } from '../../src/bridge/session-jsonl'

const temps: string[] = []
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'desk-jsonl-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

const at = (s: number) => new Date(Date.UTC(2026, 9, 3, 10, 0, s % 60)).toISOString()
const userRec = (n: number, text: string) => JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: at(n), message: { role: 'user', content: text } })

const SID = '02b95209-e131-404d-9fc7-6033f2d04adf'
const ANSWER = 'It now looks like Claude Code Desktop.\n\n**What’s done:**\n\n- **Sidebar.** Grouped.\n- **Checks.** All pass.\n\n## What I did\n\n```ts\nconst a = 1\n```'

function lines(): string {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 3, 10, 0, s)).toISOString()
  return [
    { type: 'queue-operation', operation: 'enqueue' },
    { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'how does it look?' } },
    { type: 'assistant', uuid: 'a1', timestamp: at(1), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: ANSWER }] } },
    { type: 'attachment', uuid: 'x1', timestamp: at(2) },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n')
}

describe('outside session .jsonl', () => {
  test('encodes a cwd the way Claude Code names its project folder', () => {
    expect(encodeProjectDir('C:\\Users\\me\\Desktop\\Project\\Connections')).toBe('C--Users-me-Desktop-Project-Connections')
    expect(encodeProjectDir('C:/Users/me/Desktop/Project/Agent Hydra/desk')).toBe('C--Users-me-Desktop-Project-Agent-Hydra-desk')
  })

  test('finds the projects folders of the default login, Desktop instances and given config dirs', () => {
    const home = temp()
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
    mkdirSync(join(home, '.claude-instances', 'eek', 'projects'), { recursive: true })
    mkdirSync(join(home, '.claude-instances', 'empty'), { recursive: true })
    mkdirSync(join(home, 'cli-68', 'projects'), { recursive: true })
    expect(claudeProjectRoots([join(home, 'cli-68'), join(home, 'missing')], home)).toEqual([
      join(home, '.claude', 'projects'),
      join(home, '.claude-instances', 'eek', 'projects'),
      join(home, 'cli-68', 'projects'),
    ])
  })

  test('finds the newest file for a session id, the cwd folder first, and refuses a path-looking id', () => {
    const home = temp()
    const a = join(home, 'one', 'projects')
    const b = join(home, 'two', 'projects')
    mkdirSync(join(a, 'C--x'), { recursive: true })
    mkdirSync(join(b, 'C--y'), { recursive: true })
    writeFileSync(join(a, 'C--x', `${SID}.jsonl`), lines())
    writeFileSync(join(b, 'C--y', `${SID}.jsonl`), lines())
    utimesSync(join(a, 'C--x', `${SID}.jsonl`), new Date(2026, 0, 1), new Date(2026, 0, 1))
    expect(findSessionJsonl(SID, [a, b])).toBe(join(b, 'C--y', `${SID}.jsonl`))
    expect(findSessionJsonl(SID, [a, b], 'C:/x')).toBe(join(a, 'C--x', `${SID}.jsonl`))
    expect(findSessionJsonl('nope-nope-nope', [a, b])).toBeNull()
    expect(findSessionJsonl('..\\..\\secrets', [a, b])).toBeNull()
    expect(findSessionJsonl('../C--x/' + SID, [a, b])).toBeNull()
  })

  test('reads only the tail; a cut first line is skipped', () => {
    const dir = temp()
    const f = join(dir, 's.jsonl')
    const body = lines()
    writeFileSync(f, body)
    expect(readTail(f, 10)).toBe(body.slice(-10))
    const lastTwo = body.split('\n').slice(-2).join('\n')
    const items = sessionJsonlItems(f)
    expect(items.length).toBe(2)
    expect(readTail(f, lastTwo.length + 5).endsWith(lastTwo)).toBe(true)
  })

  test("its context is the last main-thread reply's prompt and answer, not a subagent's or a synthetic one, and none without usage", () => {
    const dir = temp()
    const f = join(dir, 's.jsonl')
    const reply = (n: number, usage: object, extra: object = {}) =>
      JSON.stringify({ type: 'assistant', uuid: `a${n}`, timestamp: at(n), message: { id: `msg_${n}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage }, ...extra })
    writeFileSync(f, lines())
    expect(lastContextTokens(f)).toBeNull()
    appendFileSync(f, '\n' + [
      reply(3, { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 }),
      reply(4, { input_tokens: 900_000, output_tokens: 1 }, { isSidechain: true }),
      userRec(5, 'and now?'),
      reply(6, { input_tokens: 4, cache_read_input_tokens: 1250, cache_creation_input_tokens: 30, output_tokens: 80 }),
      JSON.stringify({ type: 'assistant', uuid: 'a7', timestamp: at(7), message: { id: 'msg_7', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }], usage: { input_tokens: 0, output_tokens: 0 } } }),
      reply(8, { input_tokens: 0, output_tokens: 0 }, { isSidechain: true }),
    ].join('\n'))
    expect(lastContextTokens(f)).toBe(4 + 1250 + 30 + 80)
  })

  test('reads on from where it stopped: an appended line, a line finished later, a byte that is not UTF-8', () => {
    const f = join(temp(), 'grow.jsonl')
    const rec = (n: number, text: string) =>
      JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: new Date(Date.UTC(2026, 9, 3, 10, 0, n)).toISOString(), message: { role: 'user', content: text } })
    const texts = () => sessionJsonlItems(f).map((i) => (i.kind === 'user' ? i.text : i.kind))
    // Line 2 holds a byte that is not UTF-8 (0xFF): one byte in the file, three once decoded.
    const [before, after] = rec(2, 'bad #').split('#')
    writeFileSync(f, Buffer.concat([Buffer.from(`${rec(1, 'one')}\n${before}`), Buffer.from([0xff]), Buffer.from(`${after}\n`)]))
    expect(texts()).toEqual(['one', 'bad �'])
    const four = rec(4, 'four')
    appendFileSync(f, `${rec(3, 'three')}\n${four.slice(0, 20)}`)
    expect(texts()).toEqual(['one', 'bad �', 'three'])
    appendFileSync(f, `${four.slice(20)}\n`)
    expect(texts()).toEqual(['one', 'bad �', 'three', 'four'])
  })

  test('a file rewritten in place, to the same size or larger, is read again from the start', () => {
    const f = join(temp(), 'rewrite.jsonl')
    const rec = (n: number, text: string) =>
      JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: new Date(Date.UTC(2026, 9, 3, 10, 0, n)).toISOString(), message: { role: 'user', content: text } })
    const texts = () => sessionJsonlItems(f).map((i) => (i.kind === 'user' ? i.text : i.kind))
    const write = (body: string, at: number) => {
      writeFileSync(f, body)
      utimesSync(f, new Date(at), new Date(at))
    }
    write(`${rec(1, 'old one')}\n${rec(2, 'old two')}\n`, Date.UTC(2026, 9, 3, 10, 0, 0))
    expect(texts()).toEqual(['old one', 'old two'])
    write(`${rec(1, 'new one')}\n${rec(2, 'new two')}\n`, Date.UTC(2026, 9, 3, 10, 0, 10))
    expect(texts()).toEqual(['new one', 'new two'])
    write(`${rec(1, 'newer one')}\n${rec(2, 'newer two')}\n${rec(3, 'newer three')}\n`, Date.UTC(2026, 9, 3, 10, 0, 20))
    expect(texts()).toEqual(['newer one', 'newer two', 'newer three'])
  })

  test('a chat with many past sessions: an unchanged file answers for a stat, a changed one is read again', () => {
    // A CliMayte chat reads every session it has had at each poll (one had 94); a cap on what is remembered
    // re-parsed them all every few seconds on the server's one thread, and every click waited behind it.
    const dir = temp()
    const rec = (n: number, text: string) =>
      JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: new Date(Date.UTC(2026, 9, 3, 10, 0, n)).toISOString(), message: { role: 'user', content: text } })
    const files = Array.from({ length: 40 }, (_, i) => {
      const f = join(dir, `past-${i}.jsonl`)
      writeFileSync(f, `${rec(1, `session ${i}`)}\n`)
      return f
    })
    const first = files.map((f) => sessionJsonlItems(f))
    files.forEach((f, i) => expect(sessionJsonlItems(f)).toBe(first[i]!))
    appendFileSync(files[0]!, `${rec(2, 'later')}\n`)
    expect(sessionJsonlItems(files[0]!).map((i) => (i.kind === 'user' ? i.text : i.kind))).toEqual(['session 0', 'later'])
  })

  test('worker files: 20 growing files are each read from only their new bytes', () => {
    // Every running worker of a CliMayte chat is polled and each grows between two polls; with 8 files remembered
    // a pass over 20 parsed an 8 MiB tail apiece, all in one stretch of the server's one thread.
    const dir = temp()
    const files = Array.from({ length: 20 }, (_, i) => {
      const f = join(dir, `running-${i}.jsonl`)
      writeFileSync(f, Array.from({ length: 60 }, (_, n) => userRec(n, `worker ${i} line ${n} ${'x'.repeat(1500)}`)).join('\n') + '\n')
      return f
    })
    files.forEach((f) => workerJsonlItems(f))
    files.forEach((f, i) => appendFileSync(f, `${userRec(100, `worker ${i} later`)}\n`))
    const before = sessionJsonlWork.parsedBytes
    const last = files.map((f) => workerJsonlItems(f).at(-1))
    const parsed = sessionJsonlWork.parsedBytes - before
    last.forEach((item, i) => expect(item?.kind === 'user' && item.text).toBe(`worker ${i} later`))
    expect(parsed).toBeLessThan(20 * 400)
  })

  test('an async read answers what a sync read answers, and lets the loop run while it parses', async () => {
    const dir = temp()
    const f = join(dir, 'long.jsonl')
    writeFileSync(f, Array.from({ length: 350 }, (_, n) => userRec(n, `slice ${n}`)).join('\n') + '\n')
    const options = { tailBytes: 1024 * 1024, keepBytes: 1024 * 1024, maxFiles: 4, maxBytes: 1024 * 1024, settledFiles: 8, settledBytes: 1024 * 1024 }
    let ticks = 0
    setImmediate(() => { ticks += 1 })
    const answer = await createJsonlReader(options).readAsync(f)
    expect(ticks).toBe(1)
    expect(answer).toEqual(createJsonlReader(options)(f))
  })

  test('a windowed reader answers the whole tail once, then only the records it keeps', () => {
    const dir = temp()
    const f = join(dir, 'big.jsonl')
    writeFileSync(f, Array.from({ length: 200 }, (_, n) => userRec(n, `line ${n} ${'y'.repeat(1000)}`)).join('\n') + '\n')
    const read = createJsonlReader({ tailBytes: 1024 * 1024, keepBytes: 20 * 1024, maxFiles: 4, maxBytes: 1024 * 1024, settledFiles: 8, settledBytes: 1024 * 1024 })
    expect(read(f)).toHaveLength(200)
    expect(read(f).length).toBeLessThanOrEqual(21)
    appendFileSync(f, `${userRec(300, 'newest')}\n`)
    const next = read(f)
    expect(next.length).toBeLessThanOrEqual(22)
    expect(next.at(-1)).toMatchObject({ kind: 'user', text: 'newest' })
  })

  test('a windowed reader keeps the launch of a running tool, so its result still settles it', () => {
    const dir = temp()
    const launch = JSON.stringify({ type: 'assistant', uuid: 'a-tool', timestamp: at(0), message: { id: 'msg_tool', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 60' } }] } })
    const result = JSON.stringify({ type: 'user', uuid: 'u-result', timestamp: at(50), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } })
    const options = { tailBytes: 1024 * 1024, keepBytes: 10 * 1024, pinBytes: 200 * 1024, maxFiles: 4, maxBytes: 1024 * 1024, settledFiles: 8, settledBytes: 1024 * 1024 }
    const run = (fillerLines: number) => {
      const f = join(dir, `tool-${fillerLines}.jsonl`)
      writeFileSync(f, [launch, ...Array.from({ length: fillerLines }, (_, n) => userRec(n, `filler ${n} ${'z'.repeat(1000)}`))].join('\n') + '\n')
      const read = createJsonlReader(options)
      expect(read(f).find((i) => i.id === 'toolu_1')).toMatchObject({ kind: 'tool_use', status: 'running' })
      appendFileSync(f, `${result}\n`)
      return read(f).find((i) => i.id === 'toolu_1')
    }
    // More than keepBytes of other records came between, within pinBytes: the result still settles the tool.
    expect(run(100)).toMatchObject({ kind: 'tool_use', status: 'done' })
    // Past pinBytes the launch is let go (a tool that long unanswered must not keep a file's history in memory) and its result is skipped.
    expect((run(300) as { status?: string } | undefined)?.status).not.toBe('done')
  })

  test('the outside-session reader still answers the whole tail, not a window', () => {
    const dir = temp()
    const f = join(dir, 'outside.jsonl')
    writeFileSync(f, Array.from({ length: 400 }, (_, n) => userRec(n, `line ${n} ${'w'.repeat(3000)}`)).join('\n') + '\n')
    expect(sessionJsonlItems(f)).toHaveLength(400)
    appendFileSync(f, `${userRec(500, 'newest')}\n`)
    expect(sessionJsonlItems(f)).toHaveLength(401)
  })

  test('a session that grew past the tail still answers its opening prompt, from a fresh reader too', async () => {
    // Owner, 2026-10-12: a CliMayte chat's continuation is the session's first user row; once the session grew past
    // the tail, a fresh read never reached it and its stand-in stayed queued.
    const pad = 'p'.repeat(300)
    const replies = Array.from({ length: 200 }, (_, n) =>
      JSON.stringify({ type: 'assistant', uuid: `a${n}`, timestamp: at(n), message: { id: `msg_${n}`, role: 'assistant', content: [{ type: 'text', text: `reply ${n} ${pad}` }] } }),
    ).join('\n')
    const f = join(temp(), 'opening.jsonl')
    writeFileSync(f, `${userRec(0, 'Example Owner asks about the gauge')}\n${replies}\n`)
    const options = { tailBytes: 4096, keepBytes: 1024, headBytes: 1024, maxFiles: 4, maxBytes: Infinity, settledFiles: 8, settledBytes: 1024 * 1024 }
    const userTexts = (items: TranscriptItem[]) => items.flatMap((i) => (i.kind === 'user' ? [i.text] : []))
    expect(userTexts(createJsonlReader(options)(f))).toEqual(['Example Owner asks about the gauge'])
    expect(userTexts(await createJsonlReader(options).readAsync(f))).toEqual(['Example Owner asks about the gauge'])
  })

  test('a session longer than the tail reads back whole: the tail and what is before its start, each item once', async () => {
    // Owner, 2026-10-11: a 56 MB session showed only its last 8 MiB, none of his messages ("It just stops").
    // Each reply is three records of one API message, so a start that fell inside one would name its blocks differently.
    const pad = 'p'.repeat(300)
    const turn = (n: number) => {
      const asst = (part: number, block: unknown) =>
        JSON.stringify({ type: 'assistant', uuid: `a${n}-${part}`, timestamp: at(n), message: { id: `msg_${n}`, role: 'assistant', content: [block] } })
      return [
        ...(n % 10 === 0 ? [userRec(n, `ask ${n}`)] : []),
        asst(0, { type: 'thinking', thinking: `thought ${n} ${pad}` }),
        asst(1, { type: 'text', text: `answer ${n} ${pad}` }),
        asst(2, { type: 'tool_use', id: `toolu_${n}`, name: 'Bash', input: { command: `echo ${n}` } }),
        JSON.stringify({ type: 'user', uuid: `r${n}`, timestamp: at(n), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${n}`, content: `out ${n} ${pad}` }] } }),
      ].join('\n')
    }
    const turns = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => turn(from + i)).join('\n') + '\n'
    const f = join(temp(), 'long.jsonl')
    const body = turns(0, 100)
    writeFileSync(f, body)
    // The tail's first whole line is reply 50's second record: a start taken as read would cut that reply in two.
    const tailBytes = Buffer.byteLength(body) - Buffer.byteLength(body.slice(0, body.indexOf('{"type":"assistant","uuid":"a50-1"'))) + 1
    const read = createJsonlReader({ tailBytes, keepBytes: tailBytes, maxFiles: 4, maxBytes: Infinity, settledFiles: 8, settledBytes: 1024 * 1024 })
    const whole = () => historyToItems(parseJsonl(readFileSync(f, 'utf8')))
    const both = async () => [...(await sessionJsonlOlder(f, read.startOf(f))), ...read(f)]

    read(f)
    const start = read.startOf(f)
    expect(start).toBeGreaterThan(0)
    expect(await both()).toEqual(whole())
    // A session still going keeps its start, so the older part the window read stays good...
    appendFileSync(f, turns(100, 101))
    read(f)
    expect(read.startOf(f)).toBe(start)
    expect(await both()).toEqual(whole())
    // ...until it holds twice the tail; then the start moves on, and the two still make the whole.
    appendFileSync(f, turns(101, 190))
    read(f)
    expect(read.startOf(f)).toBeGreaterThan(start)
    expect(await both()).toEqual(whole())
  })

  test("shows the pictures a tool returned and the person's own, from the media cache", () => {
    const dir = temp()
    const f = join(dir, `${SID}.jsonl`)
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const picture = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }
    writeFileSync(f, [
      { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: [{ type: 'text', text: 'what is on this?' }, picture] } },
      { type: 'assistant', uuid: 'a1', timestamp: at(1), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'C:/Users/me/shot.png' } }] } },
      { type: 'user', uuid: 'u2', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [picture] }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n')
    const home = process.env.HYDRA_DESK_HOME
    process.env.HYDRA_DESK_HOME = join(dir, 'home')
    try {
      const items = sessionJsonlItems(f)
      const user = items.find((i) => i.kind === 'user') as Extract<TranscriptItem, { kind: 'user' }>
      const read = items.find((i) => i.kind === 'tool_use') as Extract<TranscriptItem, { kind: 'tool_use' }>
      expect(user.images?.map((i) => i.url)).toEqual([expect.stringMatching(/^\/api\/media\/[0-9a-f]{64}\.png$/)])
      expect(read.result?.images?.map((i) => i.url)).toEqual(user.images!.map((i) => i.url))
    } finally {
      if (home === undefined) delete process.env.HYDRA_DESK_HOME
      else process.env.HYDRA_DESK_HOME = home
    }
  })

  test('keeps the full text of an answer: newlines, lists, headings and fences', () => {
    const dir = temp()
    const f = join(dir, `${SID}.jsonl`)
    writeFileSync(f, lines())
    const items = sessionJsonlItems(f)
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant_text'])
    expect((items[1] as Extract<TranscriptItem, { kind: 'assistant_text' }>).text).toBe(ANSWER)
  })
})
