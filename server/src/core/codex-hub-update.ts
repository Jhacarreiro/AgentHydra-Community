// server/src/core/codex-hub-update.ts — the standalone pusher keeps itself at the hub's build.
//
// A PC that pushes its Codex chats runs codex-hub-push.exe from a scheduled task. Reinstalling it on every PC for
// each change does not scale past one PC, so the hub hands out the current build (GET /api/codex-hub/pusher, its
// SHA-256, and /download, each with `?platform=` naming this build's platform) and the pusher compares it with its
// own file at start and every few hours. A different
// build is downloaded beside it, checked against the hash, and started once with --version before it replaces the
// running one: a build that does not start is dropped and the old one keeps running. Windows lets a running exe be
// renamed but not overwritten, so the old file moves to `.old` (removed at the next start) and the new one takes its
// name; the old process exits and the new build starts in its place: started from here, or by the scheduled task or
// service manager that runs the pusher (restartPlan).
//
// The hash comes from the same address as the file, so over plain http it proves nothing. With an update key (the
// operator's public key: AGENTHYDRA_CODEX_HUB_UPDATE_KEY, or compiled in with --define) a build is taken only with
// the operator's signature for the pusher on this platform over that hash (codex-hub-signature.ts), checked before
// the download; without one, only from an https hub.
//
// Only a compiled pusher updates itself: a checkout running under bun is updated with git.
// AGENTHYDRA_CODEX_HUB_UPDATE=off keeps the installed build.

import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process'
import { chmodSync, renameSync, rmSync, statSync } from 'node:fs'
import { appEnv } from '../config'
import { sha256File } from './codex-hub'
import type { CodexHubPushConfig } from './codex-hub-push'
import { buildSignatureValid, updateKeyFrom } from './codex-hub-signature'

// The update key a build was compiled with: `bun build --compile --define AGENTHYDRA_CODEX_HUB_UPDATE_KEY='"<key>"'`.
declare const AGENTHYDRA_CODEX_HUB_UPDATE_KEY: string | undefined

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
  run?: (exe: string) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'error'>
  /** Starts the new build in this one's place, then this process exits. */
  relaunch?: (exe: string) => void
  log?: (line: string) => void
  /** The platform whose build is asked for; this build's own by default. */
  platform?: string
  /**
   * The hub builds that failed their checks here and would again, by hash and signature; startSelfUpdate keeps one
   * for its checks.
   */
  refused?: Set<string>
  /** The update key (base64); updateKey() by default, '' for none. */
  updateKey?: string
}

/**
 * The public key (base64, codex-hub-signature.ts) the hub's builds must be signed with: AGENTHYDRA_CODEX_HUB_UPDATE_KEY,
 * else the one this build was compiled with; '' when there is none.
 */
export function updateKey(): string {
  const compiled =
    typeof AGENTHYDRA_CODEX_HUB_UPDATE_KEY === 'string' ? AGENTHYDRA_CODEX_HUB_UPDATE_KEY : ''
  return appEnv('CODEX_HUB_UPDATE_KEY')?.trim() || compiled.trim()
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

/**
 * The environment a downloaded build's --version runs with: this one's with the hub's address and token empty. A
 * build that does not know --version (one from before it, or another program) would otherwise run as this PC's
 * pusher until the timeout, taking its relay link from this one; without them it stops at its own check. They are
 * set empty, not left out: a compiled bun program reads a .env in its working folder for what is not set at all.
 */
export function probeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const prefix of ['AGENTHYDRA_', 'CCMANAGERUI_'])
    for (const name of ['CODEX_HUB_URL', 'CODEX_HUB_TOKEN']) out[`${prefix}${name}`] = ''
  return out
}

const runVersion = (exe: string) =>
  spawnSync(exe, ['--version'], {
    encoding: 'utf8',
    timeout: VERSION_TIMEOUT_MS,
    windowsHide: true,
    env: probeEnv(),
  })

/** How a pusher under a service manager asks it to start the new build: EX_TEMPFAIL, a failure to restart on. */
export const RESTART_EXIT_CODE = 75

/**
 * Who starts the new build once it is in place. On Windows the scheduled task that runs the pusher
 * (install-codex-hub.ps1, every few minutes, one at a time): a process started from here would stay in the task's
 * job, which may end with this one. Under a service manager the manager (`exit`): systemd kills what is left in the
 * unit when its main process exits 0, and launchd starts the job again beside a copy started from here, so the
 * pusher exits with RESTART_EXIT_CODE for Restart=on-failure or KeepAlive to start the new file. systemd sets
 * INVOCATION_ID in a unit's environment and launchd XPC_SERVICE_NAME to the job's label; Terminal sets it to "0" and
 * an app launched from the Finder to `application.<id>`, which are not jobs that restart. AGENTHYDRA_CODEX_HUB_RESTART
 * says it outright: `exit`, or `spawn` for a pusher that starts its new build itself (the default anywhere else).
 */
export function restartPlan(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): 'task' | 'exit' | 'spawn' {
  if (platform === 'win32') return 'task'
  const said = (env.AGENTHYDRA_CODEX_HUB_RESTART ?? env.CCMANAGERUI_CODEX_HUB_RESTART)?.trim()
  if (said === 'exit' || said === 'spawn') return said
  const job = env.XPC_SERVICE_NAME ?? ''
  if (env.INVOCATION_ID || (job && job !== '0' && !job.startsWith('application.'))) return 'exit'
  return 'spawn'
}

