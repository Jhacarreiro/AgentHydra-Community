/**
 * The always-on helpers the daemon runs: one list, one owner.
 *
 * ⛔ WHY (owner, 2026-10-12: "all this could probably be better integrated into stuff instead of just
 * being random PowerShells that sit on their own, and Pythons that sit on their own ... this
 * collection is both disorganized and inefficient"). A census that day found 47 always-on processes
 * (2.6 GB) on his PC, started by six launchers: Task Scheduler, the tray, Desk, whichever chat came
 * first, WMI and a Windows service. Nothing showed them together or stopped them together. Here each
 * helper in the owner's helpers.json is started when nothing runs it, adopted when something already
 * does (a chat's connect helper, or the daemon before a restart), started again when it is gone or
 * outgrows its memory cap, and listed with its pid and memory in the window's header.
 *
 * The list belongs to the person, not the app: `<CONFIG_DIR>/helpers.json`, so a PC without one runs
 * nothing from here. A helper keeps running across a daemon restart and the next daemon adopts it,
 * so a chat's MCP server is not dropped each time the daemon updates.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { APP_ROOT, CONFIG_DIR, DATA_DIR } from './config'
import { killProcessTree, startProcess } from './core/process'
import {
  INFO_WORKING_SET,
  nativeCommandLines,
  nativeProcessInfo,
  nativeProcessTable,
} from './core/win-process-table'
import { windowsTcpTable } from './core/win-tcp-table'
import { getHSwarmStatus } from './hswarm'
import type { HelperRow, HelperState, HelpersView } from './types'

/** One entry of helpers.json. `{APP_ROOT}` and `{HOME}` are expanded in command, cwd and env. */
export interface HelperSpec {
  id: string
  label: string
  command: string[]
  cwd?: string
  env?: Record<string, string>
  /** The port it listens on: the listener's owner is the helper. */
  port?: number
  /** Without a port: the process named `exe` whose command line contains `match`. */
  exe?: string
  match?: string
  /** Its working set past this is ended and started again. */
  memoryCapMB?: number
}

/** A process lookup: its pid, none running, or could not look (never read as "none"). */
export type Lookup = number | 'none' | 'unknown'

export interface HelperDeps {
  configPath: string
  statePath: string
  logDir: string
  appRoot: string
  findByPort(port: number): Lookup
  findByCommand(exe: string, match: string): Lookup
  memoryMB(pid: number): number | null
  alive(pid: number): boolean
  /** Starts it hidden with stdout and stderr in `logFile`; resolves its pid. */
  spawn(
    cmd: string[],
    opts: { cwd?: string; env: Record<string, string | undefined>; logFile: string },
  ): Promise<number | null>
  kill(pid: number): void
  now(): number
}

/** How often every helper is looked at. */
export const CHECK_EVERY_MS = 15_000
/** A helper just started may take this long to open its port before it counts as failed. */
const START_GRACE_MS = 60_000
/** A helper that ran at least this long and then went away is started again at once. */
const STABLE_MS = 2 * 60_000
const FIRST_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 15 * 60_000
const LOG_MAX_BYTES = 5 * 1024 * 1024
const TCP_STATE_LISTEN = 2

interface Slot {
  spec: HelperSpec
  state: HelperState
  pid: number | null
  /** The pid this daemon started, while it may still be starting. */
  startedPid: number | null
  startedAt: number
  since: number | null
  restarts: number
  failures: number
  nextTryAt: number
  adopted: boolean
  memoryMB: number | null
  lastError: string | null
}

function expand(value: string, appRoot: string): string {
  return value.replaceAll('{APP_ROOT}', appRoot).replaceAll('{HOME}', homedir())
}

