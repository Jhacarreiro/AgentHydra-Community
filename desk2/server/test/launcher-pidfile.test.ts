// The launcher's pid file (launcher/start.ps1 writes it) names the server it started by pid AND start time, so a
// recycled pid is never taken for it. start.ps1 and stop.ps1 read it back with ConvertFrom-Json under either
// PowerShell: the window's Restart to update runs Windows PowerShell 5.1, a terminal usually PowerShell 7, which reads
// the recorded ISO time as a DateTime instead of text. 2026-10-11: under PowerShell 7 stop.ps1 called the running
// server "a different process now" and left it alone, so a frozen server was never stopped by its pid, and start.ps1
// would start a second server beside one still booting.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const LAUNCHER = resolve(import.meta.dir, '../../launcher')
const SHELLS = ['powershell', 'pwsh'].filter((s) => Bun.which(s))
// Nothing listens on port 1, so start.ps1's health check fails at once and it consults the pid file.
const PORT = '1'

let standIn: ReturnType<typeof Bun.spawn> | null = null
let started = ''
let home = ''

async function run(shell: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    env: { ...process.env, HYDRA_DESK_HOME: home, HYDRA_DESK_PORT: PORT },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return out
}

/** What each script says about a pid file naming the stand-in server with this start time, under each shell. */
async function readings(serverStarted: string): Promise<{ shell: string; stop: string; start: string }[]> {
  writeFileSync(
    join(home, 'server.pid'),
    JSON.stringify({ wrapperPid: 0, wrapperStarted: '', serverPid: standIn!.pid, serverStarted, port: Number(PORT) }),
  )
  return Promise.all(
    SHELLS.map(async (shell) => {
      const [stop, start] = await Promise.all([
        run(shell, ['-File', join(LAUNCHER, 'stop.ps1'), '-DryRun']),
        run(shell, ['-File', join(LAUNCHER, 'start.ps1'), '-DryRun', '-NoWindow']),
      ])
      return { shell, stop, start }
    }),
  )
}

describe.skipIf(process.platform !== 'win32' || SHELLS.length === 0)('the launcher pid file', () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'desk-pidfile-'))
    standIn = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 120000)'], { stdout: 'ignore', stderr: 'ignore' })
    // start.ps1's own spelling of a start time (Save-ServerPid).
    started = (
      await run('powershell', ['-Command', `(Get-Process -Id ${standIn.pid}).StartTime.ToUniversalTime().ToString('o')`])
    ).trim()
    // One Windows PowerShell start: 1.2-1.7 s alone on a box at ~90% CPU (2026-10-11); in the root suite's parallel
    // run that day a PowerShell start took up to 8.2 s (server/tests/mocks/climayte-timing.ts), past bun's 5 s default.
  }, 30_000)
  afterAll(() => {
    standIn?.kill()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  test('names the server it started under either PowerShell', async () => {
    for (const r of await readings(started)) {
      expect({ shell: r.shell, stop: r.stop }).toEqual({ shell: r.shell, stop: expect.stringContaining(`pid ${standIn!.pid} and its children`) })
      expect({ shell: r.shell, start: r.start }).toEqual({ shell: r.shell, start: expect.stringContaining('still booting') })
    }
  }, 60_000)

  test('leaves alone a pid whose start time is not the recorded one', async () => {
    const other = started.replace(/^\d{4}/, (year) => String(Number(year) - 1))
    for (const r of await readings(other)) {
      expect({ shell: r.shell, stop: r.stop }).toEqual({ shell: r.shell, stop: expect.stringContaining('a different process now') })
      expect({ shell: r.shell, start: r.start }).toEqual({ shell: r.shell, start: expect.stringContaining('would start hidden') })
    }
  }, 60_000)
})
