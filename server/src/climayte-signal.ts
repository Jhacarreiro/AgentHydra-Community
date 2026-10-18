// server/src/climayte-signal.ts — how a running CliMayte worker is told to wind down, and the hooks
// that carry it into the CLI.
//
// The daemon writes the worker's signal file (signalWindDown, climayte.ts). The CLI shows it to the
// model through a PostToolUse hook that runs after EVERY tool call. As a shell command (`cat <file>`)
// that hook cost Git's bash launcher, bash, cat and a conhost for each: measured 2026-10-04 on a box
// running 14 workers, about 88 of every 1,000 process births and 3 to 5 processes a call, to print
// nothing 12 times in 14. An `http` hook costs the CLI one POST to 127.0.0.1 and starts nothing, and
// a hook that cannot be reached is a non-blocking error, so a worker is never held up by it.
//
// What answers is the worker's OWN runner (climayte-runner.ts), not the daemon: it lives exactly as
// long as the worker, so a daemon restart (which may land on another port) cannot strand a running
// worker's hook, and a stalled daemon (9 s main-thread stalls were measured the same day) cannot
// slow its tool calls. The runner serves the signal file and, before it starts the CLI, rewrites the
// settings file the daemon wrote so the hook points at it. Until then, and if either step fails,
// the settings keep the `cat` form: nothing is lost, it is only dearer.
//
// Imports nothing of the daemon's: the runner process loads this too.

import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { Hono } from 'hono'
import { createLoopbackGuard } from './loopback-guard.mjs'

/** Longest a tool call can wait on the signal hook. The answer is one small file read; a runner that
 *  has not answered in this long is gone, and the call goes on without it. */
export const SIGNAL_HOOK_TIMEOUT_S = 3

/** Python that runs the script named in argv[1] as `__main__` when the file exists, and does nothing
 *  when it does not. Its folder goes first on sys.path, so a sibling module it imports resolves
 *  (under `python -S -c`, sys.path[0] is the worker's cwd, not the script's folder). */
export const RUN_IF_PRESENT =
  "import os,runpy,sys;p=sys.argv[1];sys.path[0:0]=[os.path.dirname(p)];os.path.isfile(p) and runpy.run_path(p,run_name='__main__')"

export const NO_BG_AGENT_REASON =
  "Background sub-agents are refused here: this session's CLI can end soon after your reply, and when the owner's next message arrives, and a background sub-agent dies with it. Run the sub-agents in the foreground (several Agent calls in one message run in parallel and this turn waits for all of them), or give work that must outlive the reply to climayte_run, which messages this chat when it finishes."

/** Node source for the Agent|Task PreToolUse hook: exit 2 with the reason on stderr (what the other
 *  guards do) when tool_input.run_in_background is true; exit 0 for anything else, even bad input. */
export const NO_BG_AGENT_SCRIPT = `let r='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>r+=c);process.stdin.on('end',()=>{let i=null;try{i=JSON.parse(r)}catch{}if(i&&i.tool_input&&i.tool_input.run_in_background===true){process.stderr.write(${JSON.stringify(NO_BG_AGENT_REASON)});process.exit(2)}process.exit(0)})`

export type Hook =
  | { type: 'command'; command: string; args?: string[]; timeout?: number }
  | { type: 'http'; url: string; timeout?: number }
export interface HookGroup {
  matcher: string
  hooks: Hook[]
}
export interface WorkerHooks {
  UserPromptSubmit?: Array<{ hooks: Hook[] }>
  SessionStart?: Array<{ hooks: Hook[] }>
  PreToolUse?: HookGroup[]
  PostToolUse: HookGroup[]
  Stop?: Array<{ hooks: Hook[] }>
}

/** Longest the Stop hook waits for the daemon. It answers from memory; a daemon that has not
 *  answered in this long is gone, and the worker stops as it would have without the hook. */
export const STOP_HOOK_TIMEOUT_S = 10

