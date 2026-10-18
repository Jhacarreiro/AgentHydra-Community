// server/tests/hydra-core-placement.test.ts - the <core>/PLACEMENT setting: slot and file chats get their pack in the prompt, attach keeps the inject path.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
// @ts-expect-error the hook is plain ESM with no type declarations
import { run } from '../../hydra-core/hook.mjs'
import { setCliMayteOwnerDir } from '../src/climayte'
import { chatPromptText } from '../src/climayte-launch'
import type { CliMayteWorker } from '../src/climayte-lib'
import { matchFor } from '../src/hydra-core/pack'
import { chatPaths } from '../src/hydra-core/paths'
import { packLine, placeChat, placementOf } from '../src/hydra-core/placement'
import { buildTrack } from '../src/hydra-core/track'
import { scratch } from './hydra-core-fixture'

const T = Date.parse('2026-10-14T09:00:00Z')
const CWD = 'C:/Users/me/app'
const RULES = 'Repo rules: the invented test app uses one button style.'
const PRICING = 'Pricing tables: the invented plans cost 3, 5 and 8 coins a month.'
const PRICING_PROMPT = 'pricing plans for the product'

let dir: string
let savedFetch: typeof fetch

// The catalog lets the hook test go through the real matcher: a repo rule for CWD, one strong pricing note, and one too long to fit.
function addCatalog(core: string): void {
  const rules = join(core, 'repo-rules.md')
  const pricing = join(core, 'pricing-tables.md')
  const oversize = join(core, 'pricing-long.md')
  writeFileSync(rules, `${RULES}\n`)
  writeFileSync(pricing, `${PRICING}\n`)
  writeFileSync(oversize, `Pricing notes for the plans. ${'x'.repeat(2500)}\n`)
  const entries = [
    {
      id: 'knowledge:repo-rules',
      kind: 'knowledge',
      name: 'Repo Rules',
      when: 'Button style rules for the app',
      tags: ['repo'],
      folders: [CWD],
      cost: 'free',
      how: 'read the repo rules',
      load: { type: 'file', path: rules },
    },
    {
      id: 'knowledge:pricing-tables',
      kind: 'knowledge',
      name: 'Pricing Tables',
      when: 'Pricing tables for plans and pricing',
      tags: ['pricing'],
      cost: 'free',
      how: 'read the pricing tables',
      load: { type: 'file', path: pricing },
    },
    {
      id: 'knowledge:pricing-long',
      kind: 'knowledge',
      name: 'Pricing Long',
      when: 'Pricing notes for plans and pricing',
      tags: ['pricing'],
      cost: 'free',
      how: 'read the long pricing notes',
      load: { type: 'file', path: oversize },
    },
  ]
  writeFileSync(join(core, 'catalog', 'hand-repo-fixture.json'), JSON.stringify(entries))
}

