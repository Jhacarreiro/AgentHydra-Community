// server/tests/climayte-background.test.ts - a worker's Stop hook holds its turn open while a
// command it started in the background still runs (climayte-background.ts, climayteStopHook).
//
// test-audit (2026-10-14). contract: a live Bash-tool shell under the worker's CLI holds the stop
// and names the command; a bash child without the Bash tool's shell snapshot (an MCP server started
// through bash) never does; a worker that ignores the hold is let go after BACKGROUND_HOLDS_MAX.
// regression: two workers of a wave ended their turns over a queued test run and went done with no
// result. gap: nothing read the process table at the stop. seam: the real table, with this test
// process standing in for the CLI and real bash children under it.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { climayteStopHook } from '../src/climayte'
import { workers } from '../src/climayte-core'
import type { CliMayteWorker } from '../src/climayte-lib'
import { BACKGROUND_HOLDS_MAX } from '../src/climayte-steer'
import { killProcessTree } from '../src/core/process'

const GIT_BASH = join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe')
const canSpawn = process.platform === 'win32' && existsSync(GIT_BASH)
/** Each case starts and ends a real shell, which a loaded machine can take seconds to do. */
const SPAWN_TEST_MS = 30_000

/** The command line Claude Code's Bash tool gives a background command, around `command`. */
function bashToolLine(command: string): string {
  return `source /c/Users/me/.claude/shell-snapshots/snapshot-bash-1-example.sh 2>/dev/null || true && eval '${command}' < /dev/null && pwd -P >| /tmp/claude-1-cwd`
}

const spawned: number[] = []
afterEach(() => {
  for (const pid of spawned.splice(0)) killProcessTree(pid)
})

function spawnBash(line: string): number {
  const proc = Bun.spawn([GIT_BASH, '-c', line], {
    stdout: 'ignore',
    stderr: 'ignore',
    windowsHide: true,
  })
  spawned.push(proc.pid)
  return proc.pid
}

function runningWorker(id: string): CliMayteWorker {
  const w = {
    id,
    kind: 'code',
    status: 'running',
    title: 'Example task',
    prompt: 'p',
    message: 'p',
    attempts: [{ account: { id: 'a1' }, startedAt: Date.now(), endedAt: null, pid: process.pid }],
    pending: [],
    results: [],
  } as unknown as CliMayteWorker
  workers.set(w.id, w)
  return w
}

describe.skipIf(!canSpawn)('the Stop hook and background runs', () => {
  test(
    'a live Bash-tool run holds the stop and names the command; once it is gone, the stop goes through',
    () => {
      const w = runningWorker('w-bg-1')
      try {
        const pid = spawnBash(bashToolLine('sleep 30'))
        const held = climayteStopHook(w.id, {}) as { decision?: string; reason?: string }
        expect(held.decision).toBe('block')
        expect(held.reason).toContain(`pid ${pid}: sleep 30`)
        killProcessTree(pid)
        expect(climayteStopHook(w.id, { stop_hook_active: true })).toEqual({})
      } finally {
        workers.delete(w.id)
      }
    },
    SPAWN_TEST_MS,
  )

  test(
    'a bash child that is not a Bash-tool run (an MCP server started through bash) never holds it',
    () => {
      const w = runningWorker('w-bg-2')
      try {
        spawnBash('sleep 30')
        expect(climayteStopHook(w.id, {})).toEqual({})
      } finally {
        workers.delete(w.id)
      }
    },
    SPAWN_TEST_MS,
  )

  test(
    'a worker that keeps ending its turn over the run is let go after the last hold',
    () => {
      const w = runningWorker('w-bg-3')
      try {
        spawnBash(bashToolLine('sleep 30'))
        for (let i = 0; i < BACKGROUND_HOLDS_MAX; i++)
          expect(
            (climayteStopHook(w.id, { stop_hook_active: true }) as { decision?: string }).decision,
          ).toBe('block')
        expect(climayteStopHook(w.id, { stop_hook_active: true })).toEqual({})
      } finally {
        workers.delete(w.id)
      }
    },
    SPAWN_TEST_MS,
  )
})