/** The hooks of a worker's own settings file, as the daemon writes them.
 *  - PostToolUse, every tool: the wind-down signal, in its shell form (the runner swaps in the http
 *    form, pointSignalHook). `signalFile` is slash-separated, for the shell.
 *  - PreToolUse on edits, when the owner's edit_claims hook is installed: it records the file under
 *    this task's id and says when another chat or worker edited it in the last half hour (2026-10-01:
 *    workers carry none of the owner's hooks, so their edits were invisible to the other chats). In
 *    exec form, `python` itself with no shell in front. The script never exits 2, but the
 *    interpreter does when it cannot open the file, and an exit 2 from a PreToolUse hook denies the
 *    edit: the shell form's `|| true` absorbed that, so the launcher below runs the script only if
 *    it is still there (proven against the real CLI 2.1.286: a missing script blocked every Write).
 *    `-S` skips the site import (the script reads only the standard library).
 *  - PreToolUse on Bash and PowerShell, for each of `guards` given: the owner's destructive_guard and
 *    push_force_guard, which refuse a `git clean -f` or a force push, and drive_root_guard, which
 *    refuses heavy work outside fairjob and a recursive grep. Workers carry none of the
 *    owner's hooks, and a worker running with permissions skipped ran `git clean -fd` in a shared
 *    checkout (2026-10-07). Same exec form and launcher as edit_claims, so a missing script does
 *    nothing and an exit 2 from a guard denies the call.
 *  - PreToolUse on Agent and Task, when `agentGuard` is set: an inline `node -e` (NO_BG_AGENT_SCRIPT, no python, no file to ship)
 *    exits 2 on run_in_background true, because a background sub-agent dies with the CLI process.
 *  - UserPromptSubmit, the `promptHooks` given: a chat's Manager Hydra router (ownerRouterHooks), which the
 *    owner's own sessions run from his settings and an account folder's settings never had.
 *  - Stop, when `stopUrl` is given (an ordinary worker, not a chat or a sealed one): an http hook the
 *    DAEMON answers, unlike the signal. It asks a worker whose estimate missed by more than
 *    REVIEW_BAND why, in the same turn (climayte-eta.ts stopDecision, climayteStopHook). It must be
 *    the daemon: the decision reads the worker's record. A daemon that is down or restarting makes
 *    the hook a non-blocking error, so the worker just stops, and one review is skipped.
 *  - Stop, also the `stopHooks` given: a core-mode chat's Hydra Core hook (its president rule). */
export function workerHooks(opts: {
  signalFile: string
  claims: string | null
  guards?: string[]
  /** Refuse a background sub-agent (Agent|Task) with NO_BG_AGENT_SCRIPT. */
  agentGuard?: boolean
  stopUrl?: string | null
  promptHooks?: Array<{ hooks: Hook[] }>
  sessionStartHooks?: Array<{ hooks: Hook[] }>
  stopHooks?: Array<{ hooks: Hook[] }>
}): WorkerHooks {
  const stop: Array<{ hooks: Hook[] }> = [
    ...(opts.stopHooks ?? []),
    ...(opts.stopUrl
      ? [{ hooks: [{ type: 'http', url: opts.stopUrl, timeout: STOP_HOOK_TIMEOUT_S } as Hook] }]
      : []),
  ]
  const guards = opts.guards ?? []
  const preToolUse: HookGroup[] = [
    ...(opts.claims
      ? [
          {
            matcher: 'Edit|Write|MultiEdit|NotebookEdit',
            hooks: [
              {
                type: 'command' as const,
                command: 'python',
                args: ['-S', '-c', RUN_IF_PRESENT, opts.claims],
                timeout: 10,
              },
            ],
          },
        ]
      : []),
    ...(guards.length
      ? [
          {
            matcher: 'Bash|PowerShell',
            hooks: guards.map((g) => ({
              type: 'command' as const,
              command: 'python',
              args: ['-S', '-c', RUN_IF_PRESENT, g],
              timeout: 10,
            })),
          },
        ]
      : []),
    ...(opts.agentGuard
      ? [
          {
            matcher: 'Agent|Task',
            hooks: [
              {
                type: 'command' as const,
                command: 'node',
                args: ['-e', NO_BG_AGENT_SCRIPT],
                timeout: 10,
              },
            ],
          },
        ]
      : []),
  ]
  return {
    ...(opts.promptHooks?.length ? { UserPromptSubmit: opts.promptHooks } : {}),
    ...(opts.sessionStartHooks?.length ? { SessionStart: opts.sessionStartHooks } : {}),
    ...(stop.length ? { Stop: stop } : {}),
    ...(preToolUse.length ? { PreToolUse: preToolUse } : {}),
    PostToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `cat '${opts.signalFile}' 2>/dev/null && rm -f '${opts.signalFile}' || true`,
          },
        ],
      },
    ],
  }
}

