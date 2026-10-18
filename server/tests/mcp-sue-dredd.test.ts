// The sue and dredd tools: each finds the sue-dredd checkout (SUE_DREDD_HOME, else sue-dredd beside AgentHydra), hands
// the engine its arguments in a file and returns what it printed. The engines here are tiny stubs in a temp folder that
// echo what they were given, so these tests never start a visitor or a hearing.
import { afterEach, beforeEach, expect, describe as group, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCP_CALL_BUDGET_MS } from '../src/mcp-client'
import {
  launchEngine,
  resolveCheckout,
  SUE_DREDD_TOOLS,
  type SueDreddDeps,
  sueDreddTools,
} from '../src/mcp-sue-dredd'

// Prints one JSON line: the args it was started with, and the json-file's (or ask-file's) contents.
const ECHO = `import { readFileSync } from 'node:fs'
const argv = process.argv.slice(2)
const at = (f) => { const i = argv.indexOf(f); return i < 0 ? null : readFileSync(argv[i + 1], 'utf8') }
if (argv.includes('crash')) { process.stderr.write('engine fell over: no such thing'); process.exit(3) }
if (argv.includes('refuse')) { console.log(JSON.stringify({ ok: false, error: 'refused by the stub' })); process.exit(1) }
if (argv.includes('--hearing')) { console.log('Hearing started.\\nDocket: C:/Users/me/dockets/0001'); process.exit(0) }
if (argv.includes('--status')) { console.log('status: sitting'); process.exit(0) }
console.log(JSON.stringify({ ok: true, who: process.env.WHO, argv, json: at('--json-file') && JSON.parse(at('--json-file')), ask: at('--ask-file'), via: process.env.SUE_LAUNCHED_VIA ?? null, door: process.env.DREDD_DOOR ?? null }))
`

let base: string

const makeCheckout = (dir: string, who: string) => {
  mkdirSync(join(dir, 'sue'), { recursive: true })
  mkdirSync(join(dir, 'dredd'), { recursive: true })
  writeFileSync(join(dir, 'sue', 'sue.mjs'), `process.env.WHO = ${JSON.stringify(who)}\n${ECHO}`)
  writeFileSync(
    join(dir, 'dredd', 'dredd.mjs'),
    `process.env.WHO = ${JSON.stringify(who)}\n${ECHO}`,
  )
  writeFileSync(
    join(dir, 'dredd', 'bench.json'),
    JSON.stringify({ instruments: [{ id: 'stub-instrument' }] }),
  )
}

// The real launcher; only the env, the roots and the calling folder are faked.
const deps = (over: Partial<SueDreddDeps> = {}): SueDreddDeps => {
  return {
    env: {},
    appRoot: join(base, 'AgentHydra'),
    folder: async () => ({ cwd: join(base, 'project'), chatId: 'chat-1' }),
    tmp: () => mkdtempSync(join(base, 'call-')),
    launch: launchEngine,
    ...over,
  }
}

