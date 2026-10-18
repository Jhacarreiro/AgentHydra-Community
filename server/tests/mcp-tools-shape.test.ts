// Every AgentHydra MCP tool, checked for the shape that makes it findable and cheap: one place per tool (HydraTool in
// mcp-client.ts), so a tool added with a bad name, a missing MUTATES: tag or a stray flag fails here, not in a chat.
import { describe, expect, test } from 'bun:test'
import { LISTED_TOOLS, REFUSING_TOOLS, TOOLS } from '../src/mcp'

/** Every listed schema rides in every chat that loads them all; this is their budget (2026-10-11: about 15k tokens). */
const LISTED_BUDGET_TOKENS = 16_000
// 33: price_check, 2026-10-14: the owner asked for the price checker in every chat.
const LISTED_MAX = 33

const bytes = (t: (typeof TOOLS)[number]) =>
  JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length

describe('every tool', () => {
  test('has a unique snake_case name', () => {
    const names = TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/)
  })
  test('has a description whose first sentence says what it does', () => {
    for (const t of TOOLS) {
      expect(t.description.trim().length, t.name).toBeGreaterThan(20)
    }
  })
  test('shows no unfilled template placeholder', () => {
    // A \${...} escaped inside a template literal reaches the agent as the literal text.
    for (const t of TOOLS) expect(t.description, t.name).not.toContain('${')
  })
  test('writes no run of two upper-case words outside the known acronyms', () => {
    const acronyms = new Set([
      'MUTATES',
      'JSON',
      'HTTP',
      'MCP',
      'CLI',
      'API',
      'URL',
      'PID',
      'ISO',
      'SDK',
    ])
    const shouting = (d: string) => {
      const words = d.match(/[A-Za-z0-9_]+/g) ?? []
      return words.some((w, i) => {
        const next = words[i + 1]
        const caps = (x: string) => /^[A-Z][A-Z0-9_]+$/.test(x) && !acronyms.has(x)
        return next !== undefined && caps(w) && caps(next)
      })
    }
    expect(TOOLS.filter((t) => shouting(t.description)).map((t) => t.name)).toEqual([])
  })
  test('has an object input schema', () => {
    for (const t of TOOLS) expect((t.inputSchema as { type?: string }).type, t.name).toBe('object')
  })
  test("a callerChat tool named 'chat' takes a chat argument", () => {
    for (const t of TOOLS.filter((x) => x.callerChat === 'chat')) {
      const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      expect(Object.keys(props), t.name).toContain('chat')
    }
  })
  test('a refusing tool is never listed', () => {
    for (const t of TOOLS.filter((x) => x.refuses)) expect(t.listed, t.name).toBeFalsy()
    expect([...REFUSING_TOOLS].sort()).toEqual(['add_queue_item', 'launch_terminal_session'])
  })
})

describe('the listed set', () => {
  test('is derived from the tools themselves', () => {
    expect([...LISTED_TOOLS].sort()).toEqual(
      TOOLS.filter((t) => t.listed)
        .map((t) => t.name)
        .sort(),
    )
  })
  test('stays small: a count and a token budget', () => {
    const listed = TOOLS.filter((t) => t.listed)
    expect(listed.length).toBeLessThanOrEqual(LISTED_MAX)
    const tokens = Math.round(listed.reduce((s, t) => s + bytes(t), 0) / 4)
    expect(tokens).toBeLessThanOrEqual(LISTED_BUDGET_TOKENS)
  })
  test('always includes the doors to everything else', () => {
    for (const n of ['hydra_find', 'hydra_run', 'desk_chat', 'check_my_usage'])
      expect(LISTED_TOOLS.has(n), n).toBe(true)
  })
})
