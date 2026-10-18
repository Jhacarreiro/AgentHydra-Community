import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  activityPath,
  awaitNotClosing,
  clearClosing,
  markClosing,
  noteUse,
  readActivity,
  setActivityHome,
  withCall,
} from '../../../src/browser/agent/activity'

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'activity-'))
  setActivityHome(home)
})

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true })
  home = ''
})

const DIR = resolve(join(tmpdir(), 'example-profile'))

describe('a call that meets Desk closing the same profile', () => {
  test('a call waits while Desk is closing the browser, then runs once the close is done', async () => {
    markClosing(home, DIR)
    let ran = false
    const call = awaitNotClosing(DIR).then(() => {
      ran = true
    })
    await new Promise((r) => setTimeout(r, 300))
    expect(ran).toBe(false)
    clearClosing(home, DIR)
    await call
    expect(ran).toBe(true)
  })

  test('a mark left by a Desk that died does not hold a call for longer than a minute', async () => {
    mkdirSync(join(home, 'browser-agent'), { recursive: true })
    writeFileSync(
      join(home, 'browser-agent', 'closing.json'),
      JSON.stringify({ dirs: { [DIR]: Date.now() - 120_000 } }),
    )
    const timeout = new Promise((r) => setTimeout(() => r('held'), 1000))
    expect(await Promise.race([awaitNotClosing(DIR).then(() => 'ran'), timeout])).toBe('ran')
  })

  test('a call on a profile Desk is not closing does not wait', async () => {
    markClosing(home, DIR)
    clearClosing(home, DIR)
    const timeout = new Promise((r) => setTimeout(() => r('held'), 1000))
    expect(await Promise.race([awaitNotClosing(DIR).then(() => 'ran'), timeout])).toBe('ran')
  })
})

describe('the browser tools activity file', () => {
  test('a call counts its profile as busy until it answers, then stamps the time', async () => {
    let during = -1
    await withCall(async () => {
      noteUse(DIR)
      during = readActivity(home).get(DIR)?.busy ?? -1
    })
    const after = readActivity(home).get(DIR)
    expect(during).toBe(1)
    expect(after?.busy).toBe(0)
    expect(after?.last).toBeGreaterThan(0)
  })

  test('concurrent calls on one profile are both counted', async () => {
    let during = -1
    const one = withCall(async () => {
      noteUse(DIR)
      await new Promise((r) => setTimeout(r, 20))
    })
    await withCall(async () => {
      noteUse(DIR)
      await new Promise((r) => setTimeout(r, 5))
      during = readActivity(home).get(DIR)?.busy ?? -1
    })
    await one
    expect(during).toBe(2)
    expect(readActivity(home).get(DIR)?.busy).toBe(0)
  })

  test('a call that uses one profile twice counts it once', async () => {
    let during = -1
    await withCall(async () => {
      noteUse(DIR)
      noteUse(DIR)
      during = readActivity(home).get(DIR)?.busy ?? -1
    })
    expect(during).toBe(1)
  })

  test('a use outside any call only stamps the time', () => {
    noteUse(DIR)
    const row = readActivity(home).get(DIR)
    expect(row?.busy).toBe(0)
    expect(row?.last).toBeGreaterThan(0)
  })

  test('calls the writer no longer runs count for nothing', () => {
    mkdirSync(join(home, 'browser-agent'), { recursive: true })
    writeFileSync(
      activityPath(home),
      JSON.stringify({ pid: 999999, dirs: { [DIR]: { last: 1234, busy: 2 } } }),
    )
    expect(readActivity(home).get(DIR)).toEqual({ last: 1234, busy: 0 })
  })

  test('a live writer reports its calls in flight', () => {
    mkdirSync(join(home, 'browser-agent'), { recursive: true })
    writeFileSync(
      activityPath(home),
      JSON.stringify({ pid: process.pid, dirs: { [DIR]: { last: 1234, busy: 2 } } }),
    )
    expect(readActivity(home).get(DIR)).toEqual({ last: 1234, busy: 2 })
  })
})