const tool = (d: SueDreddDeps, name: string) => {
  const t = sueDreddTools(d).find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'sue-dredd-test-'))
  mkdirSync(join(base, 'AgentHydra'))
  mkdirSync(join(base, 'project'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

group('resolveCheckout', () => {
  test('SUE_DREDD_HOME comes first', () => {
    makeCheckout(join(base, 'sue-dredd'), 'beside')
    makeCheckout(join(base, 'elsewhere'), 'env')
    expect(
      resolveCheckout('sue', { SUE_DREDD_HOME: join(base, 'elsewhere') }, join(base, 'AgentHydra')),
    ).toBe(join(base, 'elsewhere'))
  })
  test('else sue-dredd beside the AgentHydra checkout', () => {
    makeCheckout(join(base, 'sue-dredd'), 'beside')
    expect(resolveCheckout('dredd', {}, join(base, 'AgentHydra'))).toBe(join(base, 'sue-dredd'))
  })
  test('an SUE_DREDD_HOME without the engine falls back to the folder beside', () => {
    makeCheckout(join(base, 'sue-dredd'), 'beside')
    expect(
      resolveCheckout('sue', { SUE_DREDD_HOME: join(base, 'empty') }, join(base, 'AgentHydra')),
    ).toBe(join(base, 'sue-dredd'))
  })
  test('none found names both places and that nothing ran', () => {
    const wrong = join(base, 'nowhere')
    expect(() =>
      resolveCheckout('sue', { SUE_DREDD_HOME: wrong }, join(base, 'AgentHydra')),
    ).toThrow(/SUE_DREDD_HOME \(.*nowhere\) has no .*sue\.mjs.*sue-dredd has no .*Nothing ran/)
    expect(() => resolveCheckout('dredd', {}, join(base, 'AgentHydra'))).toThrow(
      /SUE_DREDD_HOME is not set.*sue-dredd has no/,
    )
  })
})

group('sue', () => {
  test('hands params over in a json file with the calling folder as workspace, and returns the engine JSON', async () => {
    makeCheckout(join(base, 'sue-dredd'), 'beside')
    const out = (await tool(deps(), 'sue').run({
      action: 'personas',
      params: { scope: 'all' },
    })) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(out.who).toBe('beside')
    expect(out.json).toEqual({ scope: 'all' })
    expect(out.via).toBe('mcp')
    const argv = out.argv as string[]
    expect(argv.slice(0, 3)).toEqual(['personas', '--workspace', join(base, 'project')])
    expect(argv[3]).toBe('--json-file')
  })
  test('a relative file is resolved against the calling folder', async () => {
    makeCheckout(join(base, 'sue-dredd'), 'beside')
    const out = (await tool(deps(), 'sue').run({
      action: 'status',
      params: { file: 'notes/a.md' },
    })) as { json: { file: string } }
    expect(out.json.file).toBe(join(base, 'project', 'notes', 'a.md'))
  })
  test("the engine's own refusal comes back as it printed it", async () => {
    makeCheckout(join(base, 'sue-dredd'), 'beside')
    expect(await tool(deps(), 'sue').run({ action: 'refuse' })).toEqual({
      ok: false,
      error: 'refused by the stub',
    })
  })
  test('a crash with no JSON is an error carrying the exit code and the stderr tail', async () => {
    makeCheckout(join(base, 'sue-dredd'), 'beside')
    await expect(tool(deps(), 'sue').run({ action: 'crash' })).rejects.toThrow(
      /sue crash answered no JSON \(exit 3\): engine fell over/,
    )
  })
  test('no checkout: the error names both places', async () => {
    await expect(tool(deps(), 'sue').run({ action: 'personas' })).rejects.toThrow(
      /SUE_DREDD_HOME is not set.*sue-dredd has no/,
    )
  })
  test("'move' and a malformed action are refused before anything runs", async () => {
    let launched = 0
    const d = deps({
      launch: async () => {
        launched += 1
        return { done: true, code: 0, stdout: '{}', stderr: '' }
      },
    })
    makeCheckout(join(base, 'sue-dredd'), 'beside')
    await expect(tool(d, 'sue').run({ action: 'move' })).rejects.toThrow(/hand\.mjs/)
    await expect(tool(d, 'sue').run({ action: 'rm -rf' })).rejects.toThrow(/action must be/)
    expect(launched).toBe(0)
  })
  test('a wave past the call budget keeps running and the answer names its output', async () => {
    makeCheckout(join(base, 'sue-dredd'), 'beside')
    const seen: { keep: boolean; waitMs: number }[] = []
    const d = deps({
      launch: async (_c, _a, o) => {
        seen.push({ keep: o.keep, waitMs: o.waitMs })
        return {
          done: false,
          pid: 4242,
          outFile: join(o.dir, 'out.txt'),
          errFile: join(o.dir, 'err.txt'),
        }
      },
    })
    const out = (await tool(d, 'sue').run({
      action: 'run',
      params: { url: 'https://example.test/' },
    })) as Record<string, unknown>
    expect(out).toMatchObject({ ok: true, running: true, pid: 4242 })
    expect(String(out.output)).toEndWith('out.txt')
    expect(seen[0].keep).toBe(true)
    expect(seen[0].waitMs).toBeLessThan(MCP_CALL_BUDGET_MS)
    await Promise.resolve(tool(d, 'sue').run({ action: 'personas' })).catch(() => null)
    expect(seen[1].keep).toBe(false)
  })
})

group('dredd', () => {
  test('a docket gets the ask through --ask-file, --json and the mcp door', async () => {
    makeCheckout(join(base, 'sue-dredd'), 'beside')
    const out = (await tool(deps(), 'dredd').run({
      action: 'docket',
      params: { ask: 'the pricing page is too wordy', url: 'https://example.test/pricing' },
    })) as Record<string, unknown>
    expect(out.ask).toBe('the pricing page is too wordy')
    expect(out.door).toBe('mcp')
    const argv = out.argv as string[]
    expect(argv).toContain('--json')
    expect(argv.slice(argv.indexOf('--url'), argv.indexOf('--url') + 2)).toEqual([
      '--url',
      'https://example.test/pricing',
    ])
    expect(argv).toContain('--ask-file')
  })
  test('a hearing detaches in the engine and returns its docket to poll', async () => {
    makeCheckout(join(base, 'sue-dredd'), 'beside')
    const out = (await tool(deps(), 'dredd').run({
      action: 'hearing',
      params: { ask: 'checkout feels broken' },
    })) as Record<string, unknown>
    expect(out.docket).toBe('C:/Users/me/dockets/0001')
    expect(String(out.output)).toContain('Hearing started.')
  })
  test('status needs a docket, and a text answer comes back as output', async () => {
    makeCheckout(join(base, 'sue-dredd'), 'beside')
    await expect(tool(deps(), 'dredd').run({ action: 'status' })).rejects.toThrow(
      /needs params\.docket/,
    )
    expect(
      await tool(deps(), 'dredd').run({
        action: 'status',
        params: { docket: 'C:/Users/me/dockets/0001' },
      }),
    ).toEqual({ ok: true, output: 'status: sitting' })
  })
  test('bench reads bench.json from the checkout', async () => {
    makeCheckout(join(base, 'sue-dredd'), 'beside')
    expect(await tool(deps(), 'dredd').run({ action: 'bench' })).toEqual({
      instruments: [{ id: 'stub-instrument' }],
    })
  })
  test('an unknown action and a missing ask are refused', async () => {
    makeCheckout(join(base, 'sue-dredd'), 'beside')
    await expect(tool(deps(), 'dredd').run({ action: 'jail' })).rejects.toThrow(
      /action must be one of/,
    )
    await expect(tool(deps(), 'dredd').run({ action: 'docket' })).rejects.toThrow(
      /needs params\.ask/,
    )
  })
})

test('both tools are registered with an action and params', () => {
  expect(SUE_DREDD_TOOLS.map((t) => t.name)).toEqual(['sue', 'dredd'])
  for (const t of SUE_DREDD_TOOLS)
    expect((t.inputSchema as { required: string[] }).required).toEqual(['action'])
})