/** Starts the new build in this one's place (restartPlan) and exits. */
export function relaunchSelf(exe: string): void {
  const plan = restartPlan()
  if (plan === 'exit') {
    console.log(
      `[codex-hub] exiting with ${RESTART_EXIT_CODE} for the service manager to start the new build`,
    )
    process.exit(RESTART_EXIT_CODE)
  }
  // In a compiled bun program argv is [bun, <script>, ...the arguments it was started with]. The new build writes
  // where this one did (a log file, a terminal); in a session of its own, it outlives this one and its terminal.
  if (plan === 'spawn')
    spawn(exe, process.argv.slice(2), { detached: true, stdio: 'inherit' }).unref()
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
  const keyText = deps.updateKey ?? updateKey()
  const key = keyText ? updateKeyFrom(keyText) : null
  if (keyText && !key) {
    log('kept this build: its update key is not a public key (base64 of 32 bytes)')
    return 'failed'
  }
  if (!key && !/^https:\/\//i.test(cfg.url)) {
    log(
      'kept this build: it has no update key (AGENTHYDRA_CODEX_HUB_UPDATE_KEY) and the hub is not https',
    )
    return 'failed'
  }
  const platform = deps.platform ?? buildPlatform()
  const headers = { ...cfg.headers, authorization: `Bearer ${cfg.token}` }
  const query = `?platform=${encodeURIComponent(platform)}`
  const meta = await doFetch(`${cfg.url}/api/codex-hub/pusher${query}`, { headers })
  if (meta.status === 404) return 'none'
  if (!meta.ok) throw new Error(`the hub answered ${meta.status} for its pusher build`)
  const want = (await meta.json()) as { sha256?: string; size?: number; signature?: string }
  if (typeof want.sha256 !== 'string') throw new Error('the hub sent no hash for its pusher build')
  const sha256 = want.sha256
  const signature = typeof want.signature === 'string' ? want.signature : ''
  if ((await sha256File(exe)) === sha256) return 'current'
  // A build that failed its checks here fails them again: it is not fetched until the hub hands out another, or
  // the same one with another signature (one signed after it was put in place). A download that does not match the
  // hash is not one of them: it may have been cut short or swapped on the way (over http the hub's signed hash can
  // come with other bytes), so the next check fetches it again.
  const seen = `${sha256} ${signature}`
  if (deps.refused?.has(seen)) return 'failed'

  const next = `${exe}.new`
  const drop = (why: string): UpdateOutcome => {
    rmSync(next, { force: true })
    log(`kept this build: ${why}`)
    return 'failed'
  }
  const refuse = (why: string): UpdateOutcome => {
    deps.refused?.add(seen)
    return drop(`${why} (not fetched again until the hub has another build)`)
  }
  // The signature covers the hash the download must match, so a build that is not signed is never fetched.
  if (key && !buildSignatureValid(key, 'pusher', platform, sha256, signature))
    return refuse(
      signature
        ? `the hub build is not signed with this build's update key for the pusher on ${platform}`
        : 'the hub build is not signed',
    )
  const res = await doFetch(`${cfg.url}/api/codex-hub/pusher/download${query}`, { headers })
  if (!res.ok) return drop(`the download answered ${res.status}`)
  await Bun.write(next, res)
  if (statSync(next).size !== want.size || (await sha256File(next)) !== sha256)
    return drop('the download does not match the hub hash')
  if (process.platform !== 'win32') chmodSync(next, 0o755)
  const tried = (deps.run ?? runVersion)(next)
  // A first start the antivirus held past the timeout says nothing about the build; an exit code or a crash does.
  if ((tried.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT')
    return drop(`the new build's --version did not end within ${VERSION_TIMEOUT_MS / 1000} s`)
  if (tried.status !== 0) return refuse('the new build did not start')
  // The tray's build starts too: only a build whose first line is the pusher's banner is the pusher.
  const [banner = ''] = String(tried.stdout ?? '').split('\n', 1)
  if (banner.trim() !== PUSHER_BANNER)
    return refuse(`the new build is another program (it printed ${JSON.stringify(banner.trim())})`)

  removeOldBuild(exe)
  renameSync(exe, `${exe}.old`)
  try {
    renameSync(next, exe)
  } catch (error) {
    renameSync(`${exe}.old`, exe)
    return drop(`could not put it in place (${error instanceof Error ? error.message : error})`)
  }
  log(`updated to the hub build ${sha256.slice(0, 12)}; restarting`)
  ;(deps.relaunch ?? relaunchSelf)(exe)
  return 'updated'
}

/**
 * Checks now and every few hours until stopped. A failed check is logged and tried again at the next one; a hub build
 * that failed its checks on its own bytes is remembered by its hash and signature and not fetched again (a build is
 * 60-90 MB).
 */
export function startSelfUpdate(cfg: CodexHubPushConfig, deps: UpdateDeps = {}): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const each = { ...deps, refused: deps.refused ?? new Set<string>() }
  const check = async () => {
    try {
      removeOldBuild(deps.exePath)
      await updateOnce(cfg, each)
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