/** helpers.json, read and checked. A bad entry is reported by id and skipped; the rest still run. */
export function readHelperSpecs(
  path: string,
  appRoot: string,
): { specs: HelperSpec[]; error: string | null } {
  if (!existsSync(path)) return { specs: [], error: null }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return {
      specs: [],
      error: `${path} is not JSON: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  const list = (raw as { helpers?: unknown })?.helpers
  if (!Array.isArray(list)) return { specs: [], error: `${path} has no "helpers" list` }
  const specs: HelperSpec[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const [i, e] of list.entries()) {
    const s = e as Partial<HelperSpec>
    const id = typeof s?.id === 'string' && s.id ? s.id : `#${i + 1}`
    const command =
      Array.isArray(s?.command) && s.command.every((c) => typeof c === 'string') ? s.command : null
    if (!command?.length) problems.push(`${id}: no command`)
    else if (seen.has(id)) problems.push(`${id}: listed twice`)
    else if (!s.port && !(s.exe && s.match))
      problems.push(`${id}: needs a port, or an exe and a match, to be found`)
    else {
      seen.add(id)
      specs.push({
        id,
        label: typeof s.label === 'string' && s.label ? s.label : id,
        command: command.map((c) => expand(c, appRoot)),
        cwd: typeof s.cwd === 'string' ? expand(s.cwd, appRoot) : undefined,
        env: s.env
          ? Object.fromEntries(
              Object.entries(s.env).map(([k, v]) => [k, expand(String(v), appRoot)]),
            )
          : undefined,
        port: typeof s.port === 'number' ? s.port : undefined,
        exe: s.exe,
        match: s.match,
        memoryCapMB: typeof s.memoryCapMB === 'number' ? s.memoryCapMB : undefined,
      })
    }
  }
  return { specs, error: problems.length ? `${path}: ${problems.join('; ')}` : null }
}

