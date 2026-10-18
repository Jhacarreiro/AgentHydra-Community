// The price check tools come from the owners' private checkout: this loader finds mcp/tools.mjs there and maps what it exports.
// These tests use a fake tools.mjs in a temp folder, so they never touch the private checkout.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_ROOT } from '../src/config'
import { loadPriceCheckTools, type PriceCheckHost, priceCheckDir } from '../src/mcp-pricecheck'

const FAKE_TOOLS = `
export function priceCheckTools(host) {
  return [{
    name: 'fake_check',
    description: 'Fake price check tool for the loader test.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    listed: true,
    callerChat: 'chat',
    run: async (args) => ({
      cwd: (await host.folderOf(args)).cwd,
      budget: host.callBudgetMs,
      posted: await host.postDashboard({ args }),
    }),
  }]
}
`

const host: PriceCheckHost = {
  folderOf: async () => ({ cwd: 'C:/fake/project' }),
  postDashboard: async (body) => ({ accepted: body }),
  callBudgetMs: 1234,
}

let dir: string
let logged: string[]
const realError = console.error

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pc-loader-'))
  logged = []
  console.error = (...parts: unknown[]) => {
    logged.push(parts.map(String).join(' '))
  }
})

afterEach(() => {
  console.error = realError
  rmSync(dir, { recursive: true, force: true })
})

const writeTools = (source: string) => {
  mkdirSync(join(dir, 'mcp'), { recursive: true })
  writeFileSync(join(dir, 'mcp', 'tools.mjs'), source)
}

describe('priceCheckDir', () => {
  test('defaults to the sibling sue-dredd checkout when PRICECHECK_DIR is unset', () => {
    const saved = process.env.PRICECHECK_DIR
    delete process.env.PRICECHECK_DIR
    try {
      expect(priceCheckDir()).toBe(join(APP_ROOT, '..', 'sue-dredd', 'pricecheck'))
    } finally {
      if (saved !== undefined) process.env.PRICECHECK_DIR = saved
    }
  })

  test('takes PRICECHECK_DIR when it is set', () => {
    const saved = process.env.PRICECHECK_DIR
    process.env.PRICECHECK_DIR = dir
    try {
      expect(priceCheckDir()).toBe(dir)
    } finally {
      if (saved === undefined) delete process.env.PRICECHECK_DIR
      else process.env.PRICECHECK_DIR = saved
    }
  })
})

describe('loadPriceCheckTools', () => {
  test('returns no tools and logs nothing when the checkout has no mcp/tools.mjs', async () => {
    expect(await loadPriceCheckTools(join(dir, 'missing'), host)).toEqual([])
    expect(logged).toEqual([])
  })

  test('maps the tools of a present mcp/tools.mjs, each callable with the host helpers', async () => {
    writeTools(FAKE_TOOLS)
    const tools = await loadPriceCheckTools(dir, host)
    expect(tools.map((t) => t.name)).toEqual(['fake_check'])
    const [tool] = tools
    expect(tool.description).toBe('Fake price check tool for the loader test.')
    expect(tool.listed).toBe(true)
    expect(tool.callerChat).toBe('chat')
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    })
    expect(await tool.run({ cwd: 'ignored' })).toEqual({
      cwd: 'C:/fake/project',
      budget: 1234,
      posted: { accepted: { args: { cwd: 'ignored' } } },
    })
  })

  test('finds the checkout through PRICECHECK_DIR', async () => {
    writeTools(FAKE_TOOLS)
    const saved = process.env.PRICECHECK_DIR
    process.env.PRICECHECK_DIR = dir
    try {
      const tools = await loadPriceCheckTools(priceCheckDir(), host)
      expect(tools.map((t) => t.name)).toEqual(['fake_check'])
    } finally {
      if (saved === undefined) delete process.env.PRICECHECK_DIR
      else process.env.PRICECHECK_DIR = saved
    }
  })

  test('returns no tools and one log line when priceCheckTools throws', async () => {
    writeTools(`export function priceCheckTools() { throw new Error('boom') }`)
    expect(await loadPriceCheckTools(dir, host)).toEqual([])
    expect(logged.length).toBe(1)
    expect(logged[0]).toContain('boom')
  })

  test('returns no tools and one log line when mcp/tools.mjs fails to import', async () => {
    writeTools('export const broken = (')
    expect(await loadPriceCheckTools(dir, host)).toEqual([])
    expect(logged.length).toBe(1)
  })

  test('returns no tools and one log line when mcp/tools.mjs exports no priceCheckTools', async () => {
    writeTools('export const other = 1')
    expect(await loadPriceCheckTools(dir, host)).toEqual([])
    expect(logged.length).toBe(1)
  })
})
