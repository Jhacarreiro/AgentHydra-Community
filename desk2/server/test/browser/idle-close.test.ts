import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { DirActivity } from '../../src/browser/agent/activity'
import { makeIdleCloser, type IdleCloseDeps } from '../../src/browser/idle-close'

const MIN = 60_000
const IDLE = 15 * MIN
const DIR = resolve('/profiles/example-a')

function setup(over: Partial<IdleCloseDeps> = {}) {
  let clock = 0
  const activity = new Map<string, DirActivity>()
  const closed: string[] = []
  const marks = new Set<string>()
  const markedAtClose: boolean[] = []
  const deps: IdleCloseDeps = {
    liveBrowser: async () => ({ port: 9001 }),
    headless: () => true,
    liveView: () => false,
    signInHeld: () => false,
    loginPending: () => false,
    activity: () => activity,
    markClosing: (dir) => marks.add(dir),
    clearClosing: (dir) => marks.delete(dir),
    close: async (dir) => {
      markedAtClose.push(marks.has(dir))
      closed.push(dir)
      return true
    },
    log: () => {},
    ...over,
  }
  const sweep = makeIdleCloser(deps, () => clock)
  return {
    closed,
    marks,
    markedAtClose,
    activity,
    sweep: () => sweep([DIR], IDLE),
    at: (minutes: number) => {
      clock = minutes * MIN
    },
  }
}

describe('the idle close of a saved browser', () => {
  test('closes a headless browser once no tool call has touched it for the idle time', async () => {
    const s = setup()
    s.at(0)
    expect(await s.sweep()).toEqual([])
    s.at(14)
    expect(await s.sweep()).toEqual([])
    s.at(15)
    expect(await s.sweep()).toEqual([DIR])
    expect(s.closed).toEqual([DIR])
  })

  test('each tool call restarts the clock from its last time', async () => {
    const s = setup()
    s.activity.set(DIR, { last: 10 * MIN, busy: 0 })
    s.at(0)
    await s.sweep()
    s.at(15)
    expect(await s.sweep()).toEqual([])
    s.at(25)
    expect(await s.sweep()).toEqual([DIR])
  })

  test('a call in flight keeps the browser open however long it runs', async () => {
    const s = setup()
    s.activity.set(DIR, { last: 0, busy: 1 })
    s.at(0)
    await s.sweep()
    s.at(60)
    expect(await s.sweep()).toEqual([])
    expect(s.closed).toEqual([])
  })

  test('a browser is closed only after its call answers and the idle time passes again', async () => {
    const s = setup()
    s.activity.set(DIR, { last: 0, busy: 1 })
    s.at(0)
    await s.sweep()
    s.at(30)
    s.activity.set(DIR, { last: 30 * MIN, busy: 0 })
    expect(await s.sweep()).toEqual([])
    s.at(45)
    expect(await s.sweep()).toEqual([DIR])
  })

  test.each([
    ['a visible window is never closed', { headless: () => false }],
    ['a live view in the Browser pane holds the Chrome open', { liveView: () => true }],
    ['a sign-in window keeps the browser open past the idle time', { signInHeld: () => true }],
    ['an unverified login keeps the browser open past the idle time', { loginPending: () => true }],
  ])('%s', async (_name, over) => {
    const s = setup(over)
    s.at(0)
    await s.sweep()
    s.at(60)
    expect(await s.sweep()).toEqual([])
    expect(s.closed).toEqual([])
  })

  test('a call that lands after the idle check but before the close keeps the browser open', async () => {
    const s = setup({ markClosing: () => s.activity.set(DIR, { last: 0, busy: 1 }) })
    s.at(0)
    await s.sweep()
    s.at(20)
    expect(await s.sweep()).toEqual([])
    expect(s.closed).toEqual([])
    expect(s.marks.size).toBe(0)
  })

  test('a call stamped after the sweep started keeps the browser open', async () => {
    const s = setup({ markClosing: () => s.activity.set(DIR, { last: 20 * MIN, busy: 0 }) })
    s.at(0)
    await s.sweep()
    s.at(20)
    expect(await s.sweep()).toEqual([])
    expect(s.closed).toEqual([])
  })

  test('the profile is marked as closing while its Chrome closes, and the mark is cleared after', async () => {
    const s = setup()
    s.at(0)
    await s.sweep()
    s.at(15)
    expect(await s.sweep()).toEqual([DIR])
    expect(s.markedAtClose).toEqual([true])
    expect(s.marks.size).toBe(0)
  })

  test('a profile whose Chrome is not running has nothing to close', async () => {
    const s = setup({ liveBrowser: async () => null })
    s.at(0)
    await s.sweep()
    s.at(60)
    expect(await s.sweep()).toEqual([])
  })
})
