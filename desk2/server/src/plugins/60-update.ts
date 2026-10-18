// Restart to update (SPEC "Launcher"): the window learns when the server's own code changed on disk after
// it started, and its Menu restarts the server onto that code with launcher/restart.ps1, the chats running
// on. 2026-10-05: Send now, Fork and the servers pane each "did not work" for the owner only because the
// server still ran the code from before they landed, and nothing in the window said so. 2026-10-12, the owner: the
// same restart is an agent's to run too, so an agent asks it once its server code changed on disk (only then).

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import type { ServerUpdate } from '@shared/protocol'
import { callerKind, describeCaller, logRestartAsk, NOTHING_TO_UPDATE, RESTART_UNDER_WAY } from '../caller'
import type { ServerContext } from '../context'
import { detachedCommand } from '../host/launch'

const DESK = resolve(import.meta.dir, '..', '..', '..')
/** What the server runs: a change here needs a restart. The window's own build needs none (stale-bundle.ts). */
const CODE_DIRS = [join(DESK, 'server', 'src'), join(DESK, 'shared')]
const RESTART_SCRIPT = join(DESK, 'launcher', 'restart.ps1')

/** The newest change and the number of .ts files under the server's code. */
export interface CodeStamp {
  newest: number
  count: number
}

/** What the plugin reads from the machine; tests give fakes (createServer deps.update). */
export interface UpdateDeps {
  /** When this server started, ms since the epoch. */
  bootedAt: number
  stamp(): CodeStamp
  platform: NodeJS.Platform
  pid: number
  /** The process that started this server: start.ps1's cmd wrapper, when the launcher did. */
  ppid: number
  /** The port this server listens on (HYDRA_DESK_PORT, which start.ps1 sets): the restart's stop and start use it. */
  port: number
  /** Starts argv hidden and outside the server's process tree (stop.ps1 ends that tree); `failed` hears a start that did not happen. */
  start(argv: string[], failed: (err: Error) => void): void
}

export function codeStamp(dirs: string[] = CODE_DIRS): CodeStamp {
  let newest = 0
  let count = 0
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else if (e.name.endsWith('.ts')) {
        count++
        newest = Math.max(newest, statSync(path).mtimeMs)
      }
    }
  }
  for (const dir of dirs) if (existsSync(dir)) walk(dir)
  return { newest, count }
}

/**
 * True when the launcher started this very server: server.pid (PowerShell writes it with a BOM) names it, or names its
 * parent, the cmd wrapper start.ps1 records the moment it starts it. bun's own pid lands only once the server answers
 * and the tray is checked: 2026-10-14, a server restart.ps1 had just started read restartable:false for that second or
 * two, so an agent's restart to put new code live would have been refused.
 */
export function startedByLauncher(home: string, pid: number, ppid: number): boolean {
  try {
    const info = JSON.parse(readFileSync(join(home, 'server.pid'), 'utf8').replace(/^﻿/, '')) as { serverPid?: unknown; wrapperPid?: unknown }
    return Number(info.serverPid) === pid || (ppid > 0 && Number(info.wrapperPid) === ppid)
  } catch {
    return false
  }
}

const STAMP_TTL_MS = 30_000
/** A server still answering this long after it accepted a restart was not restarted: it takes the next ask. */
const RESTART_GRACE_MS = 120_000

/** codeStamp, walked at most once per STAMP_TTL_MS: the window asks every minute and on each hello. */
function cachedStamp(): () => CodeStamp {
  let last: { at: number; stamp: CodeStamp } | null = null
  return () => {
    if (!last || Date.now() - last.at > STAMP_TTL_MS) last = { at: Date.now(), stamp: codeStamp() }
    return last.stamp
  }
}

function realDeps(): UpdateDeps {
  return {
    bootedAt: performance.timeOrigin,
    stamp: cachedStamp(),
    platform: process.platform,
    pid: process.pid,
    ppid: process.ppid,
    port: Number(process.env.HYDRA_DESK_PORT) || 7798,
    start(argv, failed) {
      const plan = detachedCommand(process.platform, argv)
      const child = spawn(plan.argv[0]!, plan.argv.slice(1), { stdio: 'ignore', windowsHide: true, detached: plan.detached })
      child.on('error', (err) => {
        console.error('[update] could not start the restart:', err)
        failed(err)
      })
      child.unref()
    },
  }
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const deps = (ctx.deps.update as UpdateDeps | undefined) ?? realDeps()
  // The boot stamp is taken once the server has bound, off the startup path; a read before then takes it first.
  let atBoot: CodeStamp | null = null
  setTimeout(() => {
    atBoot ??= deps.stamp()
  }, 0)
  const restartable = () => deps.platform === 'win32' && startedByLauncher(ctx.home, deps.pid, deps.ppid)
  const stale = (): boolean => {
    const boot = (atBoot ??= deps.stamp())
    const now = deps.stamp()
    // A file saved after the start may or may not be what the server loaded: it counts as new.
    return now.newest > deps.bootedAt || now.count !== boot.count
  }
  /** When this server accepted a restart: until it is gone (or the grace runs out) one restart at a time. */
  let restartAcceptedAt: number | null = null

  app.get('/api/server/update', (c) => c.json({ stale: stale(), restartable: restartable() } satisfies ServerUpdate))

  app.post('/api/server/restart', (c) => {
    const who = describeCaller(c.req.raw.headers)
    if (!restartable()) {
      logRestartAsk(ctx.home, `restart asked: ${who} -> refused (not started by the launcher)`)
      return c.json({ error: "This server was not started by AgentHydra's window launcher, so nothing would bring it back. Leave it to the owner." }, 409)
    }
    if (restartAcceptedAt !== null && Date.now() - restartAcceptedAt < RESTART_GRACE_MS) {
      logRestartAsk(ctx.home, `restart asked: ${who} -> refused (a restart is under way)`)
      return c.json({ error: RESTART_UNDER_WAY }, 409)
    }
    // The window may restart at any time; an agent or a script only to put new server code live.
    if (callerKind(c.req.raw.headers) !== 'window' && !stale()) {
      logRestartAsk(ctx.home, `restart asked: ${who} -> refused (nothing to update)`)
      return c.json({ error: NOTHING_TO_UPDATE }, 409)
    }
    logRestartAsk(ctx.home, `restart asked: ${who} -> accepted`)
    // The script's output goes to its own file: the server appends its ask lines to restart.log while the script runs.
    const runLog = join(ctx.home, 'logs', 'restart-run.log')
    const quote = (s: string) => `'${s.replace(/'/g, "''")}'`
    // The script starts through WMI, outside this process tree, with none of this server's environment: it is told this
    // server's home and port, or it stops and starts the default Desk instead (2026-10-12: a Desk on a spare port did).
    const target = `$env:HYDRA_DESK_HOME = ${quote(ctx.home)}; $env:HYDRA_DESK_PORT = ${quote(String(deps.port))}`
    const command = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `${target}; & ${quote(RESTART_SCRIPT)} *>&1 | Out-File -Append -Encoding utf8 -FilePath ${quote(runLog)}`]
    // Only a restart that started holds off the next ask: a start that threw, or failed after this answer left, frees
    // the route at once (and a late failure is logged).
    const accepted = Date.now()
    restartAcceptedAt = accepted
    const release = () => {
      if (restartAcceptedAt === accepted) restartAcceptedAt = null
    }
    try {
      deps.start(command, (err) => {
        release()
        logRestartAsk(ctx.home, `restart asked: ${who} -> did not start (${err.message})`)
      })
    } catch (err) {
      release()
      throw err
    }
    return c.json({ ok: true }, 202)
  })
}
