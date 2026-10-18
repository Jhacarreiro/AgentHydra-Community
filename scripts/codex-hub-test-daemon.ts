#!/usr/bin/env bun
// scripts/codex-hub-test-daemon.ts — a real Codex hub in a scratch HOME, for a test outside the server's suite.
//
// The tray's end-to-end test (codex-hub-tray/test-linux.sh) pairs, exchanges and is revoked against the daemon
// itself, not only its stand-in hub. This starts `bun server/src/index.ts` with the hub on, on a free loopback port,
// with every state root in the scratch HOME (server/tests/codex-hub-daemon.ts, which the server's own multi-PC test
// uses too), prints the hub's URL alone on stdout once it answers, and stops it on SIGTERM or SIGINT.
//
//   bun scripts/codex-hub-test-daemon.ts --admin <token> [--legacy <token>] [--until <ISO 8601>] [--home <dir>]
//
// On stderr it names the hub's folder (seed a PC's folder there to make it pending) and its two log files. A scratch
// HOME it made itself is removed when it stops; one given with --home is kept, logs and all. Not on Windows: the
// daemon starts its tray host there at boot.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type HubSettings, startHub } from '../server/tests/codex-hub-daemon'

const USAGE =
  'usage: bun scripts/codex-hub-test-daemon.ts --admin <token> [--legacy <token>] [--until <ISO 8601>] [--home <dir>]'

function fail(text: string): never {
  console.error(text)
  process.exit(1)
}

const args = process.argv.slice(2)
const opts: Record<string, string> = {}
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i]!
  const value = args[i + 1]
  if (!['--admin', '--legacy', '--until', '--home'].includes(flag) || !value || flag in opts)
    fail(USAGE)
  opts[flag] = value
}
if (!opts['--admin']) fail(USAGE)
if (process.platform === 'win32')
  fail('the daemon starts its tray host on Windows at boot: run this on Linux or macOS')

const given = opts['--home'] ? resolve(opts['--home']) : null
const home = given ?? mkdtempSync(join(tmpdir(), 'codex-hub-test-daemon-'))
mkdirSync(home, { recursive: true })
const settings: HubSettings = {
  admin: opts['--admin'],
  ...(opts['--legacy'] ? { legacy: opts['--legacy'] } : {}),
  ...(opts['--until'] ? { until: opts['--until'] } : {}),
}

let hub: Awaited<ReturnType<typeof startHub>>
try {
  hub = await startHub(home, settings)
} catch (error) {
  if (!given) rmSync(home, { recursive: true, force: true })
  fail(error instanceof Error ? error.message : String(error))
}

console.error(`hub folder: ${hub.dir}`)
console.error(`hub logs: ${hub.logs.stdout} ${hub.logs.stderr}`)
console.log(hub.url)

let stopping = false
async function stop(code: number): Promise<never> {
  if (!stopping) {
    stopping = true
    await hub.stop()
    if (!given) rmSync(home, { recursive: true, force: true })
  }
  process.exit(code)
}
process.on('SIGTERM', () => void stop(0))
process.on('SIGINT', () => void stop(0))
// The hub ending by itself ends this too, with its code.
void hub.proc.exited.then((code) => {
  if (!stopping) {
    console.error(`the hub exited with ${code} (see ${hub.logs.stderr})`)
    void stop(1)
  }
})
