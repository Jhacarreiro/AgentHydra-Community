// Which runner a CliMayte worker starts under (climayte-runner.ts runnerKind). The Windows runner is
// built from source, not committed, so a Windows source checkout may not have it yet: that checkout
// runs workers under this app in runner mode, as macOS and Linux do. A release never falls back.
import { describe, expect, test } from 'bun:test'
import { runnerKind } from '../src/climayte-runner'

describe('runnerKind', () => {
  test('Windows takes the native runner whenever there is one', () => {
    expect(runnerKind('win32', false, true)).toBe('native')
    expect(runnerKind('win32', true, true)).toBe('native')
  })

  test('a Windows checkout without a built runner falls back to runner mode', () => {
    expect(runnerKind('win32', false, false)).toBe('bun')
  })

  test('a Windows release without one still asks for it, so the attempt fails naming the defect', () => {
    expect(runnerKind('win32', true, false)).toBe('native')
  })

  test('macOS and Linux always use runner mode', () => {
    for (const platform of ['linux', 'darwin'])
      for (const release of [false, true])
        for (const found of [false, true]) expect(runnerKind(platform, release, found)).toBe('bun')
  })
})