/** True when the hook input came from a tool call inside a sub-agent: the CLI sends `agent_id` only
 *  there. */
async function fromSubagent(req: { text: () => Promise<string> }): Promise<boolean> {
  try {
    const input = JSON.parse(await req.text()) as { agent_id?: unknown }
    return typeof input.agent_id === 'string' && input.agent_id.trim() !== ''
  } catch {
    return false
  }
}

/** Written at or after the note (the same second's slack as climayte-core's handoffWritten). */
function handoffWritten(path: string, noteAt: number): boolean {
  try {
    return statSync(path).mtimeMs >= noteAt - 1_000
  } catch {
    return false
  }
}

/** The handoff path a wind-down note asks for, or null when it asks for none. */
export function signalHandoff(signal: string): string | null {
  const full = (JSON.parse(signal) as { hookSpecificOutput?: { additionalContext?: string } })
    .hookSpecificOutput?.additionalContext
  if (typeof full !== 'string') return null
  return /with the Write tool to (.+?), for the session/.exec(full)?.[1] ?? null
}

/** A loopback server that answers each request with the signal file's JSON, or `{}` when there is
 *  none. The note is served once: the file is removed as it goes out, so the next tool call finds
 *  nothing. It is also not served when the handoff it asks for already exists (written after the
 *  note: a stale file from an earlier run with the same name does not count). A half-written file
 *  answers `{}` and stays. A tool call inside one of the worker's sub-agents always gets `{}` and
 *  leaves the note in place: the handoff is the worker's to write, and a sub-agent told to write it
 *  quits mid-task and overwrites the worker's own (2026-10-04). Null when no port could be bound. */
export function serveSignal(signalFile: string): { port: number; stop: () => void } | null {
  try {
    // The CLI's http hook is not a browser and sends no Origin, so it passes; a web page on any
    // local port carries an Origin that is on no list (empty allowlist) and is refused (AH-11).
    const app = new Hono()
    app.use('*', createLoopbackGuard({ allowedOrigins: () => [] }))
    app.all('*', async (c) => {
      let body = '{}'
      if (!(await fromSubagent(c.req))) {
        try {
          const text = readFileSync(signalFile, 'utf8')
          const at = statSync(signalFile).mtimeMs
          JSON.parse(text)
          rmSync(signalFile, { force: true })
          const handoff = signalHandoff(text)
          if (!handoff || !handoffWritten(handoff, at)) body = text
        } catch {
          // No signal yet, or not whole: nothing to say.
        }
      }
      return c.body(body, 200, { 'content-type': 'application/json' })
    })
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch })
    return { port: server.port as number, stop: () => void server.stop(true) }
  } catch {
    return null
  }
}

/** Rewrite the worker's settings so its PostToolUse hook is an http hook at the runner's port.
 *  False, with the file untouched, when it cannot be read or parsed. */
export function pointSignalHook(settingsFile: string, port: number): boolean {
  try {
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
      hooks?: Record<string, unknown>
    }
    settings.hooks = {
      ...settings.hooks,
      PostToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'http',
              url: `http://127.0.0.1:${port}/signal`,
              timeout: SIGNAL_HOOK_TIMEOUT_S,
            },
          ],
        },
      ],
    }
    writeFileSync(settingsFile, JSON.stringify(settings))
    return true
  } catch {
    return false
  }
}