beforeEach(() => {
  dir = scratch()
  addCatalog(dir)
  savedFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = savedFetch
  setCliMayteOwnerDir(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('placementOf', () => {
  test('absent or unknown means off, the four values read back', () => {
    expect(placementOf(dir)).toBe('off')
    for (const value of ['slot', 'file', 'attach'] as const) {
      writeFileSync(join(dir, 'PLACEMENT'), `${value}\n`)
      expect(placementOf(dir)).toBe(value)
    }
    writeFileSync(join(dir, 'PLACEMENT'), 'sideways\n')
    expect(placementOf(dir)).toBe('off')
  })
})

describe('placeChat slot', () => {
  test('writes slot.md, reuses it while the inputs hold, recomputes when a folder rule changes', () => {
    const req = {
      chat: 'alpha',
      session: 'sa1',
      fresh: true,
      cwd: CWD,
      prompt: 'hello',
      placement: 'slot' as const,
    }
    const first = placeChat(dir, req, new Date(T))
    expect(first.reused).toBe(false)
    expect(first.text).toContain(RULES)
    expect(first.ids).toContain('knowledge:repo-rules')
    expect(readFileSync(chatPaths(dir, 'alpha').slot, 'utf8')).toBe(first.text)

    const again = placeChat(dir, req, new Date(T + 1))
    expect(again.reused).toBe(true)
    expect(again.hash).toBe(first.hash)
    expect(again.text).toBe(first.text)

    writeFileSync(join(dir, 'repo-rules.md'), 'Repo rules: changed for the test.\n')
    const after = placeChat(dir, req, new Date(T + 2))
    expect(after.reused).toBe(false)
    expect(after.hash).not.toBe(first.hash)
    expect(after.text).toContain('changed for the test')
  })

  test('recomputes when the hydra.md lead changes', () => {
    const req = {
      chat: 'lead',
      session: 'sl1',
      fresh: true,
      cwd: CWD,
      prompt: 'hello',
      placement: 'slot' as const,
    }
    const first = placeChat(dir, req, new Date(T))
    mkdirSync(chatPaths(dir, 'lead').root, { recursive: true })
    const brief = join(dir, 'persona-lead.md')
    writeFileSync(brief, 'Lead brief: an invented lead for the test.\n')
    writeFileSync(
      chatPaths(dir, 'lead').hydraMd,
      `## Lead\nLead Example - a new lead. Full text: ${brief}\n`,
    )
    const after = placeChat(dir, req, new Date(T + 1))
    expect(after.reused).toBe(false)
    expect(after.hash).not.toBe(first.hash)
    expect(after.text).toContain('Lead brief: an invented lead for the test.')
  })
})

describe('placeChat file', () => {
  test('writes pack.md and returns the one line naming its absolute path', () => {
    const placed = placeChat(
      dir,
      { chat: 'beta', session: 'fb1', fresh: true, cwd: CWD, prompt: 'hello', placement: 'file' },
      new Date(T),
    )
    const file = resolve(chatPaths(dir, 'beta').pack)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain(RULES)
    expect(placed.text).toBe(packLine(file))
    expect(placed.text).toMatch(
      /^Before you act on any message, read .+pack\.md: it holds this folder's rules and what you need for this chat\.$/,
    )
  })
})

describe('matchFor', () => {
  test('a session that started with the pack gets only the matches the pack did not hold', () => {
    placeChat(
      dir,
      { chat: 'gamma', session: 's1', fresh: true, cwd: CWD, prompt: 'hello', placement: 'slot' },
      new Date(T),
    )
    const req = {
      chat: 'gamma',
      session: 's1',
      cwd: CWD,
      prompt: PRICING_PROMPT,
      placement: 'slot' as const,
    }
    const first = matchFor(dir, req, new Date(T + 1))
    expect(first.ids).toContain('knowledge:pricing-tables')
    expect(first.ids).not.toContain('knowledge:repo-rules')
    expect(first.ids.some((id) => id.startsWith('person:'))).toBe(false)
    expect(first.text).toContain(PRICING)
    expect(first.text).not.toContain(RULES)
    expect(first.text).toContain('knowledge:pricing-long - Pricing notes')
    expect(first.text).not.toContain('x'.repeat(100))
    expect(first.chars).toBeLessThanOrEqual(2000)

    const same = matchFor(dir, req, new Date(T + 2))
    expect(same.ids).not.toContain('knowledge:pricing-tables')
  })

  test('a session that started with the pack gets no repeat of what the pack held', () => {
    placeChat(
      dir,
      {
        chat: 'pack',
        session: 'p1',
        fresh: true,
        cwd: CWD,
        prompt: PRICING_PROMPT,
        placement: 'slot',
      },
      new Date(T),
    )
    const next = matchFor(
      dir,
      { chat: 'pack', session: 'p1', cwd: CWD, prompt: PRICING_PROMPT, placement: 'slot' },
      new Date(T + 1),
    )
    expect(next.ids).toEqual([])
    expect(next.text).toBe('')
  })

  test('a session launched without the pack gets the full pack once, then only new matches', () => {
    writeFileSync(join(dir, 'shipping.md'), 'Shipping notes: invented couriers take 2 days.\n')
    writeFileSync(
      join(dir, 'catalog', 'hand-shipping-fixture.json'),
      JSON.stringify([
        {
          id: 'knowledge:shipping-notes',
          kind: 'knowledge',
          name: 'Shipping Notes',
          when: 'Shipping notes for courier deliveries',
          tags: ['shipping'],
          cost: 'free',
          how: 'read the shipping notes',
          load: { type: 'file', path: join(dir, 'shipping.md') },
        },
      ]),
    )
    placeChat(
      dir,
      {
        chat: 'resumed',
        session: 'r0',
        fresh: false,
        cwd: CWD,
        prompt: 'hello',
        placement: 'slot',
      },
      new Date(T),
    )
    const req = {
      chat: 'resumed',
      session: 'r1',
      cwd: CWD,
      prompt: PRICING_PROMPT,
      placement: 'slot' as const,
    }
    const first = matchFor(dir, req, new Date(T + 1))
    expect(first.text).toContain('Hydra Core attached for this chat and message')
    expect(first.text).toContain(RULES)
    expect(first.text).toContain('knowledge:pricing-tables - Pricing tables')
    expect(first.ids).toContain('knowledge:repo-rules')
    expect(first.ids).toContain('knowledge:pricing-tables')

    const repeat = matchFor(dir, req, new Date(T + 2))
    expect(repeat.ids).not.toContain('knowledge:pricing-tables')
    expect(repeat.text).toBe('')

    const later = matchFor(
      dir,
      { ...req, prompt: 'shipping notes for courier deliveries' },
      new Date(T + 3),
    )
    expect(later.ids).toContain('knowledge:shipping-notes')
    expect(later.ids).not.toContain('knowledge:repo-rules')
    expect(later.ids).not.toContain('knowledge:pricing-tables')
    expect(later.text).not.toContain(RULES)
    expect(later.text).not.toContain('Hydra Core attached')
  })

  test('an entry with no text is a pointer, never an empty block, and a message gets at most three matches', () => {
    const quota: unknown[] = []
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(dir, `quota-${i}.md`), `Quota note ${i}: invented widget quota is ${i}.\n`)
      quota.push({
        id: `knowledge:quota-${i}`,
        kind: 'knowledge',
        name: `Quota ${i}`,
        when: 'Quota notes for the invented widget',
        tags: ['widget'],
        cost: 'free',
        how: 'read the quota note',
        load: { type: 'file', path: join(dir, `quota-${i}.md`) },
      })
    }
    for (let i = 0; i < 1; i++)
      quota.push({
        id: `instrument:empty-${i}`,
        kind: 'instrument',
        name: `Quota empty ${i}`,
        when: 'Quota notes for the invented widget',
        tags: ['widget'],
        cost: 'free',
        how: 'the quota note has no text',
        load: { type: 'none' },
      })
    writeFileSync(join(dir, 'catalog', 'hand-quota-fixture.json'), JSON.stringify(quota))
    placeChat(
      dir,
      { chat: 'cap', session: 'c1', fresh: true, cwd: CWD, prompt: 'hello', placement: 'slot' },
      new Date(T),
    )
    const got = matchFor(
      dir,
      {
        chat: 'cap',
        session: 'c1',
        cwd: CWD,
        prompt: 'quota notes for the invented widget',
        placement: 'slot',
      },
      new Date(T + 1),
    )
    const headers = got.text.match(/^--- .*$/gm) ?? []
    expect(headers.length).toBe(2)
    for (const header of headers) expect(header).toMatch(/^--- knowledge:quota-\d /)
    expect(got.text).not.toMatch(/^--- instrument:/m)
    expect(got.text).toMatch(/- instrument:empty-\d - Quota notes/)
    expect(got.text).toContain('Also matching (core_find { need, chat } loads any of them):')
    expect(got.ids.length).toBe(3)
    expect(got.chars).toBeLessThanOrEqual(2000)
  })

  test('a weak prompt gets nothing once the session has the pack', () => {
    placeChat(
      dir,
      { chat: 'delta', session: 'w1', fresh: true, cwd: CWD, prompt: 'hello', placement: 'slot' },
      new Date(T),
    )
    const weak = matchFor(
      dir,
      { chat: 'delta', session: 'w1', cwd: CWD, prompt: 'hello there', placement: 'slot' },
      new Date(T),
    )
    expect(weak.ids).toEqual([])
    expect(weak.text).toBe('')
  })
})

describe('hook under slot and file', () => {
  const env = () =>
    ({ AGENTHYDRA_CORE_DIR: dir, AGENTHYDRA_DAEMON_URL: 'http://daemon.test' }) as NodeJS.ProcessEnv

  function mockDaemon(): void {
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body)
      const match = matchFor(dir, body, new Date(T))
      return new Response(JSON.stringify(match), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  test('under slot the message gets strong matches only, never a core_scope line', async () => {
    writeFileSync(join(dir, 'ON'), '')
    writeFileSync(join(dir, 'PLACEMENT'), 'slot\n')
    placeChat(
      dir,
      {
        chat: 'hook-s1',
        session: 'hook-s1',
        fresh: true,
        cwd: CWD,
        prompt: 'hello',
        placement: 'slot',
      },
      new Date(T),
    )
    mockDaemon()
    const out = await run(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'hook-s1',
        cwd: CWD,
        prompt: 'pricing plans for the product',
      },
      env(),
    )
    const text = out?.hookSpecificOutput?.additionalContext ?? ''
    expect(text.startsWith('Hydra Core, new for this message')).toBe(true)
    expect(text).toContain('knowledge:pricing-tables')
    expect(text).not.toContain('core_scope')
    expect(text.length).toBeLessThanOrEqual(2000)

    const weak = await run(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'hook-s1',
        cwd: CWD,
        prompt: 'hello there',
      },
      env(),
    )
    expect(weak).toBeNull()
  })

  test('under slot SessionStart re-injects nothing', async () => {
    writeFileSync(join(dir, 'ON'), '')
    writeFileSync(join(dir, 'PLACEMENT'), 'slot\n')
    expect(
      await run({ hook_event_name: 'SessionStart', session_id: 'hook-s2', cwd: CWD }, env()),
    ).toBeNull()
  })

  test('a file chat logs pack_read on Stop when its first turn read pack.md', async () => {
    writeFileSync(join(dir, 'ON'), '')
    writeFileSync(join(dir, 'PLACEMENT'), 'file\n')
    const pack = resolve(chatPaths(dir, 'hook-f1').pack)
    mkdirSync(chatPaths(dir, 'hook-f1').root, { recursive: true })
    writeFileSync(chatPaths(dir, 'hook-f1').pack, 'Pack body.\n')
    const transcript = join(dir, 'hook-f1.jsonl')
    const turn = [
      { type: 'user', message: { role: 'user', content: 'read the pack' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: pack } }],
        },
      },
    ]
    writeFileSync(transcript, turn.map((o) => `${JSON.stringify(o)}\n`).join(''))
    await run(
      { hook_event_name: 'Stop', session_id: 'hook-f1', transcript_path: transcript, cwd: CWD },
      env(),
    )
    const rows = readFileSync(join(dir, 'log.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.event === 'pack_read')
    expect(rows.length).toBe(1)
    expect(rows[0].chat).toBe('hook-f1')
    expect(rows[0].read).toBe(true)
  })
})

