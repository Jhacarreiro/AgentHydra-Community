// A windowsTask routine's task, read and controlled through Windows (shared/routines.ts). Windows runs the task on its own
// schedule; this only reads it (one hidden PowerShell call for ALL the tasks, never one process per task) and runs it,
// pauses it or resumes it (schtasks). The pause IS the task's Disabled state, so nothing is stored here. Only the parser
// is pure; the calls below are the only places a process starts, and the tests never reach them.

import { execFile, spawn } from 'node:child_process'

/** What one task reads as: found or not, its state, its last run and result, and when it next runs (ms, or null). */
export interface TaskReading {
  path: string
  found: boolean
  /** Running, Ready, Disabled, Queued, Unknown, ... as Task Scheduler names them; null when not found. */
  state: string | null
  /** When it last started, ms; null when it never ran (Windows says 1899) or it is not found. */
  lastRunAt: number | null
  /** The last run's exit code (0 is success); null when none. 267009 means still running; 267011 means never ran. */
  lastTaskResult: number | null
  nextRunAt: number | null
}

/** The task-scheduler result codes that mean "nothing to record yet": still running, or never ran. */
export const TASK_RUNNING = 267009
export const TASK_NEVER_RAN = 267011

/** Reads every task named in ROUTINES_TASK_PATHS (a JSON list of full paths) in one go, printing one JSON list. */
export const TASK_READ_SCRIPT = `
$ErrorActionPreference = 'Stop'
# "Preparing modules for first use" goes to stderr as CLIXML and buried the real error.
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 writes a parsed JSON list as ONE object, so @(ConvertFrom-Json ...) made a list holding the
# list and $p was every path at once. Assigned first, it is the list itself.
$paths = ConvertFrom-Json $env:ROUTINES_TASK_PATHS
$out = foreach ($p in @($paths)) {
  $i = $p.LastIndexOf('\\')
  $folder = $p.Substring(0, $i + 1)
  $name = $p.Substring($i + 1)
  try {
    $t = Get-ScheduledTask -TaskPath $folder -TaskName $name
    $info = Get-ScheduledTaskInfo -TaskPath $folder -TaskName $name
    [pscustomobject]@{
      path = $p; found = $true; state = [string]$t.State
      lastRunTime = if ($info.LastRunTime) { $info.LastRunTime.ToString('o') } else { $null }
      lastTaskResult = [int64]$info.LastTaskResult
      nextRunTime = if ($info.NextRunTime) { $info.NextRunTime.ToString('o') } else { $null }
    }
  } catch {
    [pscustomobject]@{ path = $p; found = $false; state = $null; lastRunTime = $null; lastTaskResult = $null; nextRunTime = $null }
  }
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`

const iso = (v: unknown): number | null => {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

/**
 * The read script's stdout, checked: one reading per path asked for, in the same order. A path the output does not name
 * is listed as not found. Throws when the output is not a JSON list.
 */
export function parseTaskReadings(stdout: string, paths: string[]): TaskReading[] {
  let v: unknown
  try {
    v = JSON.parse(stdout.trim())
  } catch {
    throw new Error('Windows printed no task list')
  }
  const rows = (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []) as Record<string, unknown>[]
  const byPath = new Map(rows.filter((r) => typeof r.path === 'string').map((r) => [r.path as string, r]))
  return paths.map((path): TaskReading => {
    const r = byPath.get(path)
    if (!r || r.found !== true) return { path, found: false, state: null, lastRunAt: null, lastTaskResult: null, nextRunAt: null }
    const last = iso(r.lastRunTime)
    return {
      path,
      found: true,
      state: typeof r.state === 'string' ? r.state : null,
      // Windows says 1899 for a task that never ran: that is no run to record.
      lastRunAt: last !== null && new Date(last).getFullYear() >= 2000 ? last : null,
      lastTaskResult: typeof r.lastTaskResult === 'number' ? r.lastTaskResult : null,
      nextRunAt: iso(r.nextRunTime),
    }
  })
}

/** Reads the named tasks in one hidden PowerShell call. Rejects when it cannot run or does not finish in 60 seconds. */
export function readTasks(paths: string[]): Promise<TaskReading[]> {
  return new Promise((resolve, reject) => {
    if (paths.length === 0) return resolve([])
    let stdout = ''
    let stderr = ''
    const encoded = Buffer.from(TASK_READ_SCRIPT, 'utf16le').toString('base64')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ROUTINES_TASK_PATHS: JSON.stringify(paths) },
    })
    const timer = setTimeout(() => child.kill(), 60_000)
    child.stdout.setEncoding('utf8').on('data', (t: string) => (stdout += t))
    child.stderr.setEncoding('utf8').on('data', (t: string) => (stderr += t))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`Windows could not read the tasks (exit ${code}): ${stderr.trim().slice(0, 300)}`))
      try {
        resolve(parseTaskReadings(stdout, paths))
      } catch (err) {
        reject(err)
      }
    })
  })
}

/** Runs a task now, hidden (schtasks /run). Rejects with schtasks' own words when it refuses. */
export function runTaskNow(path: string): Promise<void> {
  return schtasks(['/run', '/tn', path])
}

/** Pauses (disables) or resumes (enables) a task, hidden (schtasks /change). */
export function setTaskEnabled(path: string, enabled: boolean): Promise<void> {
  return schtasks(['/change', '/tn', path, enabled ? '/enable' : '/disable'])
}

function schtasks(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('schtasks', args, { windowsHide: true, timeout: 60_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve()
    })
  })
}
