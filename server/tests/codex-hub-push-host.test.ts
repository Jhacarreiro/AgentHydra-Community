// server/tests/codex-hub-push-host.test.ts — the standalone pusher ignores HOST; the daemon still refuses one.
//
// config.ts checks HOST as it loads (validateBindHost, hardening.test.ts). The pusher binds no port, so
// codex-hub-push-host.ts clears HOST before config loads, for the pusher only.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const src = join(import.meta.dir, '..', 'src')
// This environment without a hub, so a pusher stops at its own first check, which comes after config has loaded.
const noHub = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !/^(AGENTHYDRA|CCMANAGERUI)_CODEX_HUB_(URL|TOKEN)$/.test(k),
  ),
)
const run = (args: string[], host: string) =>
  spawnSync(process.execPath, args, {
    cwd: join(import.meta.dir, '..'),
    encoding: 'utf8',
    env: { ...noHub, HOST: host },
    timeout: 30_000,
  })

test('the pusher starts whatever HOST says', () => {
  for (const host of ['example.test', '0.0.0.0']) {
    const r = run([join(src, 'codex-hub-push-main.ts'), '--once'], host)
    // The pusher's own refusal of a missing hub, not config's of the HOST.
    expect(r.stderr).toBe('Set AGENTHYDRA_CODEX_HUB_URL and AGENTHYDRA_CODEX_HUB_TOKEN.\n')
    expect(r.status).toBe(2)
  }
  // A child bun's start: a few seconds on a busy box (codex-rpc.test.ts).
}, 60_000)

test('the daemon, which binds a port, still refuses a HOST that is not loopback', () => {
  const r = run(['-e', `await import(${JSON.stringify(join(src, 'config.ts'))})`], '0.0.0.0')
  expect(r.status).not.toBe(0)
  expect(r.stderr).toContain('HOST must be loopback-only')
}, 30_000)