export function createHelpers(deps: HelperDeps) {
  const slots = new Map<string, Slot>()
  let configError: string | null = null
  let paused = readPaused()

  function readPaused(): boolean {
    try {
      return JSON.parse(readFileSync(deps.statePath, 'utf8'))?.paused === true
    } catch {
      return false
    }
  }

  function writePaused(next: boolean): void {
    paused = next
    try {
      writeFileSync(deps.statePath, JSON.stringify({ paused: next }))
    } catch {
      // still paused for this daemon's life
    }
  }

  function syncSpecs(): void {
    const { specs, error } = readHelperSpecs(deps.configPath, deps.appRoot)
    configError = error
    const ids = new Set(specs.map((s) => s.id))
    for (const id of [...slots.keys()]) if (!ids.has(id)) slots.delete(id)
    for (const spec of specs) {
      const slot = slots.get(spec.id)
      if (slot) slot.spec = spec
      else
        slots.set(spec.id, {
          spec,
          state: 'waiting',
          pid: null,
          startedPid: null,
          startedAt: 0,
          since: null,
          restarts: 0,
          failures: 0,
          nextTryAt: 0,
          adopted: false,
          memoryMB: null,
          lastError: null,
        })
    }
  }

  function find(spec: HelperSpec): Lookup {
    if (spec.port) return deps.findByPort(spec.port)
    return deps.findByCommand(spec.exe as string, spec.match as string)
  }

  function gone(slot: Slot, why: string): void {
    const now = deps.now()
    const ranFor = slot.since === null ? 0 : now - slot.since
    slot.failures = ranFor >= STABLE_MS ? 0 : slot.failures + 1
    slot.nextTryAt = slot.failures
      ? now + Math.min(FIRST_BACKOFF_MS * 2 ** (slot.failures - 1), MAX_BACKOFF_MS)
      : now
    slot.state = 'waiting'
    slot.pid = null
    slot.startedPid = null
    slot.since = null
    slot.memoryMB = null
    slot.lastError = why
  }

  async function start(slot: Slot): Promise<void> {
    const { spec } = slot
    const logFile = join(deps.logDir, `${spec.id}.log`)
    try {
      const pid = await deps.spawn(spec.command, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        logFile,
      })
      slot.startedPid = pid
      slot.startedAt = deps.now()
      slot.state = 'starting'
      slot.adopted = false
    } catch (e) {
      gone(slot, `could not start: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function check(slot: Slot): Promise<void> {
    const found = find(slot.spec)
    if (found === 'unknown') {
      slot.lastError = 'could not read the process table'
      return
    }
    const now = deps.now()
    if (typeof found === 'number') {
      if (slot.pid !== found) {
        slot.adopted = found !== slot.startedPid
        slot.since = now
      }
      slot.pid = found
      slot.startedPid = null
      slot.state = 'running'
      slot.memoryMB = deps.memoryMB(found)
      const cap = slot.spec.memoryCapMB
      if (cap && slot.memoryMB !== null && slot.memoryMB > cap) {
        deps.kill(found)
        slot.restarts++
        gone(slot, `used ${Math.round(slot.memoryMB)} MB, over its ${cap} MB cap: restarted`)
        // Outgrowing the cap is not a failure to start: the next check starts it, with no wait.
        slot.failures = 0
        slot.nextTryAt = now
      } else if (slot.failures && now - (slot.since ?? now) >= STABLE_MS) {
        slot.failures = 0
      }
      return
    }
    if (paused) {
      slot.state = 'stopped'
      return
    }
    if (slot.state === 'starting' && slot.startedPid !== null) {
      const alive = deps.alive(slot.startedPid)
      if (alive && now - slot.startedAt < START_GRACE_MS) return
      if (alive) deps.kill(slot.startedPid)
      const what = slot.spec.port
        ? `never listened on port ${slot.spec.port}`
        : 'was never found running'
      gone(slot, alive ? `started but ${what}; ended` : 'exited right after it started')
      return
    }
    if (slot.state === 'running') {
      slot.restarts++
      gone(slot, 'stopped running')
    }
    if (now < slot.nextTryAt) return
    await start(slot)
  }

  let ticking = false
  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      syncSpecs()
      for (const slot of slots.values()) await check(slot)
    } finally {
      ticking = false
    }
  }

  function row(slot: Slot): HelperRow {
    return {
      id: slot.spec.id,
      label: slot.spec.label,
      state: slot.state,
      pid: slot.pid ?? slot.startedPid,
      port: slot.spec.port ?? null,
      memoryMB: slot.memoryMB === null ? null : Math.round(slot.memoryMB),
      since: slot.since === null ? null : new Date(slot.since).toISOString(),
      restarts: slot.restarts,
      adopted: slot.adopted,
      lastError: slot.lastError,
    }
  }

  return {
    tick,
    view(): HelpersView {
      return {
        paused,
        configPath: deps.configPath,
        configError,
        helpers: [...slots.values()].map(row),
      }
    },
    /** End it now; the tick after starts a fresh one. False when no helper has that id. */
    async restart(id: string): Promise<boolean> {
      const slot = slots.get(id)
      if (!slot) return false
      const pid = slot.pid ?? slot.startedPid
      if (pid) deps.kill(pid)
      slot.restarts++
      gone(slot, 'restarted by hand')
      slot.failures = 0
      slot.nextTryAt = 0
      await tick()
      return true
    },
    /** End every helper and start none, across daemon restarts, until startAll. */
    async stopAll(): Promise<void> {
      writePaused(true)
      for (const slot of slots.values()) {
        const pid = slot.pid ?? slot.startedPid
        if (pid) deps.kill(pid)
        Object.assign(slot, {
          state: 'stopped',
          pid: null,
          startedPid: null,
          since: null,
          memoryMB: null,
        })
      }
    },
    async startAll(): Promise<void> {
      writePaused(false)
      for (const slot of slots.values())
        Object.assign(slot, { failures: 0, nextTryAt: 0, state: 'waiting' })
      await tick()
    },
  }
}

function openLog(file: string): number {
  try {
    if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`)
  } catch {
    // no log yet
  }
  return openSync(file, 'a')
}

function listenerPid(port: number): Lookup {
  const rows = windowsTcpTable()
  if (!rows) return 'unknown'
  return rows.find((r) => r.localPort === port && r.state === TCP_STATE_LISTEN)?.pid ?? 'none'
}

