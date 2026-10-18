// server/tests/climayte-claim-clock.test.ts — a runner's minute to claim its spec runs from the end of
// its hand-off, never while the hand-off still waits.
//
// 2026-10-11, 06:10-08:00 UTC: the Windows hand-off (a powershell that has WMI start the runner) sat
// queued on the spawn worker for over a minute, and the minute counted from the launch. So checks were
// voided as "never started" 405 times (35 workers then failed "the check itself is broken" on a plain
// `test -s`), 80 workers failed "stopped three times in a row" with no CLI ever started, and each void
// launched one more hand-off into the same queue. noteHandoff is what launchRunner records.

import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CheckRunner, checkLost } from '../src/climayte-checks'
import { runnerSpecPath } from '../src/climayte-core'
import type { CliMayteWorker } from '../src/climayte-lib'
import { noteHandoff } from '../src/climayte-runner'
import { type Attempt, attemptExited } from '../src/climayte-stops'

const dir = mkdtempSync(join(tmpdir(), 'ah-claim-clock-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A runner launched two minutes ago that has written nothing, its spec still unclaimed. */
function unclaimed(name: string): CheckRunner {
  const log = join(dir, `${name}.log`)
  writeFileSync(runnerSpecPath(log), '{}')
  return {
    log,
    pid: null,
    pidFile: `${log}.pid.json`,
    exitFile: `${log}.exit.json`,
    launchedAt: Date.now() - 120_000,
  }
}

test('a check is not lost while its hand-off waits, and is voided a minute after it ends', () => {
  const r = unclaimed('check')
  const spec = runnerSpecPath(r.log)
  noteHandoff(spec, null)
  expect(checkLost(r)).toBeNull()
  noteHandoff(spec, Date.now() - 30_000)
  expect(checkLost(r)).toBeNull()
  expect(existsSync(spec)).toBe(true)
  noteHandoff(spec, Date.now() - 61_000)
  expect(checkLost(r)).toBe('never started')
  expect(existsSync(spec)).toBe(false)

  // A hand-off this daemon never made (an earlier daemon's, which died with it): from the launch.
  const before = unclaimed('check-earlier-daemon')
  expect(checkLost(before)).toBe('never started')
})

test('an attempt has not exited while its hand-off waits, and is voided a minute after it ends', () => {
  const { log, ...runner } = unclaimed('attempt')
  const at = { log, pid: null, runner } as unknown as Attempt
  const w = { id: 'w-claim-clock', attempts: [at] } as unknown as CliMayteWorker
  const spec = runnerSpecPath(log)
  noteHandoff(spec, null)
  expect(attemptExited(w, at)).toBe(false)
  expect(existsSync(spec)).toBe(true)
  noteHandoff(spec, Date.now() - 61_000)
  expect(attemptExited(w, at)).toBe(true)
  expect(existsSync(spec)).toBe(false)
})
