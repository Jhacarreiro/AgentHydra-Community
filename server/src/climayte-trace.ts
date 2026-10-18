// Who dispatched a CliMayte worker, for its From column. A trace is ALWAYS recorded at dispatch and kept
// with the worker; it never pings anyone. The ping target (climayte-ping.ts, `origin`) is a different
// thing: a dispatch with a ping origin has the same chat as its trace, and a dispatch without one still
// names its caller, a chat when one is found, else the process that sent it, else what it declared.
import { processAncestry } from './core/process'

/** Who dispatched a worker, as far as anyone could tell. `sessionId` names a chat (its title is looked
 *  up for the view), `workerId` a CliMayte worker, `label` a readable name for a process or a declared
 *  dispatcher. A worker with no trace at all predates the trace. */
export interface CliMayteTrace {
  sessionId?: string
  workerId?: string
  label?: string
}

/** A dispatcher's own declaration (the `by` field): a label, and optionally the chat it runs under.
 *  The session is used for the trace only, never for a ping. */
export interface CliMayteBy {
  label: string
  sessionId?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LABEL_MAX = 80

/** The `by` field of a dispatch as the route or the MCP tool sent it. Absent or null is no declaration;
 *  anything else must be `{label, sessionId?}` with a label of 1 to 80 characters and a session id in
 *  UUID form. A malformed one is the caller's mistake: the route answers 400 with the reason. */
export function parseBy(v: unknown): { by: CliMayteBy | undefined; why: string | null } {
  if (v === undefined || v === null) return { by: undefined, why: null }
  if (typeof v !== 'object' || Array.isArray(v))
    return { by: undefined, why: 'by must be an object: {label, sessionId?}' }
  const o = v as Record<string, unknown>
  const label = typeof o.label === 'string' ? o.label.trim() : ''
  if (!label || label.length > LABEL_MAX)
    return { by: undefined, why: `by.label must be 1 to ${LABEL_MAX} characters` }
  if (o.sessionId === undefined || o.sessionId === null) return { by: { label }, why: null }
  if (typeof o.sessionId !== 'string' || !UUID.test(o.sessionId))
    return { by: undefined, why: 'by.sessionId must be a session id' }
  return { by: { label, sessionId: o.sessionId }, why: null }
}

const SCRIPT = /\.(py|mjs|cjs|js|ts|ps1|sh)$/i
const SHELL = /^(cmd|powershell|pwsh|bash|sh|zsh|conhost)(\.exe)?$/i

/** A Python module run by name: `-m hswarm`, or `runpy.run_module('hswarm', ...)` in a `-c` line (HSwarm's shared
 *  server, 2026-10-13, which read only "pythonw" before). */
const MODULE = /(?:^|\s)-m\s+([\w.]+)|run_module\(\s*['"]([\w.]+)['"]/

/** A readable name for a process's script from its command line: the script's folder and file, as in
 *  `michaiel/act.py`, else the Python module it runs, as in `hswarm`. Flags and arguments are never part of it.
 *  Null when no script or module is named. */
export function scriptLabel(commandLine: string | null | undefined): string | null {
  if (!commandLine) return null
  for (const token of commandLine.match(/"[^"]*"|\S+/g) ?? []) {
    const path = token.replace(/^"|"$/g, '')
    if (!SCRIPT.test(path)) continue
    const parts = path.split(/[\\/]+/).filter(Boolean)
    return parts.slice(-2).join('/').slice(0, LABEL_MAX)
  }
  const module = commandLine.match(MODULE)
  return module ? (module[1] ?? module[2] ?? '').slice(0, LABEL_MAX) || null : null
}

/** How deep the walk looks for a named script: a launcher's script is one or two hops up at most. */
const LABEL_DEPTH = 4

/** A readable label for the process `startPid` (and, when `includeSelf` is false, its parents): the first
 *  script named in the chain, else the first process that is not a bare shell, by its program name.
 *  Null when the process table cannot be read. */
export async function processLabel(startPid: number, includeSelf: boolean): Promise<string | null> {
  const chain = await processAncestry(startPid, { includeSelf })
  if (!chain?.length) return null
  for (const p of chain.slice(0, LABEL_DEPTH)) {
    const script = scriptLabel(p.commandLine)
    if (script) return script
  }
  const named = chain.find((p) => p.name && !SHELL.test(p.name))
  return named?.name ? named.name.replace(/\.exe$/i, '').slice(0, LABEL_MAX) : null
}

/** The longest a dispatch waits to read the calling process's name. Past it the trace says an unidentified
 *  process: the process table walk is a netstat and a PowerShell read, and a jammed one must not hold a
 *  dispatch (the same reason as CALLER_ORIGIN_BUDGET_MS). */
export const PROCESS_TRACE_BUDGET_MS = 5_000

/** The trace of one dispatch, from what is known about it. A chat (the ping origin, or the chat the caller
 *  runs under) is the trace's session; a declared label wins over a derived one; a process label is used
 *  only when no chat and no declared label names the caller. `process` is read lazily: it is a process
 *  walk, paid for only when nothing else names the dispatcher. Never empty: the last word is the process,
 *  and "an unidentified process" when even that cannot be read. */
export async function buildTrace(p: {
  workerId?: string | null
  chatSessionId?: string | null
  by?: CliMayteBy
  process: () => Promise<string | null>
}): Promise<CliMayteTrace> {
  const trace: CliMayteTrace = {}
  if (p.workerId) trace.workerId = p.workerId
  const sessionId = p.by?.sessionId ?? p.chatSessionId ?? null
  if (sessionId) trace.sessionId = sessionId
  if (p.by) trace.label = p.by.label
  else if (!trace.sessionId && !trace.workerId) trace.label = await processName(p.process)
  return trace
}

async function processName(read: () => Promise<string | null>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PROCESS_TRACE_BUDGET_MS)
  })
  try {
    return (await Promise.race([read().catch(() => null), late])) ?? 'an unidentified process'
  } finally {
    clearTimeout(timer)
  }
}
