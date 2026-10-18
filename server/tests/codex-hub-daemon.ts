// server/tests/codex-hub-daemon.ts — the daemon as a home server runs it, for a test that needs the real thing.
//
// codex-hub-multi-pc.test.ts and scripts/codex-hub-test-daemon.ts (the tray's end-to-end test, codex-hub-tray/) start
// `bun server/src/index.ts` with the hub on, in a scratch HOME on a loopback port, so every request meets what stands
// in front of the routes there: the /api loopback guard, the body limit and Bun.serve's WebSocket upgrade. Its stdout
// and stderr go to two files of their own, which a test reads for what the hub said and checks for secrets.
//
// Not on Windows: the daemon starts its tray host there at boot, which a test must not do.
import { join } from 'node:path'
import type { Subprocess } from 'bun'

const SERVER = join(import.meta.dir, '..')
// A daemon's boot is a real process: a cold CI runner is far slower than a desktop.
const BOOT_MS = 30_000

/** What the hub runs with: the admin token, and the migration settings when a test needs the window. */
export interface HubSettings {
  admin: string
  legacy?: string
  /** AGENTHYDRA_CODEX_HUB_LEGACY_UNTIL, as given. */
  until?: string
  /** Anything else to set, on top. */
  env?: Record<string, string>
}

export interface HubDaemon {
  url: string
  port: number
  /** The scratch HOME. */
  home: string
  /** The hub's copies and its store, `<home>/.agenthydra/codex-hub` (codex-hub.ts CODEX_HUB_DIR). */
  dir: string
  /** The files its stdout and stderr go to. */
  logs: { stdout: string; stderr: string }
  proc: Subprocess
  /** SIGTERM, then SIGKILL if it has not ended in 10 seconds. */
  stop(): Promise<void>
}

/** A loopback port nothing listens on now. */
export function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const { port } = probe
  probe.stop(true)
  return port
}

/**
 * The daemon's environment: the caller's own, with every state root it can write to moved into the scratch HOME.
 * Nothing guards the daemon's writes but this: it runs without the test preload. Each root is named outright rather
 * than left to HOME: config.ts moves a checkout's server/data into the data dir when none is named (a developer's
 * legacy state, deleted with the scratch), and an inherited CLAUDE_CONFIG_DIR would have the daemon register its MCP
 * entries in that account's real config, pointing its next sessions at a port that is gone. Only what this hub must
 * differ in is dropped: the port and bind host, and every Codex hub setting of the developer's.
 */
export function hubEnv(home: string, port: number, settings: HubSettings): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !/^(AGENTHYDRA_|CCMANAGERUI_)(CODEX_HUB_|PORT_FIXED$|MOCK_)/.test(k) &&
      !['PORT', 'HOST', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].includes(k)
    )
      env[k] = v
  const config = join(home, '.agenthydra')
  return Object.assign(
    env,
    {
      HOME: home,
      // As under `bun test`, which a script that starts it is not: the daemon's test-only quiet paths.
      NODE_ENV: 'test',
      PORT: String(port),
      AGENTHYDRA_PORT_FIXED: '1',
      AGENTHYDRA_CODEX_HUB_TOKEN: settings.admin,
      ...(settings.legacy ? { AGENTHYDRA_CODEX_HUB_LEGACY_TOKEN: settings.legacy } : {}),
      ...(settings.until ? { AGENTHYDRA_CODEX_HUB_LEGACY_UNTIL: settings.until } : {}),
      AGENTHYDRA_HOME: config,
      AGENTHYDRA_DATA_DIR: join(config, 'data'),
      AGENTHYDRA_DB: join(config, 'data', 'agenthydra.db'),
      AGENTHYDRA_RUN_LOG_DIR: join(config, 'data', 'run-logs'),
      AGENTHYDRA_CORE_DIR: join(config, 'core'),
      AGENTHYDRA_INSTANCES_ROOT: join(home, '.claude-instances'),
      AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(home, '.claude', 'projects'),
      AGENTHYDRA_CODEX_HOME: join(home, '.codex'),
      AGENTHYDRA_MCP_CONFIG: join(home, '.claude.json'),
      AGENTHYDRA_HOOKS_CONFIG: join(home, '.claude', 'settings.json'),
      AGENTHYDRA_CLAUDE_GUARD: '0',
      AGENTHYDRA_HSWARM_ENABLED: '0',
      HSWARM_HOME: join(home, '.hswarm'),
      HYDRA_FAMILY_DIR: join(home, '.hydra-family'),
    },
    settings.env,
  )
}

/**
 * The daemon, as `bun server/src/index.ts` with the hub on, in the scratch HOME `home` (which must exist); answers
 * once /api/health does. Its logs are `<home>/hub-<port>-<n>.{stdout,stderr}.log`, a pair for each start.
 */
export async function startHub(
  home: string,
  settings: HubSettings,
  port: number = freePort(),
): Promise<HubDaemon> {
  const base = join(home, `hub-${port}-${Date.now()}`)
  const logs = { stdout: `${base}.stdout.log`, stderr: `${base}.stderr.log` }
  const proc = Bun.spawn([process.execPath, join(SERVER, 'src', 'index.ts')], {
    cwd: SERVER,
    env: hubEnv(home, port, settings),
    stdout: Bun.file(logs.stdout),
    stderr: Bun.file(logs.stderr),
    windowsHide: true,
  })
  const stop = async () => {
    proc.kill('SIGTERM')
    const ended = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(10_000).then(() => false),
    ])
    if (!ended) proc.kill('SIGKILL')
    await proc.exited
  }
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + BOOT_MS
  while (Date.now() < deadline) {
    if (proc.exitCode !== null)
      throw new Error(
        `the hub exited with ${proc.exitCode} before it answered (see ${logs.stderr})`,
      )
    const up = await fetch(`${url}/api/health`).then(
      (r) => r.ok,
      () => false,
    )
    if (up)
      return { url, port, home, dir: join(home, '.agenthydra', 'codex-hub'), logs, proc, stop }
    await Bun.sleep(100)
  }
  proc.kill('SIGKILL')
  await proc.exited
  throw new Error(`the hub did not answer /api/health in time (see ${logs.stderr})`)
}