function commandPid(exe: string, match: string): Lookup {
  const table = nativeProcessTable()
  if (!table) return 'unknown'
  const pids = table.filter((p) => p.name.toLowerCase() === exe.toLowerCase()).map((p) => p.pid)
  if (!pids.length) return 'none'
  const lines = nativeCommandLines(pids)
  if (!lines) return 'unknown'
  const want = match.toLowerCase()
  for (const pid of pids) if (lines.get(pid)?.toLowerCase().includes(want)) return pid
  return 'none'
}

function realDeps(): HelperDeps {
  const logDir = join(DATA_DIR, 'logs', 'helpers')
  return {
    configPath: join(CONFIG_DIR, 'helpers.json'),
    statePath: join(DATA_DIR, 'helpers-state.json'),
    logDir,
    appRoot: APP_ROOT,
    findByPort: listenerPid,
    findByCommand: commandPid,
    memoryMB: (pid) => {
      const ws = nativeProcessInfo(pid, INFO_WORKING_SET)?.workingSetSize
      return typeof ws === 'number' ? ws / (1024 * 1024) : null
    },
    alive: (pid) => nativeProcessTable({ fresh: true })?.some((p) => p.pid === pid) ?? true,
    spawn: async (cmd, { cwd, env, logFile }) => {
      const exe = Bun.which(cmd[0] as string)
      if (!exe) throw new Error(`${cmd[0]} is not on PATH`)
      mkdirSync(logDir, { recursive: true })
      const fd = openLog(logFile)
      try {
        const child = await startProcess([exe, ...cmd.slice(1)], {
          lane: 'helpers',
          cwd,
          env,
          stdout: fd,
          stderr: fd,
        })
        void child.exited.finally(() => closeSync(fd))
        return child.pid ?? null
      } catch (e) {
        closeSync(fd)
        throw e
      }
    },
    kill: killProcessTree,
    now: () => Date.now(),
  }
}

let helpers: ReturnType<typeof createHelpers> | null = null
let timer: ReturnType<typeof setInterval> | null = null

/** Starts looking after the helpers (Windows only: the lookups are Windows'), at once and every CHECK_EVERY_MS. */
export function startHelpers(): void {
  if (process.platform !== 'win32' || helpers) return
  helpers = createHelpers(realDeps())
  const run = () => {
    try {
      helpers
        ?.tick()
        .catch((e) =>
          console.error('[helpers] check failed:', e instanceof Error ? e.message : String(e)),
        )
    } catch (e) {
      console.error('[helpers] check failed:', e instanceof Error ? e.message : String(e))
    }
  }
  run()
  timer = setInterval(() => {
    try {
      run()
    } catch (e) {
      console.error('[helpers] check failed:', e instanceof Error ? e.message : String(e))
    }
  }, CHECK_EVERY_MS)
  ;(timer as { unref?(): void }).unref?.()
}

/** The helpers and HSwarm's sidecar, which hswarm.ts runs itself. */
export function helpersView(): HelpersView {
  const view = helpers?.view() ?? {
    paused: false,
    configPath: join(CONFIG_DIR, 'helpers.json'),
    configError: null,
    helpers: [],
  }
  const hs = getHSwarmStatus()
  const memory = hs.pid ? nativeProcessInfo(hs.pid, INFO_WORKING_SET)?.workingSetSize : null
  view.helpers.push({
    id: 'hswarm',
    label: 'HSwarm',
    state: hs.running ? 'running' : 'stopped',
    pid: hs.pid,
    port: hs.port,
    memoryMB: typeof memory === 'number' ? Math.round(memory / (1024 * 1024)) : null,
    since: null,
    restarts: 0,
    adopted: false,
    lastError: hs.lastError,
    managed: true,
  })
  return view
}

export async function restartHelper(id: string): Promise<boolean> {
  return (await helpers?.restart(id)) ?? false
}

export async function stopAllHelpers(): Promise<void> {
  await helpers?.stopAll()
}

export async function startAllHelpers(): Promise<void> {
  await helpers?.startAll()
}
