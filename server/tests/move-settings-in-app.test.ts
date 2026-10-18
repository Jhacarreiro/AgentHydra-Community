import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { tryNativeUltracode } from '../src/claude-native-ultracode'
import { landMovedSettingsInApp, movedEffortPair } from '../src/move-settings-in-app'

const scratch = mkdtempSync(join(tmpdir(), 'move-settings-in-app-'))
const landedDir = join(scratch, 'store')
mkdirSync(landedDir, { recursive: true })
const landedPath = join(landedDir, 'local_abc123.json')
writeFileSync(landedPath, JSON.stringify({ effort: 'medium' }))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const TARGET = join(scratch, 'target-profile')

type NativeCall = Parameters<typeof tryNativeUltracode>

function fakeNative(outcome: Record<string, unknown> | 'throw') {
  const calls: NativeCall[] = []
  const native = async (...args: NativeCall) => {
    calls.push(args)
    if (outcome === 'throw') throw new Error('inspector went away')
    return outcome as never
  }
  return { native, calls }
}

const verified = {
  ok: true,
  verified: true,
  after: { effort: 'xhigh', ultracode: true, permissionMode: 'bypassPermissions' },
}

describe('movedEffortPair', () => {
  const cases: Array<{
    name: string
    source: Record<string, unknown>
    landed: Record<string, unknown>
    defaultUltra: boolean
    want: { effort: string; ultracode: boolean }
  }> = [
    {
      name: 'source xhigh with ultracode keeps both',
      source: { effort: 'xhigh', sessionSettings: { ultracode: true } },
      landed: {},
      defaultUltra: false,
      want: { effort: 'xhigh', ultracode: true },
    },
    {
      name: 'source high drops ultracode below xhigh',
      source: { effort: 'high', sessionSettings: { ultracode: true } },
      landed: {},
      defaultUltra: true,
      want: { effort: 'high', ultracode: false },
    },
    {
      name: 'no source effort falls back to the landed record',
      source: {},
      landed: { effort: 'max', sessionSettings: { ultracode: true } },
      defaultUltra: false,
      want: { effort: 'max', ultracode: true },
    },
    {
      name: 'neither names an effort gives xhigh with the default',
      source: {},
      landed: {},
      defaultUltra: true,
      want: { effort: 'xhigh', ultracode: true },
    },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expect(movedEffortPair(c.source, c.landed, c.defaultUltra)).toEqual(c.want)
    })
  }
})

describe('landMovedSettingsInApp', () => {
  test('asks the running app once for Bypass and the source effort', async () => {
    const { native, calls } = fakeNative(verified)
    const source = { effort: 'xhigh', sessionSettings: { ultracode: true } }
    const out = await landMovedSettingsInApp(TARGET, landedPath, source, {
      native,
      readLanded: () => ({ effort: 'medium' }),
      ultracodeByDefault: () => false,
    })
    expect(calls).toEqual([[TARGET, 'local_abc123', 'xhigh', true, true]])
    expect(out).toEqual({
      ok: true,
      effort: 'xhigh',
      ultracode: true,
      permissionMode: 'bypassPermissions',
    })
  })

  test('a source below xhigh is asked without ultracode', async () => {
    const { native, calls } = fakeNative(verified)
    await landMovedSettingsInApp(
      TARGET,
      landedPath,
      {
        effort: 'high',
        sessionSettings: { ultracode: true },
      },
      { native, readLanded: () => ({}), ultracodeByDefault: () => true },
    )
    expect(calls).toEqual([[TARGET, 'local_abc123', 'high', false, true]])
  })

  test('a native refusal is reported with its reason and never retried', async () => {
    const { native, calls } = fakeNative({ ok: false, reason: 'the app is not running' })
    const out = await landMovedSettingsInApp(
      TARGET,
      landedPath,
      { effort: 'high' },
      {
        native,
        readLanded: () => ({}),
        ultracodeByDefault: () => false,
      },
    )
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('the app is not running')
    expect(calls).toHaveLength(1)
  })

  test('a native throw is reported without throwing', async () => {
    const { native, calls } = fakeNative('throw')
    const out = await landMovedSettingsInApp(
      TARGET,
      landedPath,
      { effort: 'high' },
      {
        native,
        readLanded: () => ({}),
        ultracodeByDefault: () => false,
      },
    )
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('inspector went away')
    expect(calls).toHaveLength(1)
  })

  test('a landed record that is not an object is reported and the app is not asked', async () => {
    const { native, calls } = fakeNative(verified)
    const out = await landMovedSettingsInApp(
      TARGET,
      landedPath,
      { effort: 'high' },
      {
        native,
        readLanded: () => null as never,
        ultracodeByDefault: () => false,
      },
    )
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('could not read the landed record: it is not a JSON object')
    expect(calls).toHaveLength(0)
  })
})
