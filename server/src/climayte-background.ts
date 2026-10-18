// server/src/climayte-background.ts - the commands a worker's CLI still runs in the background as
// its turn ends, read from the process table, so the Stop hook can hold the turn open on them.
//
// WHY (2026-10-14). A worker's session ends with its turn, nothing wakes it for a background job,
// and WORKER_BRIEF says so; two Haiku workers of a 16-worker wave still ended their turns with a
// queued test run in the background and went done with no result, and the runner's job closed and
// ended the run. The brief alone does not hold it, so the stop is refused while such a run lives.

import {
  type NativeProcess,
  nativeCommandLines,
  nativeProcessTable,
} from './core/win-process-table'

/** One background run: its shell's pid and the command it was given (cut to COMMAND_MAX). */
export interface BackgroundRun {
  pid: number
  command: string
}

const COMMAND_MAX = 200

const SHELL_NAME = /^(ba)?sh\.exe$/i

/** Claude Code's Bash tool sources its shell snapshot before the command, which an MCP server or a
 *  hook started through bash never does; a foreground Bash call is never alive when the turn ends. */
const BASH_TOOL_SHELL = /shell-snapshots\/snapshot-\S*\.sh/

/** The command itself, as the Bash tool quotes it: `eval '<command>'`, a quote inside as '\''. */
const EVAL_COMMAND = /eval '((?:[^']|'\\'')*)'/

/** The Bash-tool shells among the CLI's own children in `table`, with their command lines. */
export function backgroundRunsIn(
  cliPid: number,
  table: readonly NativeProcess[],
  commandLines: ReadonlyMap<number, string>,
): BackgroundRun[] {
  return table
    .filter((p) => p.ppid === cliPid && SHELL_NAME.test(p.name))
    .flatMap((p) => {
      const line = commandLines.get(p.pid)
      if (!line || !BASH_TOOL_SHELL.test(line)) return []
      const command = EVAL_COMMAND.exec(line)?.[1]?.replaceAll("'\\''", "'") ?? line
      return [{ pid: p.pid, command: command.slice(0, COMMAND_MAX) }]
    })
}

/** The CLI's background Bash-tool runs now (Windows), from a fresh snapshot: one shared by callers
 *  within the last second can predate a run started just before the stop. Null when the process
 *  table cannot be read here, which is "could not look", never "none running". */
export function readBackgroundRuns(cliPid: number): BackgroundRun[] | null {
  const table = nativeProcessTable({ fresh: true })
  if (!table) return null
  const shells = table.filter((p) => p.ppid === cliPid && SHELL_NAME.test(p.name)).map((p) => p.pid)
  if (!shells.length) return []
  const lines = nativeCommandLines(shells)
  return lines ? backgroundRunsIn(cliPid, table, lines) : null
}

/** What the Stop hook tells a worker whose turn is ending over `runs`. */
export function backgroundWaitReason(runs: readonly BackgroundRun[]): string {
  const list = runs.map((r) => `pid ${r.pid}: ${r.command}`).join('; ')
  return (
    `Your turn is ending while ${runs.length === 1 ? 'a command' : `${runs.length} commands`} you started in the background ${runs.length === 1 ? 'is' : 'are'} still running (${list}). ` +
    'Your session ends with this turn and nothing wakes it when a background command finishes: the command is then ended and its result is lost. ' +
    'Wait for it now, inside this turn: loop on its output with sleep, each Bash call under 10 minutes, until it finishes, then finish the task and report. ' +
    'If you no longer need it, kill it (kill <pid>) and then end your turn.'
  )
}
