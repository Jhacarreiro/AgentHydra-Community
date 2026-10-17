// server/src/core/codex-hub-update.ts — the standalone pusher keeps itself at the hub's build.
//
// A PC that pushes its Codex chats runs codex-hub-push.exe from a scheduled task. Reinstalling it on every PC for
// each change does not scale past one PC, so the hub hands out the current build (GET /api/codex-hub/pusher, its
// SHA-256, and /download, each with `?platform=` naming this build's platform) and the pusher compares it with its
// own file at start and every few hours. A different
// build is downloaded beside it, checked against the hash, and started once with --version before it replaces the
// running one: a build that does not start is dropped and the old one keeps running. Windows lets a running exe be
// renamed but not overwritten, so the old file moves to `.old` (removed at the next start) and the new one takes its
// name; the old process exits and the new build starts in its place (relaunchSelf).
//
// Only a compiled pusher updates itself: a checkout running under bun is updated with git. The PC trusts the hub
// with its build as it already does with relay turns (codex-hub-relay-pc.ts); AGENTHYDRA_CODEX_HUB_UPDATE=off keeps
// the installed build.

import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process'
import { chmodSync, renameSync, rmSync, statSync } from 'node:fs'
import { appEnv } from '../config'
import { sha256File } from './codex-hub'
import type { CodexHubPushConfig } from './codex-hub-push'

const CHECK_EVERY_MS = 6 * 60 * 60_000
// A new exe is scanned by the antivirus on its first start.
const VERSION_TIMEOUT_MS = 60_000
/** What `codex-hub-push --version` prints first: how a downloaded build shows it starts. */
export const PUSHER_BANNER = 'codex-hub-push'

export type UpdateOutcome = 'current' | 'none' | 'updated' | 'failed'

export interface UpdateDeps {
  fetch?: typeof fetch
  /** The running pusher's own file. */
  exePath?: string
  /** Runs a build with --version; tests give a stand-in. */
  run?: (exe: string) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout'>
  /** Starts the new build in this one's place, then this process exits. */
  relaunch?: (exe: string) => void
  log?: (line: string) => void
  /** The platform whose build is asked for; this build's own by default. */
  platform?: string
}

/**
 * True for the compiled pusher: codex-hub-push.exe, or a build named for its platform as the hub names them
 * (codex-hub-push-linux-x64); false under bun from a checkout.
 */
export function isCompiledPusher(execPath = process.execPath): boolean {
  return /codex-hub-push(?:-[a-z0-9]+)*(?:\.exe)?$/i.test(execPath)
}

/** This build's platform as the hub names its builds (codex-hub.ts HUB_PLATFORMS): windows-x64, darwin-arm64, ... */
export function buildPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${platform === 'win32' ? 'windows' : platform}-${arch}`
}

/** Whether this pusher follows the hub's build: compiled, and not turned off on this PC. */
export function selfUpdateOn(execPath = process.execPath): boolean {
  return isCompiledPusher(execPath) && appEnv('CODEX_HUB_UPDATE')?.trim().toLowerCase() !== 'off'
}

/** The previous build, left by the last update; still held for a moment while that process exits. */
export function removeOldBuild(exePath = process.execPath): void {
  try {
    rmSync(`${exePath}.old`, { force: true })
  } catch {
    // its process has not exited yet: the next check removes it
  }
}

const runVersion = (exe: string) =>
  spawnSync(exe, ['--version'], {
    encoding: 'utf8',
    timeout: VERSION_TIMEOUT_MS,
    windowsHide: true,
  })

function relaunchSelf(exe: string): void {
  // On Windows the scheduled task that runs the pusher (install-codex-hub.ps1, every few minutes, one at a time)
  // starts the new build: a process started from here would stay in the task's job, which may end with this one.
  // In a compiled bun program argv is [bun, <script>, ...the arguments it was started with].
  if (process.platform !== 'win32')
    spawn(exe, process.argv.slice(2), { detached: true, stdio: 'ignore' }).unref()
  process.exit(0)
}

/** One check: nothing to do, or the hub's build verified, swapped in and started in this one's place. */
export async function updateOnce(
  cfg: CodexHubPushConfig,
  deps: UpdateDeps = {},
): Promise<UpdateOutcome> {
  const doFetch = deps.fetch ?? fetch
  const exe = deps.exePath ?? process.execPath
  const log = deps.log ?? ((line: string) => console.log(`[codex-hub] ${line}`))
  const headers = { ...cfg.headers, authorization: `Bearer ${cfg.token}` }
  const query = `?platform=${encodeURIComponent(deps.platform ?? buildPlatform())}`
  const meta = await doFetch(`${cfg.url}/api/codex-hub/pusher${query}`, { headers })
  if (meta.status === 404) return 'none'
  if (!meta.ok) throw new Error(`the hub answered ${meta.status} for its pusher build`)
  const want = (await meta.json()) as { sha256?: string; size?: number }
  if (typeof want.sha256 !== 'string') throw new Error('the hub sent no hash for its pusher build')
  if ((await sha256File(exe)) === want.sha256) return 'current'

  const next = `${exe}.new`
  const drop = (why: string): UpdateOutcome => {
    rmSync(next, { force: true })
    log(`kept this build: ${why}`)
    return 'failed'
  }
  const res = await doFetch(`${cfg.url}/api/codex-hub/pusher/download${query}`, { headers })
  if (!res.ok) return drop(`the download answered ${res.status}`)
  await Bun.write(next, res)
  if (statSync(next).size !== want.size || (await sha256File(next)) !== want.sha256)
    return drop('the download does not match the hub hash')
  if (process.platform !== 'win32') chmodSync(next, 0o755)
  const tried = (deps.run ?? runVersion)(next)
  if (tried.status !== 0) return drop('the new build did not start')
  // The tray's build starts too: only a build whose first line is the pusher's banner is the pusher.
  const [banner = ''] = String(tried.stdout ?? '').split('\n', 1)
  if (banner.trim() !== PUSHER_BANNER)
    return drop(`the new build is another program (it printed ${JSON.stringify(banner.trim())})`)

  removeOldBuild(exe)
  renameSync(exe, `${exe}.old`)
  try {
    renameSync(next, exe)
  } catch (error) {
    renameSync(`${exe}.old`, exe)
    return drop(`could not put it in place (${error instanceof Error ? error.message : error})`)
  }
  log(`updated to the hub build ${want.sha256.slice(0, 12)}; restarting`)
  ;(deps.relaunch ?? relaunchSelf)(exe)
  return 'updated'
}

/** Checks now and every few hours until stopped. A failed check is logged and tried again at the next one. */
export function startSelfUpdate(cfg: CodexHubPushConfig, deps: UpdateDeps = {}): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const check = async () => {
    try {
      removeOldBuild(deps.exePath)
      await updateOnce(cfg, deps)
    } catch (error) {
      console.error(
        '[codex-hub] update check failed:',
        error instanceof Error ? error.message : error,
      )
    }
    if (!stopped) timer = setTimeout(check, CHECK_EVERY_MS)
  }
  void check()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
