// server/tests/auto-update-push.test.ts - a push from this PC is taken at once (auto-update.ts watchRemoteRef). Owner,
// 2026-10-14, a landed change waiting up to 15 minutes for live: "whatever you're waiting on shouldn't wait".
// A real folder watched the way live watches refs/remotes/origin: git's lock-then-rename moves of the ref run one
// update tick once the ref is still, a burst of moves runs one, and another ref moving in the folder runs none.
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setAutoUpdateHooks,
  startAutoUpdate,
  stopAutoUpdate,
  watchRemoteRef,
} from '../src/auto-update'
import type { UpdateStatus } from '../src/updater'

const dir = mkdtempSync(join(tmpdir(), 'ah-push-watch-'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let checks = 0

setAutoUpdateHooks({
  check: async () => {
    checks++
    return { ok: true, updateAvailable: false } as UpdateStatus
  },
  apply: async () => {
    throw new Error('nothing is applied when the check finds nothing new')
  },
  relaunch: () => {},
  hasActiveRuns: () => false,
})
startAutoUpdate()

/** A ref moving the way git moves it on a push: the new value into `<name>.lock`, then renamed over the ref. */
function moveRef(name: string, sha: string): void {
  writeFileSync(join(dir, `${name}.lock`), `${sha}\n`)
  renameSync(join(dir, `${name}.lock`), join(dir, name))
}

beforeEach(() => {
  checks = 0
})
afterAll(() => {
  stopAutoUpdate()
  rmSync(dir, { recursive: true, force: true })
})

test('a burst of pushes runs one update check once the ref is still', async () => {
  const stop = watchRemoteRef(dir, 'main', 150)
  try {
    for (const sha of ['a1', 'b2', 'c3']) {
      moveRef('main', sha)
      await sleep(20)
    }
    expect(checks).toBe(0)
    await sleep(700)
    expect(checks).toBe(1)
  } finally {
    stop()
  }
})

test('another ref moving in the folder runs no check', async () => {
  const stop = watchRemoteRef(dir, 'main', 100)
  try {
    moveRef('other-branch', 'd4')
    await sleep(500)
    expect(checks).toBe(0)
  } finally {
    stop()
  }
})
