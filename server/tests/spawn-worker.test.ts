import { expect, test } from 'bun:test'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnCaptured, startProcess } from '../src/core/process.ts'
import { setSpawnWorkerIdleStopForTests } from '../src/core/spawn-worker.ts'

// spawnCaptured runs on a worker thread so Bun.spawn's 100-280 ms hold never lands on the daemon's
// loop; the contract the callers rely on must survive the hop.
test('spawnCaptured: stdout, stderr, exit code and env cross the worker', async () => {
  const r = await spawnCaptured(
    [process.execPath, '-e', 'console.log(process.env.SW_X); console.error("e"); process.exit(3)'],
    { env: { ...process.env, SW_X: 'hello' } },
  )
  expect(r).toEqual({ code: 3, stdout: 'hello\n', stderr: 'e\n', timedOut: false })
})

// The deadline starts when Bun.spawn returns, so the child must boot a whole bun and print inside it.
// Measured 2026-10-11 during the parallel suite on a box at 91% CPU: that boot took 0.46 s median,
// 0.95 s p90 and 2.55 s at worst, so the old 1.5 s deadline sometimes killed the child before it
// printed. 8 s is three times that worst case; the harness bound adds the kill and the 2 s drain wait.
test('spawnCaptured: a hung child is killed at the deadline and reported timedOut', async () => {
  const r = await spawnCaptured(
    [process.execPath, '-e', 'console.log("a"); setInterval(()=>{},1000)'],
    {
      timeoutMs: 8_000,
    },
  )
  expect(r.timedOut).toBe(true)
  expect(r.stdout).toBe('a\n')
}, 20_000)

// 2026-10-11: one thread spawns every capture, so a burst queued the CliMayte runner hand-off and the
// callers' netstats for minutes, and each one still started once the thread reached it. A capture
// that waited its whole deadline for the worker is answered timedOut and never started, so a backlog
// drains instead of growing (a 0 ms deadline has always passed by the time the worker reads it).
test('spawnCaptured: a capture that waited out its deadline for the worker never starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-worker-late-'))
  const marker = join(dir, 'started')
  try {
    const r = await spawnCaptured(
      [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
      { timeoutMs: 0, lane: 'spawn-worker-test' },
    )
    expect(r).toEqual({ code: null, stdout: '', stderr: '', timedOut: true })
    // A child that had been started would have written it by now.
    await Bun.sleep(3_000)
    expect(existsSync(marker)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 10_000)

test('spawnCaptured: a command that cannot start comes back as data', async () => {
  const r = await spawnCaptured(['definitely-not-a-command-xyz'])
  expect(r).toEqual({ code: null, stdout: '', stderr: '', timedOut: false })
})

// A long-lived child (the hswarm server) is started on a worker thread that watches it. The daemon
// restarts the server on its exit and stops it with kill(), so the pid, the child's own exit code, a
// log fd opened on this thread, and the kill must all cross the worker.
test('startProcess: a started child reports its pid, its exit code and its log, and kill() ends it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-worker-start-'))
  const log = join(dir, 'out.log')
  const fd = openSync(log, 'a')
  try {
    const quits = await startProcess(
      [process.execPath, '-e', 'console.log("up"); process.exit(3)'],
      { lane: 'spawn-worker-test', stdout: fd, stderr: fd },
    )
    expect(quits.pid).toBeGreaterThan(0)
    expect(await quits.exited).toBe(3)
    expect(readFileSync(log, 'utf8')).toBe('up\n')
    const runs = await startProcess([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      lane: 'spawn-worker-test',
    })
    runs.kill()
    const ended = await Promise.race([
      runs.exited.then(() => 'ended'),
      Bun.sleep(10_000).then(() => 'still running'),
    ])
    expect(ended).toBe('ended')
  } finally {
    closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)

// A lane's worker stops once idle, but never while it watches a child: a stopped watcher would leave
// the hswarm server's exit unreported for good. And a lane whose worker stopped still runs captures.
test('an idle lane stops its worker, never one watching a child, and still runs captures after', async () => {
  setSpawnWorkerIdleStopForTests(50)
  try {
    const lane = 'spawn-worker-idle'
    const echo = [process.execPath, '-e', 'console.log("ok")']
    const child = await startProcess(
      [process.execPath, '-e', 'setTimeout(() => process.exit(7), 1500)'],
      { lane },
    )
    // A capture that ends on the lane while the child runs is when an idle stop is weighed.
    expect((await spawnCaptured(echo, { lane, timeoutMs: 8_000 })).stdout).toBe('ok\n')
    const exit = await Promise.race([child.exited, Bun.sleep(10_000).then(() => 'unreported')])
    expect(exit).toBe(7)
    await Bun.sleep(300)
    expect(await spawnCaptured(echo, { lane, timeoutMs: 8_000 })).toEqual({
      code: 0,
      stdout: 'ok\n',
      stderr: '',
      timedOut: false,
    })
  } finally {
    setSpawnWorkerIdleStopForTests()
  }
}, 40_000)
