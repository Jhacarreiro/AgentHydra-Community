// server/tests/codex-hub-push-host.test.ts — the standalone pusher ignores HOST; the daemon still refuses one.
//
// config.ts checks HOST as it loads (validateBindHost, hardening.test.ts). The pusher binds no port, so
// codex-hub-push-host.ts clears HOST before config loads, for the pusher only.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const src = join(import.meta.dir, '..', 'src')
const run = (args: string[], host: string) =>
  spawnSync(process.execPath, args, {
    cwd: join(import.meta.dir, '..'),
    encoding: 'utf8',
    env: { ...process.env, HOST: host },
    timeout: 30_000,
  })

test('the pusher starts whatever HOST says', () => {
  for (const host of ['example.test', '0.0.0.0']) {
    const r = run([join(src, 'codex-hub-push-main.ts'), '--version'], host)
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('codex-hub-push\n')
    expect(r.status).toBe(0)
  }
  // A child bun's start: a few seconds on a busy box (codex-rpc.test.ts).
}, 60_000)

test('the daemon, which binds a port, still refuses a HOST that is not loopback', () => {
  const r = run(['-e', `await import(${JSON.stringify(join(src, 'config.ts'))})`], '0.0.0.0')
  expect(r.status).not.toBe(0)
  expect(r.stderr).toContain('HOST must be loopback-only')
}, 30_000)