describe('tracking', () => {
  test('a placement launch shows on its session row and in the placement summary', () => {
    const roots = join(dir, 'projects')
    mkdirSync(join(roots, 'proj-main'), { recursive: true })
    const handoffsDir = join(dir, 'handoffs')
    mkdirSync(handoffsDir, { recursive: true })
    placeChat(
      dir,
      {
        chat: 'track-a',
        session: 'tp1',
        fresh: true,
        cwd: CWD,
        prompt: 'hello',
        placement: 'slot',
      },
      new Date(T),
    )
    writeFileSync(
      join(roots, 'proj-main', 'tp1.jsonl'),
      `${[
        {
          type: 'user',
          sessionId: 'tp1',
          cwd: CWD,
          timestamp: new Date(T).toISOString(),
          message: { role: 'user', content: 'hello' },
        },
        {
          type: 'assistant',
          sessionId: 'tp1',
          timestamp: new Date(T + 500).toISOString(),
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tp1-scope',
                name: 'mcp__agenthydra__core_scope',
                input: { chat: 'track-a' },
              },
            ],
          },
        },
        {
          type: 'user',
          sessionId: 'tp1',
          timestamp: new Date(T + 600).toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tp1-scope', content: 'ok' }],
          },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n')}\n`,
    )
    const { rows, summary } = buildTrack(dir, { roots: [roots], handoffsDir, now: T + 1000 })
    const row = rows.find((r) => r.session === 'tp1')
    expect(row?.placement).toBe('slot')
    expect(summary.placements.slot.launches).toBe(1)
    expect(summary.placements.slot.meanChars).toBeGreaterThan(0)
    expect(summary.placements.file.launches).toBe(0)
  })
})

describe('chatPromptText under file', () => {
  test('a Prime chat gets the pack line, a worker chat does not', () => {
    writeFileSync(join(dir, 'ON'), '')
    writeFileSync(join(dir, 'PLACEMENT'), 'file\n')
    const prime = {
      cwd: CWD,
      chat: true,
      sessionId: 'prime-1',
      prompt: 'hello',
    } as unknown as CliMayteWorker
    const text = chatPromptText(prime, { id: 'prime-1', resume: false })
    expect(text).toContain('Before you act on any message, read ')
    expect(text).toContain('pack.md: it holds this folder')

    const drone = { cwd: CWD, sessionId: 'drone-1', prompt: 'hello' } as unknown as CliMayteWorker
    expect(chatPromptText(drone, { id: 'drone-1', resume: false })).not.toContain(
      'Before you act on any message',
    )
  })
})
