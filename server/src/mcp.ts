// AgentHydra MCP server (stdio) — a thin client over the running daemon's REST API, so an
// MCP-speaking agent (Claude Desktop/Code, Cursor) shares one source of truth with the web UI.
// Start the daemon first (`bun run start` from repo root); point elsewhere with
// AGENTHYDRA_URL / AGENTHYDRA_PORT.
//
// The JSON-RPC 2.0 / MCP protocol + the stdio loop live in the SHARED, zero-dependency engine
// `./mcp-stdio.mjs` (part of the shared kit — edit it there, never here). This file is only the
// app-specific part: an HTTP client + a tool table, each tool a thin proxy over an existing
// /api/* route from index.ts. Beyond the sessions/queue/accounts/scheduler/instances/update tools,
// this also exposes the usage-check subsystem (check_usage / check_my_usage — any agent can read
// its own remaining quota; the weekly all-models % is the binding cap), CLI instances, and the
// auto-resume monitor.
//
// INSTANCE NUMBERS. Everything here that addresses one instance takes an `instance` argument, and
// that argument accepts the instance's permanent NUMBER (`7`, `#7`). That is the identifier a human
// can say out loud and write into a prompt — the alternatives an instance carries are a Windows
// folder path and a random uuid, neither of which survives being spoken. Start at
// list_instance_numbers (the whole fleet, one number each, across Claude Desktop + Claude CLI +
// Codex), resolve_instance (confirm which account a reference means before spending its quota) and
// whoami (which numbered instance THIS process is). The legacy `dir` / `id` parameters all still
// work exactly as before; the number is purely additive.
//
// SELF-IDENTIFICATION runs HERE, in the MCP server process, not on the daemon — see mcp-self.ts
// and core/self-identity.ts. `whoami`, `check_my_usage` and a bare `usage_budget` all share it, so
// an agent can answer "whose quota am I spending?" without being told, including from a Claude
// Desktop session, which sets no CLAUDE_CONFIG_DIR at all.
//
// THE PARTS. The daemon HTTP client and the shared schema helpers are mcp-client.ts; the sessions,
// analytics, queue, incidents and agent-status tools are mcp-session-tools.ts; the fan-out tools
// are mcp-fan-out.ts. TOOLS below assembles them in the order agents have always seen.

import { RECENT_FINISHED } from './climayte-lib'
import { buildTrace, type CliMayteBy, parseBy, processLabel } from './climayte-trace'
import { VERSION } from './config'
import { DEV_SERVERS_TOOLS } from './dev-servers-tool'
import { BABYSITTER_TOOLS } from './mcp-babysitter'
import {
  AUTO_DETACH_MS,
  api,
  apiOrLocal,
  busyRefusal,
  CLIMAYTE_MAX_WAIT_S,
  detachedAnswer,
  type HydraTool,
  handleFrom,
  INSTANCE_PARAM,
  JSON_HEADERS,
  MCP_WAIT_MAX_MS,
  qs,
  type ResolvedInstanceRow,
  resolveRef,
  runScript,
  S,
  stillRunningNote,
  str,
  withCallBudget,
  withDaemonWarning,
} from './mcp-client'
import { CORE_TOOLS } from './mcp-core'
import { DASHBOARD_TOOLS } from './mcp-dashboards'
import { FAMILY_TOOLS } from './mcp-family-tools'
import { FAN_OUT_TOOLS } from './mcp-fan-out'
import { findTools } from './mcp-find'
import { FREE_TOOLS } from './mcp-free'
import { MANAGER_TOOLS } from './mcp-managers'
import { withOutputShaping } from './mcp-output'
import { PRICECHECK_TOOLS } from './mcp-pricecheck'
import { ROUTINES_TOOLS } from './mcp-routines'
import {
  CALLER_AWARE_TOOLS,
  CALLER_PID_ARG,
  type CallerChatOrigin,
  callerOrigin,
  callerPidFromArgs,
  instanceLabel,
  type SelfIdentityPayload,
  selfIdentity,
  withNextStep,
} from './mcp-self'
import { SESSION_TOOLS } from './mcp-session-tools'
import type { McpEngineTool } from './mcp-stdio.mjs'
import { runMcpStdio } from './mcp-stdio.mjs'
import { SUE_DREDD_TOOLS } from './mcp-sue-dredd'
import type { UsageSnapshot } from './types'

// Tests, index.ts and main.ts import these from here, where they have always lived.
export {
  daemonBase,
  resetDaemonResolutionForTests,
  useOwnDaemon,
  withCallBudget,
  withDaemonWarning,
} from './mcp-client'
export { callerPidFromArgs } from './mcp-self'

/** Daemon-offline usage read for one identified instance, mirroring `/api/usage?instance=N`'s
 *  routing. Codex is the one family that cannot be answered here (its quota is an OpenAI API call
 *  the offline path deliberately does not make), so it says so instead of returning a silent null. */
async function localUsageForInstance(row: ResolvedInstanceRow): Promise<unknown> {
  const { usageAdvice, parseUsageOutput } = await import('./usage')
  if (row.kind === 'codex') {
    const snapshot = parseUsageOutput('', row.name)
    return {
      snapshot,
      cached: false,
      key: row.ref,
      reason: 'check_failed',
      advice: usageAdvice(snapshot),
      daemon: `offline (answered locally) — instance #${row.num} is a Codex instance, whose quota comes from the OpenAI API; start AgentHydra and retry.`,
    }
  }
  const { checkUsageForCliInstance, checkUsageForDesktop } = await import('./usage-service')
  const result =
    row.kind === 'desktop'
      ? await checkUsageForDesktop(row.handle)
      : await checkUsageForCliInstance(row.handle)
  if (!result) {
    const snapshot = parseUsageOutput('', row.name)
    return {
      snapshot,
      cached: false,
      key: row.ref,
      reason: 'check_failed',
      advice: usageAdvice(snapshot),
      daemon: 'offline (answered locally)',
    }
  }
  return {
    ...result,
    advice: result.advice ?? usageAdvice(result.snapshot),
    daemon: 'offline (answered locally)',
  }
}

/** Usage for a Claude DESKTOP user-data dir that is not a numbered instance. Always answered
 *  in-process: the desktop credential is Electron safeStorage, which the `configDir` REST route
 *  (a CLI `.credentials.json` reader) cannot open. */
async function localUsageForDesktopDir(dir: string): Promise<unknown> {
  const { checkUsageForDesktop } = await import('./usage-service')
  const { usageAdvice } = await import('./usage')
  const result = await checkUsageForDesktop(dir)
  return { ...result, advice: result.advice ?? usageAdvice(result.snapshot) }
}

/** Daemon-offline usage read for a bare CLI credential dir — the plain `~/.claude` login, or an
 *  explicit CLAUDE_CONFIG_DIR. */
async function localUsageForConfigDir(configDir: string): Promise<unknown> {
  const { checkUsage, usageAdvice, isNoData } = await import('./usage')
  const snapshot = await checkUsage({ configDir, account: configDir })
  return {
    snapshot,
    cached: false,
    key: `dir:${configDir}`,
    reason: isNoData(snapshot) ? 'check_failed' : 'ok',
    advice: usageAdvice(snapshot),
    daemon: 'offline (answered locally)',
  }
}

/** `here = instance #5 (5claude · Max 20×) — piero@example.com` — the CONFIRMATION line
 *  `resolveMoveTarget` attaches as `targetNote` (item 4, filed 2026-09-07: the AgentHydra
 *  whoami bug that landed three chats on the wrong account). `instanceLabel` alone names an
 *  account by number and nickname only, which is exactly what read wrong that day - a human
 *  or an agent skimming a nickname does not reliably catch a mis-resolved target the way an
 *  EMAIL address does. No email on record still gets the label alone, never a blank field. */
function targetConfirmation(how: 'here' | 'to', row: ResolvedInstanceRow): string {
  const label = instanceLabel(row) ?? `instance #${row.num}`
  return `${how} = ${label}${row.email ? ` — ${row.email}` : ''}`
}

/** Resolve a move's `to` into the argv migrate_chat wants, plus the note a caller reports.
 *  Shared by move_chat and move_chats so a batch can never resolve a DIFFERENT target than a
 *  single move would for the same input - the two disagreeing about what "here" means is how a
 *  batch would quietly land 13 chats on the wrong account.
 *
 *  This runs, and `targetNote` is fully built, BEFORE either caller posts the orchestrator run
 *  that actually imports anything (move_chat's single migrate_chat call, move_chats' one
 *  migrate_batch call that imports every chat in the batch before doing anything else) - so a
 *  caller that reads `targetNote` off a `dry_run: true` result gets the exact same confirmation
 *  a real move would report, with nothing yet moved. Read it before trusting `to`/`"here"`
 *  resolved to the intended account, not only afterwards in a landed result. */
async function resolveMoveTarget(
  to: unknown,
  callerPid?: number | null,
): Promise<{ toRef: string; targetNote: string | undefined }> {
  const toArg = to == null || str(to).trim() === '' ? 'here' : str(to).trim()
  if (toArg.toLowerCase() === 'here') {
    // "here" bills THIS process's account, so it is accepted only on a proven identity: an
    // assumed or disambiguated answer would make the wrong account the destination. Over HTTP
    // it must be the CALLER's identity (as whoami resolves it), never the daemon's own - which
    // is always unidentified and refused every "here" move until 2026-09-22.
    const self = await selfIdentity(false, callerPid)
    if (!self.instance || self.confidence !== 'exact' || self.warning)
      throw new Error(
        `cannot resolve "here" with certainty (${self.summary}${self.warning ? ` — ${self.warning}` : ''}). Pass \`to\` as the target's instance number (list_instance_numbers).`,
      )
    if (self.instance.kind !== 'desktop')
      throw new Error(
        `"here" is ${instanceLabel(self.instance)}, a ${self.instance.kind} instance; a chat can only land in a Claude DESKTOP instance — pass \`to\` explicitly.`,
      )
    return {
      toRef: String(self.instance.num),
      targetNote: targetConfirmation('here', self.instance),
    }
  }
  if (toArg.toLowerCase() === 'best') return { toRef: 'best', targetNote: undefined } // the orchestrator ranks the fleet itself
  const row = await resolveRef(toArg)
  if (row.kind !== 'desktop')
    throw new Error(
      `${instanceLabel(row)} is a ${row.kind} instance; a chat can only land in a Claude DESKTOP instance.`,
    )
  return { toRef: String(row.num), targetNote: targetConfirmation('to', row) }
}

/** What a CliMayte dispatch answers about its pings (docs/CLIMAYTE.md "Pings to the dispatching
 *  chat"). `route`: the route's own answer (absent when this daemon predates pings). */
function climaytePingLine(
  caller: { origin: CallerChatOrigin | null; why: string | null },
  route: unknown,
  group: string,
): string {
  const off = (why: string) =>
    `off: ${why}; run python ~/.claude/tools/climayte_wait.py --group ${group}`
  if (!caller.origin) return off(caller.why ?? 'the calling chat could not be identified')
  const r = route as { on?: boolean; why?: string; to?: string } | null | undefined
  if (!r || typeof r.on !== 'boolean') return off('this AgentHydra daemon does not send pings yet')
  if (!r.on) return off(r.why ?? 'pings are off')
  if (r.to) return `on: manager ${r.to} is sent a message when work settles`
  return `on: ${caller.origin.sessionId.slice(0, 8)} is messaged when work settles (${caller.origin.how})`
}

/** The label of the process that called this tool (its script, else its program), for a dispatch whose
 *  caller is no chat: the HTTP caller's pid, or this stdio server's parents. Null when it cannot be read. */
async function mcpProcessLabel(a: Record<string, unknown>): Promise<string | null> {
  const pid = await callerPidFromArgs(a)
  if (pid === null) return null
  if (pid === undefined) return processLabel(process.pid, false)
  if (pid === process.pid) return 'AgentHydra'
  return processLabel(pid, true)
}

/** The calling chat for a dispatch (its ping origin), unless the caller opted out with `notify: false`, and
 *  the `by` the route records as the trace. The route's own socket is this daemon, so it cannot see the
 *  caller: whenever the origin it is sent is null, the trace goes in `by` (the chat found here, else the
 *  process, else the label the caller declared). A malformed `by` is refused here, as the route would. */
async function dispatchOrigin(
  a: Record<string, unknown>,
): Promise<{ origin: CallerChatOrigin | null; why: string | null; by: CliMayteBy | undefined }> {
  const declared = parseBy(a.by)
  if (declared.why) throw new Error(declared.why)
  const caller = await callerOrigin(a)
  const origin = a.notify === false ? null : caller.origin
  const why = a.notify === false ? 'notify: false' : caller.why
  if (origin && !declared.by) return { origin, why: null, by: undefined }
  const trace = await buildTrace({
    chatSessionId: caller.origin?.sessionId,
    by: declared.by,
    process: () => mcpProcessLabel(a),
  })
  return {
    origin,
    why: origin ? null : why,
    by: { label: trace.label ?? 'a chat', sessionId: trace.sessionId },
  }
}

/** climayte_status's ping extras: `ping: true` adopts the group's live workers without an origin
 *  for the caller; pings no channel delivered to the caller are shown (and marked read). Null when
 *  there is nothing to add. Never throws: a status read must not fail on its extras. */
async function climayteStatusPings(
  a: Record<string, unknown>,
  group: string | undefined,
): Promise<Record<string, unknown> | null> {
  const extra: Record<string, unknown> = {}
  let caller: { origin: CallerChatOrigin | null; why: string | null } | null = null
  if (a.ping === true) {
    if (!group) extra.ping = 'off: ping: true needs a group'
    else {
      caller = await callerOrigin(a)
      try {
        const r = caller.origin
          ? ((await api('/api/corch/adopt', {
              method: 'POST',
              headers: JSON_HEADERS,
              body: JSON.stringify({ group, origin: caller.origin }),
            })) as { adopted?: number; ping?: unknown })
          : null
        if (r) extra.adopted = r.adopted ?? 0
        extra.ping = climaytePingLine(caller, r?.ping, group)
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        extra.ping = climaytePingLine({ origin: null, why }, null, group)
      }
    }
  }
  try {
    const { unread } = (await api('/api/corch/pings')) as { unread?: string[] }
    if (Array.isArray(unread) && unread.length) {
      caller ??= await callerOrigin(a)
      const sid = caller.origin?.sessionId
      if (sid && unread.includes(sid))
        extra.unreadPings = await api('/api/corch/pings/read', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ sessionId: sid }),
        })
    }
  } catch {
    // a daemon without the pings route: nothing unread to show
  }
  return Object.keys(extra).length ? extra : null
}

/** The longest a scoped status read or a cancel holds its answer, past the answer itself, for markSeen. The trace
 *  starts with the call and keeps its own CALLER_ORIGIN_BUDGET_MS: a slower one stamps after the answer has gone.
 *  A 3 s budget for the trace itself missed on the first read after a daemon restart (2026-10-13, at 99% CPU). */
const SEEN_WAIT_MS = 3_000

/** Wait for `p` at most `ms`; it goes on either way. */
async function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([p, new Promise((r) => (timer = setTimeout(r, ms)))])
  clearTimeout(timer)
}

/** Tell the daemon the calling chat has looked at `scope` as of `at` (a scoped climayte_status read, or its own
 *  climayte_cancel), so the pings queued about those workers before then are left out (climayte-ping.ts stale).
 *  Never throws: a read or a cancel must not fail on its stamp; without one the ping goes as before. */
async function markSeen(
  trace: Promise<{ origin: CallerChatOrigin | null }>,
  scope: { ids?: string[]; group?: string },
  at: number,
): Promise<void> {
  try {
    const { origin } = await trace
    if (!origin || (!scope.group && !scope.ids?.length)) return
    await api('/api/corch/seen', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ sessionId: origin.sessionId, ...scope, at }),
    })
  } catch {
    // a daemon without the seen route, or a stamp that failed: the ping goes as it would have
  }
}

/** What a climayte_status call looked at, for markSeen: its ids, else its group. Nothing for an unscoped list
 *  or `active` (finished workers it did not show). */
function statusScope(
  a: Record<string, unknown>,
  group: string | undefined,
): { ids?: string[]; group?: string } | null {
  if (a.active === true) return null
  const ids = [
    ...(a.id != null && str(a.id) ? [str(a.id)] : []),
    ...(Array.isArray(a.ids)
      ? a.ids.filter((x): x is string => typeof x === 'string' && x !== '')
      : []),
  ]
  if (ids.length) return { ids }
  return group ? { group } : null
}

/** climayte_status's own answer: one worker, a wave, or the list in scope. `waitCap`: the most it may
 *  watch, what the call has left of CLIMAYTE_MAX_WAIT_S. */
async function climayteStatusRead(
  a: Record<string, unknown>,
  group: string | undefined,
  waitCap: number,
  seenBy?: string,
): Promise<unknown> {
  const wait = Math.min(waitCap, Math.max(0, Number(a.wait_seconds) || 0))
  const ids = Array.isArray(a.ids) ? a.ids.map((x) => str(x)).filter(Boolean) : []
  if (a.wave != null && str(a.wave)) {
    const w = str(a.wave)
    const wave = (await api(`/api/corch/waves/${encodeURIComponent(w)}`)) as { group?: string }
    const part = (group: string) =>
      api(`/api/corch/workers${qs({ group, brief: 1, all: a.all === true ? 1 : undefined })}`)
    const [manager, tasks] = await Promise.all([part(`mgr-${w}`), part(wave?.group ?? '')])
    return [...(manager as unknown[]), ...(tasks as unknown[])]
  }
  if (a.id != null && str(a.id) && a.report !== true)
    return api(
      `/api/corch/workers/${encodeURIComponent(str(a.id))}${qs({ wait: wait > 0 ? wait : undefined, seen_by: seenBy })}`,
    )
  const limit =
    a.limit != null && Number.isFinite(Number(a.limit))
      ? Math.max(0, Math.floor(Number(a.limit)))
      : group
        ? undefined
        : RECENT_FINISHED
  const report = a.report === true
  const chars = Number(a.chars)
  return api(
    `/api/corch/workers${qs({
      group,
      id: report && a.id != null && str(a.id) ? str(a.id) : undefined,
      ids: ids.length ? ids.join(',') : undefined,
      active: a.active === true ? 1 : undefined,
      limit: ids.length ? undefined : limit,
      brief: report ? undefined : 1,
      all: a.all === true ? 1 : undefined,
      report: report ? 1 : undefined,
      chars: report && Number.isFinite(chars) && chars >= 0 ? Math.floor(chars) : undefined,
      wait: wait > 0 ? wait : undefined,
      seen_by: seenBy,
    })}`,
  )
}

export const TOOLS: HydraTool[] = [
  // --- sessions (read-only), analytics, queue, incidents, live agent status: mcp-session-tools.ts
  ...SESSION_TOOLS,

  // --- accounts -----------------------------------------------------------------
  // NO list_accounts TOOL, deliberately (owner ask 2026-09-04: keep one of each duplicated pair).
  // It listed the old pasted-credentials table, and its own description ended "This is NOT the
  // primary account list ... use list_instances / list_cli_instances for those" — a tool whose
  // text tells an agent not to use it is a duplicate that still costs a slot and still gets
  // called. Signed-in accounts live on instances: list_instance_numbers for the whole fleet,
  // list_instances / list_cli_instances / list_codex_instances per kind. The ROUTE stays
  // (GET /api/accounts, queue.ts) — Settings still renders the rare leftover credential there.

  // --- scheduler ------------------------------------------------------------------
  {
    name: 'get_scheduler',
    description:
      'Get the scheduler state: enabled, running/queued counts, spacing/poll seconds, max_concurrent.',
    inputSchema: S(),
    run: () => api('/api/scheduler'),
  },
  {
    name: 'set_scheduler',
    description:
      'MUTATES: update scheduler settings (any subset of enabled, spacing_seconds, poll_seconds, max_concurrent). Enabling it starts no run: each tick takes the next queued item and marks it failed under the no-headless policy, so leave it off.',
    inputSchema: S({
      enabled: { type: 'boolean' },
      spacing_seconds: { type: 'number' },
      poll_seconds: { type: 'number' },
      max_concurrent: { type: 'number' },
    }),
    run: (a) =>
      api('/api/scheduler', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(a),
      }),
  },

  // --- instance numbers ----------------------------------------------------------
  // START HERE for anything about "which account". Every instance — Claude Desktop, Claude CLI,
  // Codex — carries a permanent number in ONE shared sequence, and that number is the only
  // identifier that is short, stable and safe to write into a prompt. The alternatives are a
  // Windows folder path and a random uuid.
  {
    name: 'list_instance_numbers',
    description:
      'Lists the instance directory: every Claude Desktop, Claude CLI and Codex instance in one flat list, each with its permanent number, kind, signed-in account email, plan, login state, and the dir or id the per-kind tools take. Numbers are unique across the three kinds and never reused, so 7 means the same account tomorrow. Call it first whenever a person names an instance or you need to pick an account. Free accounts (claude.ai and chatgpt.com free logins) are not instances and are numbered apart; free_status lists them.',
    inputSchema: S(),
    run: () => api('/api/instance-numbers'),
  },
  {
    name: 'resolve_instance',
    description:
      "Turn any reference to an instance — a number (7, '#7'), a dir, an id, a 'desktop:<dir>'/'cli:<id>' ref, or an unambiguous name — into the one instance it means, with its account email and plan. Use this to CONFIRM which account you are about to touch before a mutating or quota-spending action. Errors distinguish an unknown number from a retired one (its instance was deleted; numbers are never recycled).",
    inputSchema: S({ instance: INSTANCE_PARAM }, ['instance']),
    run: (a) => resolveRef(a.instance),
  },
  {
    name: 'whoami',
    listed: true,
    description:
      "Says which AgentHydra instance this process runs as: its permanent number, kind, account email, plan and rate-limit tier. Read confidence first: 'exact' means a signal named the credential store, so the number may be quoted; 'assumed' means the default login was chosen by elimination, so hedge it. clues holds the evidence and ruledOut what was checked. Do not identify yourself from your transcript's location or ~/.claude.json; both point at the wrong account. A number a human gives you overrides this. Read-only.",
    inputSchema: S({
      fresh: {
        type: 'boolean',
        description:
          'Re-run the detection instead of reusing this process’s cached answer. Rarely needed — an identity cannot change while a process lives.',
      },
    }),
    run: async (a) => {
      const self = await selfIdentity(a.fresh === true, await callerPidFromArgs(a))
      return {
        ...self,
        note: self.instance
          ? undefined
          : self.confidence === 'exact'
            ? 'Identified a credential directory that belongs to no managed instance, so there is no number to quote. check_my_usage still reads the right account.'
            : 'This process is not running as a managed instance — check_my_usage will report the default login, and will say so.',
        nextStep:
          self.confidence === 'exact'
            ? `Use ${instanceLabel(self.instance) ?? 'this account'} whenever you report quota, and call check_my_usage {} before any heavy or long work.`
            : 'Identification is NOT settled, so do not name an account. Ask the human which instance you are (their answer overrules this detection), and treat any quota reading as unattributed until they say.',
      }
    },
  },

  // --- multi-instance (isolated Claude Desktop instances) ------------------------
  {
    name: 'list_instances',
    description:
      'List isolated Claude Desktop instances with their live status and resolved account. Each row carries its permanent instance `num` — prefer that over `dir` when referring to one. For the whole fleet (Desktop + CLI + Codex) in one numbered list, use list_instance_numbers.',
    inputSchema: S(),
    run: () => api('/api/instances'),
  },
  {
    name: 'launch_instance',
    description:
      'MUTATES: open (launch) a Claude Desktop instance, by its number (`instance`) or its directory.',
    inputSchema: S({ instance: INSTANCE_PARAM, dir: { type: 'string' } }),
    run: async (a) =>
      api(`/api/instances/${encodeURIComponent(await handleFrom(a.dir, a.instance, 'dir'))}/open`, {
        method: 'POST',
      }),
  },
  {
    name: 'quit_instance',
    description:
      'MUTATES: quit a running Claude Desktop instance, by its number (`instance`) or its directory.',
    inputSchema: S({ instance: INSTANCE_PARAM, dir: { type: 'string' } }),
    run: async (a) =>
      api(`/api/instances/${encodeURIComponent(await handleFrom(a.dir, a.instance, 'dir'))}/quit`, {
        method: 'POST',
      }),
  },

  // --- usage-check subsystem (Feature B) ----------------------------------------
  {
    name: 'check_usage',
    description:
      "Reads one account's remaining Claude subscription quota: the session (5-hour) percentage, the weekly all-models percentage, any per-model weekly percentage, and an advice verdict (severity, shouldOffload, safeToFanOut). The weekly all-models percentage is the binding cap for pacing multi-agent work. A fresh 5-hour percentage misleads while weekly is near 100, and switching to a flagship model does not escape the all-models weekly bucket. Normally pass instance, the permanent number a person quotes; it works for Claude Desktop, CLI and Codex instances and echoes which account answered. account (a saved dispatch account) and configDir (a CLAUDE_CONFIG_DIR that was logged in once) remain for the two older credential stores. With none of the three it reads this process's own config, though check_my_usage is better for that. Read-only.",
    inputSchema: S({
      instance: INSTANCE_PARAM,
      account: { type: 'string', description: 'A saved dispatch account id or label.' },
      configDir: {
        type: 'string',
        description: 'A CLAUDE_CONFIG_DIR that has been logged in once via `claude` → /login.',
      },
    }),
    run: async (a) => {
      const instance = a.instance != null ? str(a.instance).trim() : ''
      if (instance) return withNextStep(await api(`/api/usage${qs({ instance, refresh: '1' })}`))
      const account = a.account != null ? str(a.account) : ''
      const configDir =
        a.configDir != null ? str(a.configDir) : (process.env.CLAUDE_CONFIG_DIR ?? '')
      if (!account && !configDir)
        throw new Error(
          'pass `instance` (its number — see list_instance_numbers), `account`, or `configDir` (or use check_my_usage, which works out which account THIS process bills to on its own)',
        )
      return withNextStep(
        await api(
          `/api/usage${qs({ account: account || undefined, configDir: configDir || undefined, refresh: '1' })}`,
        ),
      )
    },
  },
  {
    name: 'check_my_usage',
    listed: true,
    description:
      "Reads this session's own remaining Claude quota in about 300 ms: the 5-hour (session) and weekly percentages, an advice verdict, and identity, which says which instance and plan those numbers belong to. Call it before long or heavy work and before a fan-out. If advice.shouldOffload is true, save your working context, findings and next steps to a file before you go on. If advice.safeToFanOut is false, shrink or postpone the fan-out: judge current and projected cost, because a launched fan-out cannot be recalled. dollars gives what is left in list-price dollars once usage_budget has calibrated it. If identity.warning is present, say whose the numbers are instead of quoting a bare percentage. Read-only.",
    inputSchema: S(),
    run: async (a) => {
      const self = await selfIdentity(false, await callerPidFromArgs(a))

      // Prefer the INSTANCE route. It matters: a desktop instance's credential lives in Electron
      // safeStorage, not in a `.credentials.json`, so reading it by configDir alone returns
      // check_failed — which is exactly what a Desktop session used to get back. Routing by number
      // takes the full credential chain (own token → linked CLI login → dispatch account).
      const usage = self.instance
        ? await apiOrLocal(`/api/usage${qs({ instance: self.instance.num, refresh: '1' })}`, () =>
            localUsageForInstance(self.instance as ResolvedInstanceRow),
          )
        : !self.configDir
          ? { snapshot: null, reason: 'check_failed' }
          : self.kind === 'desktop'
            ? // An UNMANAGED desktop user-data dir. Answered in-process rather than through
              // /api/usage?configDir=, which reads a CLI `.credentials.json` a desktop dir does
              // not have — the exact mismatch that made a Desktop session's self-check fail.
              // There is no REST route for an arbitrary desktop dir, and this needs none: the
              // safeStorage token is a local file and the quota endpoint is one HTTPS GET.
              await localUsageForDesktopDir(self.configDir)
            : // The plain `~/.claude` login (or a CLI config dir).
              await apiOrLocal(`/api/usage${qs({ configDir: self.configDir, refresh: '1' })}`, () =>
                localUsageForConfigDir(self.configDir as string),
              )

      // The last dollar calibration for this account (see quota-calibration.ts), re-priced against
      // this reading. A file read, so the self-check stays fast; usage_budget refits it.
      const { storedQuotaDollars } = await import('./quota-calibration')
      const read = usage as { key?: unknown; snapshot?: UsageSnapshot | null }
      const dollars =
        typeof read.key === 'string' ? storedQuotaDollars(read.key, read.snapshot ?? null) : null

      return await withNextStep(
        {
          ...(usage as Record<string, unknown>),
          ...(await climayteRoom()),
          dollars,
          identity: self,
          // Kept at the top level for every existing caller written against the old shape.
          configDir: self.configDir,
          instance: self.instance,
        },
        self,
      )
    },
  },
  {
    name: 'list_usage',
    listed: true,
    description:
      "Survey the quota of EVERY managed instance (desktop + CLI) in one call, each with its permanent instance `num` and its `advice` verdict, plus the DeepSeek account balance HSwarm spends from (`deepseek`) beside them. Use this to answer 'which of my accounts has headroom?' before routing heavy work, or to find the account that is about to hit its weekly cap — then refer to the winner by its number. When every account is saturated, the mechanical/checkable work belongs on HSwarm (`hswarm_run`), not queued behind a Claude account's reset. Checks are concurrent and cost no quota. The Free web accounts are not in it: free_status.",
    inputSchema: S(),
    run: async () => {
      const survey = (await apiOrLocal('/api/usage/survey', async () => {
        const { surveyUsage } = await import('./usage-service')
        const { usageAdvice } = await import('./usage')
        const { deepseekBalance } = await import('./hswarm-cost')
        const [rows, deepseek] = await Promise.all([surveyUsage(), deepseekBalance()])
        return {
          rows: rows.map((r) => ({ ...r, advice: usageAdvice(r.result.snapshot) })),
          deepseek,
          daemon: 'offline (answered locally)',
        }
      })) as Record<string, unknown>
      // Every row saturated (weekly binding % >= 90, and actually read — 'unknown' never counts as
      // saturated, that would be guessing) is the trigger the TODO this landed from names: route
      // mechanical, checkable batch work to HSwarm instead of waiting on a reset.
      const rows = (survey.rows ?? []) as Array<{ advice?: { bindingPct?: number | null } }>
      const allSaturated = rows.length > 0 && rows.every((r) => (r.advice?.bindingPct ?? -1) >= 90)
      return {
        ...survey,
        ...(await climayteRoom()),
        // A survey has no single advice to branch on, so the instruction is about what to DO with
        // a list: pick by the binding cap, and quote the number so the human can check the choice.
        nextStep:
          'Route heavy work to the row with the lowest WEEKLY (all models) %, not the lowest session %, and name it by its `num` when you say where you sent it. A row whose advice.severity is "unknown" was not read successfully; that is not headroom.' +
          (allSaturated
            ? ' EVERY account is at or above 90% weekly: do not fan out to any of them. Mechanical, checkable batch work (find/read/classify/extract-to-schema, not judgment) goes to HSwarm instead - hswarm_run, `deepseek` balance permitting.'
            : ''),
      }
    },
  },
  {
    name: 'usage_budget',
    listed: true,
    description:
      "Turns a usage percentage into planning numbers. With no arguments it measures this session's own account. Its decisive field is forecast.exhaustsBeforeReset: false means the cap will not bite before it resets, so work freely whatever the percentage; true means headroomHours is what you have before the cut-off. budget gives an estimated token headroom, and budget.dollars what each window has left in list-price dollars; compare that with a batch's expected cost before a fan-out. Read budget.caveat and budget.confidence: the token figure counts only Claude Code on this machine, so it is an optimistic upper bound. Pass instance (its permanent number) to measure another account; the answer names the account it measured. Read-only.",
    inputSchema: S({
      instance: INSTANCE_PARAM,
      dir: { type: 'string', description: 'Desktop instance dir (from list_instances).' },
      account: { type: 'string', description: 'A saved dispatch account id or label.' },
      configDir: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Claude config dirs whose transcripts count as this account's spend. Defaults to the plain ~/.claude login (or, when `instance` is a CLI instance, that instance's own config dir).",
      },
    }),
    run: async (a) => {
      const params = new URLSearchParams()
      if (a.instance != null && str(a.instance).trim())
        params.set('instance', str(a.instance).trim())
      if (a.dir != null) params.set('dir', str(a.dir))
      if (a.account != null) params.set('account', str(a.account))
      const dirs = (Array.isArray(a.configDir) ? a.configDir : []).map(str)
      for (const d of dirs) params.append('configDir', d)

      // NO TARGET GIVEN → budget MYSELF. This used to throw, which meant the one caller who most
      // needs a burn rate (an agent deciding whether it can finish) had to know its own instance
      // number first — and a Desktop session had no way to learn it.
      let self: SelfIdentityPayload | null = null
      if (!params.has('instance') && !params.has('dir') && !params.has('account')) {
        self = await selfIdentity()
        if (self.instance) params.set('instance', String(self.instance.num))
        else if (self.kind === 'desktop' && self.configDir) params.set('dir', self.configDir)
        // The plain ~/.claude login: no instance number, no desktop dir. `configDir` is both the
        // credential to read AND the transcripts to count, which is exactly what the budget route's
        // configDir branch does.
        else if (self.configDir) params.append('configDir', self.configDir)
        else
          throw new Error(
            `could not identify which account this process runs as (${self.summary}). Pass \`instance\` (its number — see list_instance_numbers), \`dir\` or \`account\`.`,
          )
      }

      const withSelf = (r: unknown) =>
        withNextStep(self ? { ...(r as Record<string, unknown>), identity: self } : r, self)

      // Read the TARGET back off `params`, not off `a` — self-identification may have filled it in.
      const spendDirs = params.getAll('configDir')
      const dirParam = params.get('dir')

      return withSelf(
        await apiOrLocal(`/api/usage/budget?${params.toString()}`, async () => {
          // Offline path: `instance`, `dir` and `configDir` all work — the number registry, the
          // instance stores and a CLI login's credentials are plain files, readable with the app
          // closed. Only `account` cannot be answered here: it resolves a dispatch account out of
          // the daemon's sqlite, and racing the daemon for that DB is not worth the complexity.
          const { resolveInstance, resolveInstanceError } = await import('./core/instance-ref')
          const hit = params.has('instance') ? await resolveInstance(params.get('instance')) : null
          if (params.has('instance') && !hit)
            throw new Error(await resolveInstanceError(params.get('instance')))
          if (!hit && !dirParam && spendDirs.length === 0)
            throw new Error(
              'the AgentHydra daemon is not running; usage_budget can answer offline for `instance`, `dir` or `configDir` but not for `account`. Start the app, or pass `instance`.',
            )
          if (hit?.kind === 'codex')
            throw new Error(
              `instance #${hit.num} is a Codex instance; its quota comes from the OpenAI API, which this offline path does not call. Start the app and retry.`,
            )
          const { checkUsageForCliInstance, checkUsageForDesktop } = await import('./usage-service')
          const { buildUsageBudget, budgetSummary } = await import('./usage-budget')
          const { checkUsage, isNoData, usageAdvice } = await import('./usage')
          const result =
            hit?.kind === 'cli'
              ? await checkUsageForCliInstance(hit.handle)
              : hit?.kind === 'desktop' || dirParam
                ? await checkUsageForDesktop(hit?.handle ?? (dirParam as string))
                : await (async () => {
                    const cd = spendDirs[0] as string
                    const snapshot = await checkUsage({ configDir: cd, account: cd })
                    return {
                      snapshot,
                      cached: false,
                      key: `dir:${cd}`,
                      reason: isNoData(snapshot) ? ('check_failed' as const) : ('ok' as const),
                    }
                  })()
          if (!result) throw new Error(`instance #${hit?.num} could not be checked`)
          const budget = await buildUsageBudget(result.snapshot, result.key, {
            configDirs: spendDirs.length
              ? spendDirs
              : hit?.kind === 'cli'
                ? [hit.configDir]
                : undefined,
          })
          return {
            snapshot: result.snapshot,
            reason: result.reason,
            advice: usageAdvice(result.snapshot),
            budget,
            summary: budgetSummary(budget, result.snapshot.weekAll?.pct ?? null),
            ...(hit ? { instance: { num: hit.num, kind: hit.kind, name: hit.name } } : {}),
            daemon: 'offline (answered locally)',
          }
        }),
      )
    },
  },

  // --- CLI instances (Feature A) ------------------------------------------------
  {
    name: 'list_cli_instances',
    description:
      'Lists CLI instances (one CLAUDE_CONFIG_DIR per account, logged in once) with their permanent instance number, login state, associated account and last usage snapshot. Read-only.',
    inputSchema: S(),
    run: () => api('/api/cli-instances'),
  },
  {
    name: 'create_cli_instance',
    description:
      "MUTATES: creates a new CLI instance by making its CLAUDE_CONFIG_DIR folder, with loggedIn false. Signing it in is the owner's step; an AI must never run /login.",
    inputSchema: S({ name: { type: 'string' } }, ['name']),
    run: (a) =>
      api('/api/cli-instances', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: str(a.name) }),
      }),
  },
  {
    name: 'cli_limit_reset',
    description:
      "MUTATES: use a Claude CLI account's limit reset, through the CLI's own `/limit-reset` run in a hidden terminal. Spends it: a banked reset grant refills the limits (its count goes down), the once-a-week session reset refills the 5-hour limit and still counts toward the weekly one. Only on the owner's word. Returns the CLI's own answer: outcome reset | used (this week's is spent; `nextAvailable` says when) | unavailable (none offered to this account now) | error. A check (`check: true`) is safe while the account is below its 5-hour limit: it backs out of a banked reset's question, and the weekly session reset is only offered at the 5-hour limit. AgentHydra checks each signed-in CLI account daily, so its row already shows the answer. Takes up to about a minute. Identify the instance by number (`instance`) or by `id`.",
    inputSchema: S({
      instance: INSTANCE_PARAM,
      id: { type: 'string' },
      check: {
        type: 'boolean',
        description:
          "Check only: at a banked reset's 'Use your reset?' question, back out and report outcome 'available'. Safe while the account is below its 5-hour limit; the weekly session reset is only offered at that limit, where it asks nothing and a check could use it.",
      },
    }),
    run: async (a) =>
      api(
        `/api/cli-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/limit-reset`,
        {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ check: a.check === true }),
        },
      ),
  },
  {
    name: 'launch_cli_instance',
    description:
      'MUTATES: opens a terminal running this CLI instance with its CLAUDE_CONFIG_DIR set, optionally with a model and effort. Identify the instance by number (instance) or by id.',
    inputSchema: S({
      instance: INSTANCE_PARAM,
      id: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
    }),
    run: async (a) =>
      api(
        `/api/cli-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/launch`,
        {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ model: a.model, effort: a.effort }),
        },
      ),
  },
  {
    name: 'cli_instance_login_helper',
    description:
      'MUTATES: open a terminal for the USER to run /login and sign this CLI instance in. The daemon never performs the login itself. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/cli-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/login`,
        { method: 'POST' },
      ),
  },
  {
    name: 'link_cli_instance_to_desktop',
    description:
      "MUTATES: link a CLI instance to a DESKTOP instance (they are normally the same Anthropic account with two separate logins). Linking groups them in the UI and lets each act as the other's usage-check fallback when one's token is expired. Both sides accept an instance NUMBER: `instance` for the CLI side, `desktop` for the desktop side. Pass desktopDir/desktop: null to unlink.",
    inputSchema: S({
      instance: INSTANCE_PARAM,
      id: { type: 'string', description: 'CLI instance id.' },
      desktop: {
        type: ['string', 'number', 'null'],
        description: "The desktop instance's number (or dir/name), or null to unlink.",
      },
      desktopDir: {
        type: ['string', 'null'],
        description: 'Desktop instance dir (from list_instances), or null to unlink.',
      },
    }),
    run: async (a) => {
      const id = await handleFrom(a.id, a.instance, 'id')
      // null is a meaningful VALUE here (unlink), so it must survive the resolve step untouched —
      // only a non-null `desktop` is looked up.
      const explicitNull = a.desktop === null || a.desktopDir === null
      const desktopDir = explicitNull
        ? null
        : a.desktop != null && str(a.desktop).trim()
          ? (await resolveRef(a.desktop)).handle
          : (a.desktopDir ?? null)
      return api(`/api/cli-instances/${encodeURIComponent(id)}/link-desktop`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ desktopDir }),
      })
    },
  },

  // --- CliMayte: delegate work onto the CLI accounts (docs/CLIMAYTE.md) ---------------
  // Over /api/corch like every other tool: the workers belong to the daemon, and a stdio MCP server
  // running CliMayte in its own process would relaunch them as dead and could not cancel them.
  {
    name: 'climayte_run',
    listed: true,
    description:
      "MUTATES: starts Claude Code workers that run self-contained tasks on the owner's CLI accounts, and returns the group with each worker's id, status, account and expected size. Use it when the owner asks to delegate a task, or for work that needs Claude quality HSwarm cannot deliver. This chat keeps the orchestration (split, dispatch, read results, check them); the work goes here. Each task is {prompt, cwd, title?, check?, commit?}; give `commit: false` to a builder whose changes you land yourself, so a passing check is its pass and it is never sent back to commit. A worker sees nothing of this chat, so its prompt must name the folder, say what done means, and say what proof to report. A task that would use more than half the biggest window it may use starts nothing and returns 'split needed' with the number of pieces; send those as separate tasks, or size: whole to run it as it is. AgentHydra picks the account, spreads the load, and moves a worker to another account by itself when its account hits a usage limit. Workers are visible and steerable in the CliMayte view. Then read them with climayte_status { group, wait_seconds }.",
    inputSchema: S(
      {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string' },
              cwd: { type: 'string' },
              title: { type: 'string' },
              model: {
                type: 'string',
                description:
                  "Leave it out (or `auto`): CliMayte picks model AND effort for the task's `kind` from the scorecard, the setting that passes that kind reliably for the least quota per passed task (Haiku 5.5 medium up to Opus 5.5 max; every kind tries Haiku 5.5 first while it is still learning, every 4th pick tries another cheaper setting still learning, every 2nd while the kind's pick is Opus). Haiku 4.5 is refused. Leave `model` out. A `modelWhy` holds only a setting CHEAPER than the kind's pick; a setting at or above it is held only with `ownerWords`, otherwise it is left to the scorecard. A `sealed` task holds whatever it names. A task that fails on a cheap setting is usually too big: split it and send the parts on auto.",
              },
              effort: {
                type: 'string',
                description:
                  "Thinking level: low, medium, high, xhigh or max (how hard the model thinks on every turn). Leave it out; held like `model`: only a setting cheaper than the kind's pick with `modelWhy`, or any with `ownerWords`.",
              },
              modelWhy: {
                type: 'string',
                description:
                  'Why this task needs a `model`/`effort` CHEAPER than the scorecard pick for its kind, in a few words (e.g. "a one-line rename, Haiku is enough"). It cannot hold a setting at or above the pick: that needs `ownerWords`, else the named setting is ignored and the scorecard picks.',
              },
              ownerWords: {
                type: 'string',
                description:
                  "The owner's OWN words, in the chat you serve, asking for this model or effort, quoted (at most 2000 characters; refused if longer). Holds the named setting whatever its rung. Never your own reasoning or a paraphrase: without the owner's request, leave it out.",
              },
              kind: {
                type: 'string',
                description:
                  'What kind of work it is, so the scorecard learns per kind: code, debug, review, sweep (read-only survey or capture), mechanical (an edit a script can check), docs or trivial.',
              },
              priority: {
                type: 'number',
                description:
                  'Whole number, default 0 (or the top-level `priority`): queued and waiting tasks start highest first, then oldest first, so an urgent task takes the next free slot. Change it later with climayte_priority.',
              },
              check: {
                type: 'string',
                description:
                  'One bash command that PROVES the task is done (exit 0), e.g. `bun test tests/x.test.ts` or a curl that greps the deployed page; run it through `~/.claude/tools/fairjob.cmd -Weight 3 -Run "..."` when it is heavy. CliMayte runs it in `cwd` the moment the worker reports done (status `checking`), records the verdict itself, and sends a fail back to the same session one rung up with the end of the command\'s output (3 failed rounds stop the task as failed). Give one whenever a command can tell; your own climayte_verdict is for what it cannot.',
              },
              commit: {
                type: 'boolean',
                description:
                  'Whether the worker commits its own changes. `false` for a builder whose changes you land yourself: its passing `check` is a pass on its own, it is never sent back to commit, and its brief tells it not to commit, add or push. `true` holds it to a commit whatever its prompt says. Left out, a passing check also needs the changed files committed, unless the prompt or a brief file it names says not to commit (e.g. "Do NOT run git commit").',
              },
              light: {
                type: 'boolean',
                description:
                  'true for a worker that only reads and edits files (a builder that runs no build or test): it has no shell and no MCP server but climayte_ask, and it starts at once on a busy machine instead of waiting for the CPU. Its `check`, if any, is still run by CliMayte after it reports.',
              },
              role: {
                type: 'string',
                enum: ['seat'],
                description:
                  "'seat' for a worker that carries a persona (`persona`): it is dispatched like any other. Omit it for an ordinary task, which is a drone: a drone never starts workers, so its climayte_run, climayte_manage and fan_out are refused.",
              },
              persona: {
                type: 'string',
                description:
                  "With role 'seat': the id of a catalog entry (the hydra-core catalog) for the persona the worker carries.",
              },
              size: {
                type: 'string',
                description:
                  '`auto` (default): refused with `split needed` when it is expected to use more than half of the biggest window it may use. `whole`: run it as it is anyway.',
              },
              chat: {
                type: 'boolean',
                description:
                  "Default false. true only for one of the OWNER'S OWN interactive chats run headless (a chat front end sends each later message with climayte_send): it launches like his own `claude` in that folder, with no worker brief, his full CLAUDE.md, skills, MCP servers and connectors, and Opus xhigh unless the task names its own (no modelWhy needed; the scorecard never picks for it). Never for a delegated task: the workers a chat dispatches are ordinary.",
              },
              desk: {
                type: 'object',
                description:
                  "Only with `chat: true`, from a Desk chat: `{append, mcpServers}`, the Desk's appended system text (at most 20,000 characters, refused if longer) and its connector MCP servers. Kept on the worker, so every continuation and account move launches with them; the owner's own servers of the same name win.",
              },
              sealed: {
                type: 'object',
                description:
                  'Launch this task sealed: the CLI gets `systemPromptFile` in place of its own system prompt and ONLY the MCP servers in `mcpConfig`; no built-in tool, no CLAUDE.md, hook, skill or owner MCP server, no worker brief, and an empty temp folder as its folder (`cwd` is not read). For a worker that needs one prompt and one MCP server, such as a simulated visitor: an ordinary worker carries about 38,000 tokens before its first move. Its report is its final text. The `model`/`effort` it names is held at any rung (it is a measurement, never a scorecard trial), and with no `kind` it feeds no scorecard row. Account choice, usage stops, pings, verdicts and status are as for any worker. Refused when a file is missing or `allowedTools` is empty.',
                properties: {
                  systemPromptFile: { type: 'string', description: 'Absolute path.' },
                  mcpConfig: {
                    type: 'string',
                    description: 'Absolute path to a JSON file with an `mcpServers` object.',
                  },
                  allowedTools: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'The tools it may call, e.g. ["mcp__sue-hands__*"].',
                  },
                  prompt: {
                    type: 'string',
                    description: 'The first message, when the task `prompt` is empty.',
                  },
                },
                required: ['systemPromptFile', 'mcpConfig', 'allowedTools'],
              },
            },
            required: ['prompt', 'cwd'],
          },
        },
        group: { type: 'string' },
        accounts: {
          type: 'array',
          items: INSTANCE_PARAM,
          description:
            'CLI instances to use: numbers (7, "#7") or ids. Omit for every signed-in one.',
        },
        per_account: { type: 'number' },
        per_account_strict: {
          type: 'boolean',
          description:
            'Make per_account a hard cap: the group waits rather than go past it. Default false: per_account spills to an account with room when no account within it takes the task.',
        },
        model: {
          type: 'string',
          description:
            "Default model for every task without its own: leave it out (auto, the scorecard picks). A named one is held only when cheaper than the kind's pick with `modelWhy`, or with `ownerWords`.",
        },
        effort: {
          type: 'string',
          description:
            'Default thinking level for every task without its own: low, medium, high, xhigh or max. Leave it out; held like `model` (see the task `modelWhy` and `ownerWords`).',
        },
        modelWhy: {
          type: 'string',
          description:
            "Why every task without its own needs the `model`/`effort` named here: holds only a setting cheaper than the kind's pick (see the task `modelWhy`).",
        },
        ownerWords: {
          type: 'string',
          description:
            "The owner's own words asking for the `model`/`effort` named here, for every task that names no model or effort of its own (see the task `ownerWords`).",
        },
        kind: {
          type: 'string',
          description: 'Default kind for every task without its own (see the task `kind`).',
        },
        priority: {
          type: 'number',
          description: 'Default priority for every task without its own (see the task `priority`).',
        },
        size: {
          type: 'string',
          description:
            'Default size for every task without its own: auto or whole (see the task `size`).',
        },
        notify: {
          type: 'boolean',
          description:
            'Default true: this chat is messaged when the work settles (finished, failed, needs a verdict, a group done; a worker limited and moved rides along). false: no messages; poll with climayte_status.',
        },
        by: {
          type: 'object',
          description:
            'Optional: who you are, for the From column of the CliMayte list. {label} names you (up to 80 characters, e.g. "CreAItor"); {label, sessionId} also names the chat you run under, for the From column only. Never pinged. Without it the From is your chat, else the script or program that called this tool.',
          properties: {
            label: { type: 'string' },
            sessionId: { type: 'string' },
          },
          required: ['label'],
        },
        copies: {
          type: 'boolean',
          description:
            'A task this `group` was already sent in the last 10 minutes (same title, prompt and cwd, not cancelled or failed) answers with the worker it made, marked `repeat: true`, and starts nothing. `copies: true` makes new workers anyway.',
        },
      },
      ['tasks'],
    ),
    run: async (a) => {
      const accounts = Array.isArray(a.accounts)
        ? await Promise.all(
            a.accounts.map(async (ref) => {
              const row = await resolveRef(ref)
              if (row.kind !== 'cli')
                throw new Error(
                  `${instanceLabel(row)} is a ${row.kind} instance; CliMayte runs only on CLI instances.`,
                )
              return row.handle
            }),
          )
        : undefined
      // The origin is only ever the caller the route bound: an `origin` in the client's own
      // arguments is never read (callerOrigin).
      const caller = await dispatchOrigin(a)
      const r = (await api('/api/corch/workers', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          // null: no origin on purpose (notify false, or no traceable caller), so nothing is pinged.
          origin: caller.origin,
          // Who dispatched it, always (climayte-trace.ts): the route cannot see this caller itself.
          by: caller.by,
          tasks: Array.isArray(a.tasks) ? a.tasks : [],
          group: a.group != null ? str(a.group) : undefined,
          accounts,
          perAccount: a.per_account != null ? Number(a.per_account) : undefined,
          perAccountStrict:
            typeof a.per_account_strict === 'boolean' ? a.per_account_strict : undefined,
          model: a.model != null ? str(a.model) : undefined,
          effort: a.effort != null ? str(a.effort) : undefined,
          modelWhy: a.modelWhy != null ? str(a.modelWhy) : undefined,
          ownerWords: a.ownerWords != null ? str(a.ownerWords) : undefined,
          kind: a.kind != null ? str(a.kind) : undefined,
          priority: a.priority != null ? Number(a.priority) : undefined,
          size: a.size != null ? str(a.size) : undefined,
          copies: a.copies === true,
        }),
      })) as {
        group?: string
        workers?: Array<Record<string, unknown>>
        repeated?: number
        note?: string
        ping?: unknown
      }
      // Field note 7 (2026-09-30): the whole view per worker echoed 300 characters of every prompt
      // the orchestrator had just written, about 3k characters per five-task dispatch.
      if (!Array.isArray(r?.workers)) return r
      return {
        group: r.group,
        workers: r.workers.map((w) => ({
          id: w.id,
          title: w.title,
          status: w.status,
          account: w.account,
          ...(w.auto ? { model: w.model, effort: w.effort } : {}),
          size: w.size,
          ...(w.repeat ? { repeat: true } : {}),
        })),
        ...(r.repeated ? { repeated: r.repeated, note: r.note } : {}),
        ping: climaytePingLine(caller, r.ping, r.group ?? str(a.group)),
      }
    },
  },
  {
    name: 'climayte_manage',
    listed: true,
    description:
      "MUTATES: hand a big job to a CliMayte MANAGER (the CLIManager): you write the plan to a file and give the task list; the manager dispatches the workers, waits, has the daemon judge each one by command (its check, its commits on the branch, its diff inside the brief's paths), re-dispatches, and wakes you ONCE with a short report. Choose it from about 5 workers or several rounds (`after` orders them); small jobs (under 3 tasks is refused) use climayte_run. Each task: { key, prompt, kind, title?, check?, paths (globs the diff may touch; [] = must not commit), after? (keys that must pass first) }; no task may be kind `manage`. `verify` is the command you run on the merged result. The answer carries `wave`, `managerId` and `waiter`: run that waiter command (it waits on the manager alone), read its report, run `verify`, then call climayte_wave_verify. A wave's passes stay provisional and out of the scorecard until you verify it.",
    inputSchema: S(
      {
        plan: { type: 'string', description: 'Absolute path of the plan file.' },
        cwd: { type: 'string', description: 'The repository the wave works in.' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'A stable name from the plan.' },
              prompt: { type: 'string' },
              kind: { type: 'string' },
              title: { type: 'string' },
              check: { type: 'string', description: 'A command that proves it is done.' },
              paths: { type: 'array', items: { type: 'string' } },
              after: { type: 'array', items: { type: 'string' } },
            },
            required: ['key', 'prompt', 'kind', 'paths'],
          },
        },
        verify: { type: 'string' },
        branch: { type: 'string', description: "Default: cwd's current branch." },
        max_rounds: { type: 'number', description: 'Re-dispatches per key (default 3).' },
        notify: {
          type: 'boolean',
          description:
            'Default true: this chat is messaged when the manager settles. false: no messages.',
        },
      },
      ['plan', 'cwd', 'tasks'],
    ),
    run: async (a) => {
      const caller = await dispatchOrigin(a)
      const r = (await api('/api/corch/waves', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          // null: no origin on purpose (notify false, or no traceable caller), so nothing is pinged.
          origin: caller.origin,
          by: caller.by,
          plan: a.plan != null ? str(a.plan) : undefined,
          cwd: a.cwd != null ? str(a.cwd) : undefined,
          tasks: Array.isArray(a.tasks) ? a.tasks : [],
          verify: a.verify != null ? str(a.verify) : undefined,
          branch: a.branch != null ? str(a.branch) : undefined,
          max_rounds: a.max_rounds != null ? Number(a.max_rounds) : undefined,
        }),
      })) as { wave?: string; ping?: unknown } & Record<string, unknown>
      if (!r || typeof r.wave !== 'string') return r
      return { ...r, ping: climaytePingLine(caller, r.ping, `mgr-${r.wave}`) }
    },
  },
  {
    name: 'climayte_wave_resolve',
    description:
      'MUTATES: settle one ESCALATED or FAILED key of a wave (climayte_manage) that the daemon could not: ok: true makes it passed (it counts for `after` and the manager hears it in its next batch), ok: false makes it failed. climayte_verdict on the worker of that key does the same. Refused for a key in any other state.',
    inputSchema: S(
      {
        wave: { type: 'string' },
        key: { type: 'string' },
        ok: { type: 'boolean' },
        note: { type: 'string' },
      },
      ['wave', 'key', 'ok'],
    ),
    run: (a) =>
      api(
        `/api/corch/waves/${encodeURIComponent(str(a.wave))}/tasks/${encodeURIComponent(str(a.key))}/resolve`,
        {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            ok: a.ok === true,
            note: a.note != null ? str(a.note) : undefined,
          }),
        },
      ),
  },
  {
    name: 'climayte_wave_verify',
    description:
      'MUTATES: your one verification of a REPORTED wave (climayte_manage), after you ran its `verify` command on the branch head. ok: true confirms every provisional pass so it counts in the scorecard, and records a pass on the manager. ok: false confirms none and fails the manager with `note` (nothing is sent back; record your own fails on the tasks you blame with climayte_verdict). Refused unless the wave is reported.',
    inputSchema: S(
      {
        wave: { type: 'string' },
        ok: { type: 'boolean' },
        note: { type: 'string' },
      },
      ['wave', 'ok'],
    ),
    run: (a) =>
      api(`/api/corch/waves/${encodeURIComponent(str(a.wave))}/verify`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ok: a.ok === true, note: a.note != null ? str(a.note) : undefined }),
      }),
  },
  {
    name: 'climayte_status',
    listed: true,
    description: `Reads CliMayte workers: status, account, last activity, result or error, moves and cost. Scope it with group (all of that group's workers) or id (one worker, with its last 60 event lines, which show why it failed). Unscoped, it lists the active workers plus the ${RECENT_FINISHED} most recent finished ones. Use wait_seconds (1 to ${CLIMAYTE_MAX_WAIT_S}) to wait for the next status change instead of polling, and call again to keep waiting. Longer waits are cut: an MCP client drops a call held about 60 seconds. report: true gives one compact row per worker with its report, for judging. A worker with a question is waiting for your answer: reply with climayte_send. The story of a run is in climayte_log. Read-only.`,
    inputSchema: S({
      group: { type: 'string' },
      id: { type: 'string' },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only these workers (with or without `group`).',
      },
      report: {
        type: 'boolean',
        description: 'The report view: one compact row per worker, with its report.',
      },
      chars: {
        type: 'number',
        description:
          'With `report`: how many characters of each report (default 1500, 0 for none).',
      },
      active: { type: 'boolean', description: 'Only queued, running and waiting workers.' },
      all: {
        type: 'boolean',
        description:
          'Also list finished work a verdict already covers; the default list leaves it out (it is what you already judged).',
      },
      limit: {
        type: 'number',
        description: `How many finished workers to list beside the active ones (default ${RECENT_FINISHED} without a group, all of them with one).`,
      },
      wait_seconds: { type: 'number' },
      wave: {
        type: 'string',
        description:
          "A wave id (from climayte_manage): lists that wave's workers plus its manager, newest first.",
      },
      ping: {
        type: 'boolean',
        description:
          "With `group`: make THIS chat the one messaged when that group's live workers settle (those that report to nobody yet: dispatched before pings, or by an untraced caller). Answers `adopted` and a `ping` line.",
      },
    }),
    run: async (a) => {
      const started = Date.now()
      const group = a.group != null && str(a.group) ? str(a.group) : undefined
      // A scoped read is the chat looking at its own work: what it read is no news after this (markSeen).
      const scope = statusScope(a, group)
      const trace = scope ? callerOrigin(a) : null
      // Adoption first, so the list read after it already shows it.
      const extra = await climayteStatusPings(a, group)
      // The watch gets only what the call has left: the pings' caller lookup can take up to
      // CALLER_ORIGIN_BUDGET_MS, and a full watch after it was an answer the call budget dropped.
      // A waiting read is stamped by the daemon as it builds the answer (seen_by), so the trace is awaited
      // first; the wait gets what is left. A read that answers at once is stamped after it, as of just
      // before it: either way a worker that changes after the answer was built is not counted as seen.
      const waits = Number(a.wait_seconds) > 0
      const seenBy = scope && trace && waits ? (await trace).origin?.sessionId : undefined
      const left = Math.floor(CLIMAYTE_MAX_WAIT_S - (Date.now() - started) / 1000)
      const asked = Date.now()
      const answer = await climayteStatusRead(a, group, Math.max(0, left), seenBy)
      if (scope && trace && !waits) await within(markSeen(trace, scope, asked), SEEN_WAIT_MS)
      if (!extra) return answer
      return Array.isArray(answer)
        ? { workers: answer, ...extra }
        : { ...(answer as Record<string, unknown>), ...extra }
    },
  },
  {
    name: 'climayte_log',
    listed: true,
    description:
      "Read CliMayte's orchestration journal: one line per state change of every worker (dispatched; launched on which account and why it was picked: its session/week % and how many workers it already ran; limit hit and when the wall ends; moved; handoff requested/written/resumed; follow-up queued/delivered; retries; done with cost and turns; failed with the error's first line; cancelled; interrupted by a restart). Scope by `group` or `id`; `since` (ISO time or epoch ms) for only newer lines; `limit` (default 100) for the newest that many. Newest last, one readable line each, e.g. `23:41:07 w-1234abcd 'Fix events rows' launched on #84 (session 12%, week 0%, 0 active)`.",
    inputSchema: S({
      group: { type: 'string' },
      id: { type: 'string' },
      since: { type: ['string', 'number'] },
      limit: { type: 'number' },
    }),
    run: (a) =>
      api(
        `/api/corch/journal${qs({
          group: a.group != null ? str(a.group) : undefined,
          id: a.id != null ? str(a.id) : undefined,
          since: a.since != null ? str(a.since) : undefined,
          limit: a.limit != null ? Math.max(1, Math.floor(Number(a.limit) || 100)) : undefined,
          format: 'lines',
        })}`,
      ),
  },
  {
    name: 'climayte_send',
    listed: true,
    description:
      "MUTATES: sends a follow-up message to a CliMayte worker as its next turn in the same session. Use it to answer a worker's question (it shows as question on climayte_status) or to steer it. A finished worker starts on the message at once. A running one takes it when its current task ends, unless urgent is true: then the running work stops cleanly and the message goes first. The worker sees nothing of this chat, so the text must stand on its own. model and effort switch the worker for this turn and every later one.",
    inputSchema: S(
      {
        id: { type: 'string' },
        text: { type: 'string' },
        urgent: {
          type: 'boolean',
          description:
            'Stop a running worker now and deliver this first (default false: held until its task ends).',
        },
        model: {
          type: 'string',
          description:
            'Run this turn and the later ones on this model: opus, sonnet or haiku (Haiku 5.5; Haiku 4.5 is refused).',
        },
        effort: {
          type: 'string',
          description:
            'Run this turn and the later ones at this thinking level: low, medium, high, xhigh or max.',
        },
        cwd: {
          type: 'string',
          description:
            "Continue the worker in this folder (absolute, existing, local; not a network path) from its next launch on: its session is copied into that folder's project dir on the account it runs on (the original stays) and resumed there. climayte_status shows `cwd` and, until then, `pendingCwd`.",
        },
      },
      ['id', 'text'],
    ),
    run: (a) =>
      api(`/api/corch/workers/${encodeURIComponent(str(a.id))}/send`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          text: str(a.text),
          urgent: a.urgent === true,
          model: a.model != null ? str(a.model) : undefined,
          effort: a.effort != null ? str(a.effort) : undefined,
          cwd: a.cwd != null ? str(a.cwd) : undefined,
        }),
      }),
  },
  {
    name: 'climayte_verdict',
    listed: true,
    description:
      'MUTATES: records your verdict on a finished CliMayte worker, after you have checked its proof: pass or fail. Verdicts train the model choice for auto. A fail needs severity (0 when the check or brief was at fault and it is not scored; 1 a small fix; 2 a real part is wrong; 3 unusable) and a note the worker receives. A fail goes back to the same session one step up the model ladder, unless retry is false. If a cheap setting failed, the task was often too big: record the fail with retry false and send smaller parts.',
    inputSchema: S(
      {
        id: { type: 'string' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Several finished workers, instead of `id`: the same verdict for each.',
        },
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        note: { type: 'string' },
        retry: { type: 'boolean' },
        kind: { type: 'string' },
        severity: {
          type: 'integer',
          minimum: 0,
          maximum: 3,
          description: "A fail's severity, 0-3.",
        },
      },
      ['verdict'],
    ),
    run: (a) => {
      const ids = Array.isArray(a.ids) ? a.ids.map((x) => str(x)).filter(Boolean) : []
      if (!ids.length && (a.id == null || !str(a.id))) throw new Error('pass `id` or `ids`')
      if (str(a.verdict) === 'fail' && a.severity == null)
        throw new Error(
          "a fail needs `severity`: 0 not the model's (not scored), 1 slip (a small fix), 2 rework (a real part wrong), 3 failed (wrong or unusable)",
        )
      const body = JSON.stringify({
        ...(ids.length ? { ids } : {}),
        verdict: str(a.verdict),
        severity: a.severity != null ? Number(a.severity) : undefined,
        note: a.note != null ? str(a.note) : undefined,
        retry: a.retry === false ? false : undefined,
        kind: a.kind != null ? str(a.kind) : undefined,
      })
      return api(
        ids.length
          ? '/api/corch/verdicts'
          : `/api/corch/workers/${encodeURIComponent(str(a.id))}/verdict`,
        { method: 'POST', headers: JSON_HEADERS, body },
      )
    },
  },
  {
    name: 'climayte_priority',
    listed: true,
    description:
      "MUTATES: change a CliMayte worker's priority (whole number; climayte_run's default is 0). Queued and waiting work starts highest first, then oldest first, so a raised task takes the next free account slot ahead of the rest; a running worker is not stopped. The journal records the change.",
    inputSchema: S({ id: { type: 'string' }, priority: { type: 'number' } }, ['id', 'priority']),
    run: (a) =>
      api(`/api/corch/workers/${encodeURIComponent(str(a.id))}/priority`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ priority: Number(a.priority) }),
      }),
  },
  {
    name: 'climayte_scorecard',
    description:
      "What works, per kind of CliMayte task: every verdict on record summed by model and thinking level (passes, fails, and what a task cost on average as a share of a Pro account's 5-hour window), with `pick` on the setting a model-`auto` task of that kind gets next.",
    inputSchema: S({}),
    run: () => api('/api/corch/scorecard'),
  },
  {
    name: 'climayte_handoff',
    description:
      'MUTATES: hand a RUNNING CliMayte worker to a fresh session: after its current step it writes a handoff file, and the task continues in a new, small session (on the account with the most room) that starts from that handoff instead of re-reading the whole conversation. CliMayte does this by itself when a worker nears its usage limit; call it to free an account or to give a task whose conversation has grown huge a clean start.',
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) =>
      api(`/api/corch/workers/${encodeURIComponent(str(a.id))}/handoff`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: '{}',
      }),
  },
  {
    name: 'climayte_cancel',
    listed: true,
    description:
      'MUTATES: stop a CliMayte worker (`id`) or every worker of a `group`. Messages queued for it are kept (`keptMessages` counts them) and delivered, in order, when it is continued with climayte_send.',
    inputSchema: S({ id: { type: 'string' }, group: { type: 'string' } }),
    run: async (a) => {
      if (a.id == null && a.group == null) throw new Error('pass `id` or `group`')
      // A chat that cancels its own work knows it ended: no ping about it (markSeen).
      const trace = callerOrigin(a)
      const r = (await api('/api/corch/cancel', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          id: a.id != null ? str(a.id) : undefined,
          group: a.group != null ? str(a.group) : undefined,
        }),
      })) as { cancelled?: unknown }
      const ids = Array.isArray(r?.cancelled)
        ? r.cancelled.filter((x): x is string => typeof x === 'string')
        : []
      if (ids.length) await within(markSeen(trace, { ids }, Date.now()), SEEN_WAIT_MS)
      return r
    },
  },

  // --- Codex CLI + Desktop instances --------------------------------------------
  {
    name: 'list_codex_instances',
    description:
      'Lists isolated Codex instances (one CODEX_HOME and desktop profile per OpenAI login), each with its permanent instance number. The numbers come from the same sequence as the Claude instances, so a number is never ambiguous between them. Read-only.',
    inputSchema: S(),
    run: () => api('/api/codex-instances'),
  },
  {
    name: 'create_codex_instance',
    description:
      "MUTATES: creates an isolated CODEX_HOME folder. Authentication stays the owner's step.",
    inputSchema: S({ name: { type: 'string' } }, ['name']),
    run: (a) =>
      api('/api/codex-instances', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: str(a.name) }),
      }),
  },
  {
    name: 'launch_codex_instance',
    description:
      'MUTATES: open a terminal running this Codex instance. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/launch`,
        { method: 'POST', headers: JSON_HEADERS, body: '{}' },
      ),
  },
  {
    name: 'codex_instance_login_helper',
    description:
      'MUTATES: open `codex login` in a terminal for the user. The daemon never authenticates for them. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/login`,
        { method: 'POST' },
      ),
  },
  {
    name: 'open_codex_desktop_instance',
    description:
      'MUTATES: launch this isolated Codex Desktop instance, independently from other Codex windows. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/desktop/open`,
        { method: 'POST' },
      ),
  },
  {
    name: 'focus_codex_desktop_instance',
    description:
      "MUTATES: bring this running Codex Desktop instance's window to the foreground. Identify it by number (`instance`) or by `id`.",
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/desktop/focus`,
        { method: 'POST' },
      ),
  },
  {
    name: 'quit_codex_desktop_instance',
    description:
      'MUTATES: stop this isolated Codex Desktop instance. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/desktop/quit`,
        { method: 'POST' },
      ),
  },
  {
    name: 'redeem_codex_reset_credit',
    description:
      "MUTATES: spend one banked Codex `/usage reset` credit, which restores the FULL 5h + weekly rate-limit windows in one shot. Refuses unless the busiest window is already 100% used, since redeeming early wastes most of the credit's value — the result names the busiest window's percent when it refuses. Pass `force: true` to redeem anyway. Identify the instance by number (`instance`) or by `id`.",
    inputSchema: S({
      instance: INSTANCE_PARAM,
      id: { type: 'string' },
      force: {
        type: 'boolean',
        description: 'Bypass the "busiest window is not fully used" guard.',
      },
    }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/redeem-reset-credit`,
        {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ force: a.force === true }),
        },
      ),
  },

  // --- auto-resume monitor (Feature E) ------------------------------------------
  {
    name: 'get_monitor',
    description:
      'Get the auto-resume monitor: settings (enabled, maxAttempts, resumeBufferMin), the tracked rate-limited stops + their state (scheduled / blocked_weekly / needs_human), and per-account overrides.',
    inputSchema: S(),
    run: () => api('/api/monitor'),
  },
  {
    name: 'set_monitor',
    description:
      'MUTATES: update the auto-resume monitor (enabled, maxAttempts, resumeBufferMin). OFF by default. When on, a session killed by a 5-hour rate limit auto-resumes once the window clears — gated on the weekly cap not being maxed.',
    inputSchema: S({
      enabled: { type: 'boolean' },
      maxAttempts: { type: 'number' },
      resumeBufferMin: { type: 'number' },
    }),
    run: (a) =>
      api('/api/monitor', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(a) }),
  },

  {
    name: 'launch_terminal_session',
    refuses: true,
    description:
      "Refused on every call on this machine. Terminal launches were removed by the owner's rule: a visible console is a window nobody asked for, a hidden one is a headless chat, and there is no setting for it. The tool stays so a caller gets this reason instead of a missing name. To start new work on another account, use fan_out (visible desktop chats, one per account, tracked as a group) or orchestrator_run spawn_chat (one chat). To continue a chat, deliver into it with fan_out_send, or with orchestrator_run cli_send, stage_reply or courier.",
    inputSchema: S(
      {
        cwd: { type: 'string' },
        prompt: { type: 'string' },
        instance_ref: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        resume_session_id: { type: 'string' },
        visible: {
          type: 'boolean',
          description:
            'Put a console window on screen. Default false. Only when a person asked to watch this session.',
        },
      },
      ['cwd', 'prompt'],
    ),
    run: (a) =>
      api('/api/sessions/launch-terminal', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(a),
      }),
  },
  {
    name: 'import_session_to_desktop',
    description:
      "MUTATES: moves a finished session into a desktop instance's app as a visible chat. A move is a move: the source account stops showing the chat. It lands in the target through the app's own claude://resume import, or by a direct record write when that app is closed. It keeps the chat's model and permission settings and retires every other profile's copy: a closed app gets the archive flag, and a running one archives it itself through native control, or through its own Archive control where there is none. A native refusal is final and is never retried. ok true means it landed; sourceStillShown lists every profile still showing the chat, with the reason and remedy in sourceSettle[].reason. instance_ref ('desktop:<dir>', from list_instance_numbers) is required, since there is no inferred target. A title decision is required: pass title (a real, non-generic name) or confirm_title (the chat's current title restated exactly after review; the dossier gives it). Without one it is refused. A live session is refused, because the move rewrites the transcript under an active writer; settle or stop that engine first. Only a person's own migrate_chat --stop-idle may stop an idle engine. Do all headless work first and move last. A just-landed chat does not process peer messages until the user first interacts with it.",
    inputSchema: S(
      {
        session_id: { type: 'string' },
        instance_ref: { type: 'string' },
        title: { type: 'string' },
        confirm_title: { type: 'string' },
      },
      ['session_id'],
    ),
    // /migrate, NOT /import-desktop. The import half only LANDS the chat: it leaves the source
    // account's row untouched, so the thread showed on both accounts and every later resolve of
    // it was ambiguous (hit live 2026-09-04 — an agent moved a chat with this tool and the owner
    // still had it). stop_live:false keeps the import door's live refusal; the archive, the
    // settings carry and the running-app re-assert come free with the endpoint that owns them.
    run: async (a) =>
      api(`/api/sessions/${encodeURIComponent(str(a.session_id))}/migrate`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          instance_ref: a.instance_ref,
          title: a.title,
          confirm_title: a.confirm_title,
          stop_live: false,
        }),
      }),
  },
  {
    name: 'move_chat',
    listed: true,
    description:
      "MUTATES: moves one chat to another Claude Desktop account in a single call. Use it for 'move the X chat from account A to here'. chat is a title fragment (matched loosely, so case and misspelling still find it) or a session id. from narrows the search to one account when two share a title. to defaults to 'here'; 'best' picks the account with the most headroom. The move keeps every safety check the orchestrator has. Every landing is stamped bypassPermissions; read landed for the verdict, bypassVerdict (not permissionMode) for the permission mode, and collateral for any other chat it archived. The force argument is the person's word: pass it only when they asked for that specific archived chat. Use dry_run: true first when the target is unclear, and read targetNote before a real move. If the answer is still waiting after 45 seconds it gives an operationId: poll orchestrator_operation with it; calling move_chat again with the same arguments returns the same operation. Another folder is not this tool: desk_chat for a Hydra Desk chat, move_chat_folder for a Claude Desktop one.",
    inputSchema: S(
      {
        chat: { type: 'string', description: 'Title fragment (fuzzy) or session id.' },
        from: {
          type: ['string', 'number'],
          description:
            'The instance the chat lives on: number, name, label or email. Optional; scopes the search and disambiguates a shared title.',
        },
        to: {
          type: ['string', 'number'],
          description:
            '"here" (default: the instance this process runs as), "best" (most headroom), or an instance number/name/label/email.',
        },
        title: {
          type: 'string',
          description:
            'Rename on landing (a real, non-generic name). Default: keep the current title.',
        },
        force: {
          type: 'boolean',
          description:
            "A person's word: override a hold / superseded lineage. Only when the human asked.",
        },
        wait_secs: {
          type: 'number',
          description:
            "Seconds the move waits, in the daemon, for an idle-but-young engine (default 330, max 360). Past 45s the call answers with the operation id and the wait carries on there. For a whole-account drain - several chats, a resume prompt typed into each landed chat, or a live engine killed on a person's word - use move_chats, which takes one chat as happily as twenty and has `resume` and `terminate_live`.",
        },
        dry_run: { type: 'boolean', description: 'Plan only: resolve everything, move nothing.' },
        archived: {
          type: 'boolean',
          description:
            'Move the chat even though it is ARCHIVED. Default FALSE, and leave it that way unless the human asked for that specific chat. Note that `archived` does NOT mean the chat is finished: it is Claude Desktop\'s resting "not on screen" state, carried by 2,598 of 2,611 chats when measured, so it is the MAJORITY of any account rather than a tail. That is why the default is off. Separate from `force`, both ways: neither implies the other.',
        },
      },
      ['chat'],
    ),
    run: async (a) => {
      const chat = str(a.chat).trim()
      if (!chat) throw new Error('chat is required: a title fragment or a session id')
      const wait = Math.max(0, Math.min(360, Number(a.wait_secs ?? 330) || 0))
      // One resolver, shared with move_chats (resolveMoveTarget), so a batch and a single
      // move can never disagree about which account "here" or "best" names.
      const { toRef, targetNote } = await resolveMoveTarget(a.to, await callerPidFromArgs(a))
      const args = [
        chat,
        '--to',
        toRef,
        '--stop-idle',
        '--now',
        '--idle-wait',
        String(wait),
        '--json',
      ]
      if (a.from != null && str(a.from).trim() !== '') {
        const src = await resolveRef(str(a.from).trim())
        args.push('--from', String(src.num))
      }
      if (a.force === true) args.push('--force')
      if (a.title != null && str(a.title).trim() !== '') args.push('--title', str(a.title).trim())
      if (a.dry_run === true) args.push('--dry-run')
      // Off by default, and migrate_chat enforces the same default independently (exit 7),
      // so omitting this can only ever be safe. Owner, 2026-09-05: a move touches
      // unarchived chats only, unless the human asked for that specific chat.
      if (a.archived === true) args.push('--archived')
      // ⛔ THE MOVE MAY OUTLAST THE CALL (2026-09-30): the desktop app's MCP client drops a call at
      // about 60 s, and a move sleeping out its quiet window runs up to wait_secs + its work. So it
      // runs detached and this call waits at most MCP_WAIT_MAX_MS for the verdict; the window
      // itself is unchanged (it is the script's --idle-wait). The key makes a re-fire of the same
      // move return the SAME operation, never a second move; a dry run moves nothing and gets a
      // fresh run each time, for the reason move_chats gives below.
      const run = await runScript({
        script: 'migrate_chat',
        args,
        // the wait happens INSIDE the script, so the deadline must outlast it
        timeoutMs: (wait + 180) * 1000,
        idempotencyKey:
          a.dry_run === true
            ? `move_chat:dry:${Date.now()}:${JSON.stringify(args)}`
            : `move_chat:${JSON.stringify(args)}`,
      })
      if (run.detached === true)
        return {
          ...detachedAnswer(run, stillRunningNote('The move')),
          targetNote,
        }
      let payload: Record<string, unknown> | null = null
      try {
        const parsed: unknown = JSON.parse(str(run.stdout))
        if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>
      } catch {
        payload = null
      }
      if (!payload) {
        // no JSON means the script never got to its own report (usage error, python missing,
        // daemon busy) — hand back the raw run so the reason is visible, never a bare failure
        return { ...run, ok: false, args, targetNote }
      }
      // COLLATERAL IS NOT OK (2026-09-17). `landed` answers "did THIS chat move"; a move that
      // archived a chat it was never given is not a clean move, and the script already says so
      // on its own payload - so the tool's verdict must not read it back as a success.
      const collateral = Array.isArray(payload.collateral) ? payload.collateral : []
      return {
        ok: (payload.landed === true || payload.dryRun === true) && collateral.length === 0,
        ...payload,
        targetNote,
        exitCode: run.exitCode,
        exitMeaning: run.exitMeaning,
        ...(str(run.stderr).trim() ? { stderr: run.stderr } : {}),
      }
    },
  },
  {
    name: 'move_chats',
    description:
      "MUTATES: moves many chats between accounts in one call. Use it whenever more than one chat moves. Do not loop move_chat, and do not fire it in parallel: the daemon keys in-flight work by script name, so the extra calls get 409 busy. It runs the orchestrator's migrate_batch, which runs migrate_chat's own pipeline inside one interpreter and one route lock, by phase: every chat is moved and verified, then every source row is settled, then one shared bypass watch stamps every chat's permission. Chats are usable as soon as the first phase ends. Each chat keeps its effort (effortCarried per result). A source at its usage limit (98% or more) is always archived, even over another chat's servers there; stoppedBystanders names them. Every rail still applies per chat: each chat is re-resolved before its own gates, a live writer is refused, the landing is verified by read-back, the source row is settled, and the bypass verdict is adjudicated. Read each result's bypassVerdict, never permissionMode. Imports run one at a time on purpose, because parallel imports into one store can create a duplicate row that makes a chat unreachable. Pass chats (title fragments or session ids), or all_unarchived true for every unarchived desktop chat, narrowed by from and capped by limit. A chat filed under a previous login of the target (list_chats staleLogin true) is re-homed into the signed-in folder, and its old record is set aside under ~/.agenthydra/backups/stale-login-records, never deleted. A refused chat does not stop the batch: read refused and the per-chat results, not only moved. Read collateral: any chat outside the move that was archived while it ran is named there, with ok false and the account to unarchive it from. dry_run true plans every chat and moves nothing. targetNote confirms the whole batch's account by name and email, resolved once before the first import and the same with or without dry_run; when the target is not obviously right, dry-run first and read it. Archived chats do not move by default and must not be swept along: an account's archive is most of its chats, so all_unarchived means unarchived chats only. The engine refuses the whole batch if archived chats are named without archived_count, if that count does not match, or if archived and unarchived chats are mixed. Another folder is not this tool: use desk_chat for a Hydra Desk chat.",
    inputSchema: S(
      {
        chats: {
          type: 'array',
          minItems: 1,
          items: {
            type: ['string', 'object'],
            properties: {
              chat: { type: 'string', description: 'A title fragment (fuzzy) or a session id.' },
              title: {
                type: 'string',
                description:
                  "THIS chat's own real title - the per-chat door added 2026-09-15 (TODO item 1). " +
                  "Without it, a bare move restates one of the chat's two CURRENT names as " +
                  "confirm_title (the daemon session's own title, or the desktop record's - they " +
                  'can disagree, e.g. a chat titled by its first message on one side and renamed ' +
                  'in the app on the other), and a caller with no way to read which one the door ' +
                  "wants got a deterministic 400. Naming the chat's real title here is a NEW " +
                  'name, which the naming door always accepts outright - no restatement, no ' +
                  'guessing which store the door compares against. Ignored on a plain-string ' +
                  'entry.',
              },
            },
            required: ['chat'],
          },
          description:
            'The chats to move: each a title fragment (fuzzy) or a session id, OR ' +
            '`{chat, title}` to also give that one chat its own real title (see `title` above). ' +
            'Omit only when using all_unarchived.',
        },
        all_unarchived: {
          type: 'boolean',
          description:
            "Instead of naming chats, take EVERY unarchived desktop chat (scope it with `from`, cap it with `limit`). Archived chats are excluded — that is Claude Desktop's resting state and the majority of any account.",
        },
        from: {
          type: ['string', 'number'],
          description:
            'The account the chats live on: number, name, label or email. Scopes both the search and all_unarchived.',
        },
        to: {
          type: ['string', 'number'],
          description:
            '"here" (default: the instance this process runs as), "best" (most headroom), or an instance number/name/label/email. Resolved exactly as move_chat resolves it.',
        },
        force: {
          type: 'boolean',
          description:
            "A person's word, applied to EVERY chat in the batch: override a hold / superseded lineage. A live writer is never overridden. Only when the human asked.",
        },
        archived_count: {
          type: 'number',
          description:
            "⛔ ONLY WHEN THE HUMAN NAMED ARCHIVED CHATS. How many of the chats in this batch are ARCHIVED. Replaced the old `archived: true` boolean on 2026-09-13, because a boolean cannot tell the human's instruction from an agent's own initiative and an agent set it for itself while sweeping an account, queueing all 22 of its archived chats behind the 3 that were asked for. The engine REFUSES THE WHOLE BATCH unless this number EQUALS the archived chats it actually holds, and unless they are the WHOLE batch - archived chats never ride along with unarchived ones. Counting them first is the point. Omit it entirely for ordinary work; `all_unarchived` never needs it.",
        },
        limit: {
          type: 'number',
          description:
            'With all_unarchived, cap the batch at the N most recently active chats. 0 or omitted means no cap.',
        },
        wait_secs: {
          type: 'number',
          description:
            'Seconds each chat may wait for an idle-but-young engine (default 60 for a batch, max 360). Lower than move_chat on purpose: waiting 330s per chat is what makes a batch take a quarter of an hour.',
        },
        resume: {
          type: 'string',
          description:
            "After EVERY landed chat is moved, settled and stamped, stage this text as a reply to each one and deliver it by hand - the courier's NAMED-delivery path: no tray icon, no fair-share cap, because a person is managing (owner, 2026-09-06). This is what makes a migrated chat CONTINUE WORKING: a landed chat is otherwise DORMANT until someone types into it. A chat whose engine booted on landing and is mid-turn keeps the reply staged (the courier never interrupts a live turn); its result carries `resume.retry`, the exact command. Read each result's `resume` ({delivered, why, retry}) - a landed chat with resume.delivered false is moved but has not been told to carry on. Say in the text that the chat was moved and why, and if terminate_live is on, that any in-flight tool result was lost. If the whole call is REFUSED because another batch holds the route, the resume is not lost: it is staged against each named chat and listed in `resumeStaged` (deliver with courier --yes --only <id>). ⛔ MOVING INTO YOUR OWN APP (`to` \"here\")? OMIT `resume` and, once the batch reports the chats landed, send the same text to each one with the Claude app's own session messaging (ccd_session_mgmt send_message / SendMessage to the `local_...` id): measured 2026-09-26, that delivered 4 of 4 in under a second each, while the courier typed serially, waited out engines booted on landing, and refused one chat outright ('does not show the expected text') - minutes, and a chat left unresumed.",
        },
        terminate_live: {
          type: 'boolean',
          description:
            "A PERSON'S WORD: a chat refused for a live engine (working, or quiet but not yet past its window) has that engine KILLED - the whole process tree - and is then moved. ALREADY GIVEN when the source account is at 98% or more on its 5-hour OR weekly bucket (owner's standing order, 2026-09-20): the engine kills those without this flag, and the result's `terminated.standingOrder` says so. For draining an account about to hit its limit, where letting the turn finish would spend the last of its quota and the turn would die on the wall anyway. The transcript survives; a tool result still in flight is lost, so pair it with `resume` text that says so. Never implied by `force` (which only overrides a hold); never applied to a hold, the breaker, or an archived chat; an unconfirmed kill leaves the refusal in place and says why. It also PREEMPTS a patient move_chats already running for the SAME chats (the answer carries `preempted: <operation id>`), so 'kill it and move it' is this one call, never a taskkill; a running batch that names chats this call does not is still refused, and stopping it is orchestrator_cancel's job.",
        },
        dry_run: { type: 'boolean', description: 'Plan every chat, move nothing.' },
        background: {
          type: 'boolean',
          description:
            "ALREADY THE DEFAULT (2026-09-13) whenever this batch's own declared length exceeds 50s, which is every real batch (one chat already declares 270s). True answers AT ONCE with `operationId` instead of holding the connection open; poll `orchestrator_operation {id}` for the full report. Any other batch waits at most 45s for its report and then answers with the id the same way, because an MCP client drops a call at about 60s. `false` FORCES blocking even past 50s - only for a caller who knows their own transport can wait. Omit it to get the auto rule. This batch's own deadline runs to an hour, which is far longer than most MCP callers will wait, and a caller that gives up first loses the entire per-chat report - what landed, every bypassVerdict, whether each resume was delivered - for work that is still running and WILL finish.",
        },
      },
      [],
    ),
    run: async (a) => {
      // Each entry is a bare query string, or `{chat, title}` naming that one chat's own real
      // title (2026-09-15, TODO item 1's per-chat door). Either shape reduces to a {chat, title}
      // pair; a bare string just carries no title.
      const chatSpecs = (Array.isArray(a.chats) ? a.chats : [])
        .map((c) => {
          if (c != null && typeof c === 'object') {
            const o = c as Record<string, unknown>
            return {
              chat: str(o.chat).trim(),
              title: typeof o.title === 'string' ? o.title.trim() : '',
            }
          }
          return { chat: str(c).trim(), title: '' }
        })
        .filter((c) => c.chat !== '')
      const chats = chatSpecs.map((c) => c.chat)
      const all = a.all_unarchived === true
      if (!all && chats.length === 0)
        throw new Error(
          'name the chats in `chats`, or pass all_unarchived: true (optionally with `from` and `limit`)',
        )
      // A batch's per-chat wait defaults LOW. move_chat's 330s is right when a human asked for
      // one specific chat and will wait for it; multiplied across a batch it is the entire
      // complaint this tool exists to answer.
      const wait = Math.max(0, Math.min(360, Number(a.wait_secs ?? 60) || 0))
      const { toRef, targetNote } = await resolveMoveTarget(a.to, await callerPidFromArgs(a))
      const args = ['--to', toRef, '--stop-idle', '--now', '--idle-wait', String(wait), '--json']
      for (const c of chatSpecs) {
        args.push('--chat', c.chat)
        if (c.title) args.push('--chat-title', c.title)
      }
      if (all) args.push('--all-unarchived')
      if (a.from != null && str(a.from).trim() !== '') {
        const src = await resolveRef(str(a.from).trim())
        args.push('--from', String(src.num))
      }
      if (a.force === true) args.push('--force')
      // The cautious design is to refuse a mismatched count. This replaced the earlier bare boolean
      // permanently (landed 6be90fd; a caller still sending a boolean fails the schema loudly by design).
      // The archive override's caller half: a COUNT, never a bare boolean, and the count travels
      // with the override so the engine can refuse a number that does not match what it sees.
      // `all_unarchived` is unarchived by definition, so a count against it is meaningless and
      // is dropped rather than forwarded as a contradiction.
      const archivedCount = Number(a.archived_count)
      if (!all && Number.isFinite(archivedCount) && archivedCount > 0)
        args.push('--archived', '--archived-count', String(Math.floor(archivedCount)))
      if (a.dry_run === true) args.push('--dry-run')
      const limit = Math.max(0, Math.floor(Number(a.limit ?? 0) || 0))
      if (limit > 0) args.push('--limit', String(limit))
      const resume = typeof a.resume === 'string' ? a.resume.trim() : ''
      if (resume !== '') args.push('--resume', resume)
      const terminate = a.terminate_live === true
      if (terminate) args.push('--terminate-live')
      // The batch's own deadline must outlast every chat's wait plus its work, or the daemon
      // kills a run mid-move and the report never comes back. A resume delivery is a composer
      // boot (~15-60s each); a terminate is a kill, a confirm (up to 30s) and a second move.
      const planned = all ? Math.max(limit || 40, 40) : chats.length
      const perChat = wait + 90 + (resume !== '' ? 75 : 0) + (terminate ? 60 : 0)
      const timeoutMs = Math.min(3_600_000, (planned * perChat + 180) * 1000)
      // A DETERMINISTIC idempotency key over this exact batch. The caller's transport gives up
      // long before a real batch finishes (measured 2026-09-09: a 6-chat drain with resume text
      // outlived the MCP timeout, and the agent then had no way to learn that every chat HAD
      // landed and every resume reply HAD been staged - so it staged five duplicates). Re-firing
      // the identical call now returns the ORIGINAL operation instead of moving anything twice,
      // which makes "I lost the answer, ask again" the safe move rather than a second act.
      //
      // ⛔ EXCEPT FOR A DRY RUN, which has no act to make idempotent and is actively harmed by
      // this (2026-09-18): two probes minutes apart with identical arguments came back
      // BYTE-IDENTICAL, same `secs: 1.08`, same `quiet_secs: 13`, because the daemon correctly
      // returned the existing operation rather than running twice. A caller polling the gate to
      // find its window therefore reads a STALE quiet_secs and cannot tell - varying one
      // argument (`wait_secs` 5 -> 7) forced a fresh run and immediately showed 21s, not 13s.
      // "Vary an argument each time" is a trap nobody would guess from the tool description, so
      // a dry run gets a fresh key per call instead. Nothing is moved either way.
      const idempotencyKey =
        a.dry_run === true
          ? `move_chats:dry:${Date.now()}:${JSON.stringify(args)}`
          : `move_chats:${JSON.stringify(args)}`
      // ⛔ THE SAME AUTO-DETACH orchestrator_run ALREADY EARNED FROM A NEARLY IDENTICAL INCIDENT
      // (2026-09-11, that tool's own history above) - a caller that DECLARES a run longer than
      // AUTO_DETACH_MS is detached automatically, because a batch is exactly the shape that
      // outlives an MCP client's transport (found again 2026-09-13: a ONE-chat batch's own
      // `timeoutMs` was already 330s+ - the default `background: a.background === true` waited
      // for the connection to die anyway, `The operation timed out.` with NO operationId, and
      // the finished report - including whether the resume was delivered - was unreachable).
      // `timeoutMs` here is built from the batch's own per-chat budget, so it is ALWAYS the
      // honest declared length of the run; an explicit `background: false` is still honoured
      // for a caller who really does want to block (and knows their transport can wait).
      const background =
        a.background === true || (a.background == null && timeoutMs > AUTO_DETACH_MS)
      let run: Record<string, unknown>
      try {
        run = await runScript(
          { script: 'migrate_batch', args, timeoutMs, idempotencyKey },
          background ? 'detach' : a.background === false ? 'block' : 'wait',
        )
      } catch (err) {
        // The route said no - another batch holds it and this call does not cover its chats (see
        // mayPreempt). Hand back the daemon's refusal as an object, not a thrown string. Its
        // `resumeStaged` was written by the DAEMON (orchestrator.ts stageRefusedResume), which is
        // the one place a refusal is seen on both the blocking and the detached path.
        const refusal = busyRefusal(err)
        if (!refusal) throw err
        const staged = Array.isArray(refusal.resumeStaged) ? refusal.resumeStaged : null
        return {
          ...refusal,
          ok: false,
          args,
          targetNote,
          ...(resume === ''
            ? {}
            : {
                note: staged?.length
                  ? 'The move was refused, but its resume text is STAGED against each named chat (see resumeStaged) - deliver it with courier.py --yes --only <id>, or leave it for the next successful move. Re-firing this call re-uses the same staged row rather than writing a second one.'
                  : 'The move was refused and its resume text was NOT kept: there was no named chat to stage it against (a whole-account sweep names none). Re-send it with the retry.',
              }),
        }
      }
      // A detached run answers with the id and nothing else yet - there is no report to parse.
      if (run.detached === true)
        return {
          ...detachedAnswer(
            run,
            a.background === true
              ? 'The batch is running in the daemon. Poll the id above for the full per-chat report; re-calling move_chats with these exact arguments returns this same operation rather than moving anything twice.'
              : background
                ? `Detached automatically: this batch's own declared length (${Math.round(timeoutMs / 1000)}s) is longer than an MCP client will hold a connection open, and a call the client abandons loses the report - what landed, every bypassVerdict, whether each resume was delivered - for work that keeps running anyway. Poll the id above for the full per-chat report; pass background:false if you really do want to block (only worth it for a batch you know is short).`
                : stillRunningNote('The batch'),
          ),
          targetNote,
        }
      let payload: Record<string, unknown> | null = null
      try {
        const parsed: unknown = JSON.parse(str(run.stdout))
        if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>
      } catch {
        payload = null
      }
      // No JSON means the script never reached its own report (usage error, python missing,
      // the route already busy) - hand back the raw run so the reason is visible.
      if (!payload) return { ...run, ok: false, args, targetNote }
      return {
        ...payload,
        targetNote,
        exitCode: run.exitCode,
        exitMeaning: run.exitMeaning,
        ...(str(run.stderr).trim() ? { stderr: run.stderr } : {}),
      }
    },
  },
  // --- fan-out: one task list -> N visible chats on N accounts (mcp-fan-out.ts)
  ...FAN_OUT_TOOLS,
  ...FREE_TOOLS,
  ...BABYSITTER_TOOLS,
  ...ROUTINES_TOOLS,
  ...DEV_SERVERS_TOOLS,
  ...FAMILY_TOOLS,
  ...findTools(
    () => TOOLS,
    () => LISTED_TOOLS,
  ),
  ...DASHBOARD_TOOLS,
  ...PRICECHECK_TOOLS,
  ...SUE_DREDD_TOOLS,
  ...MANAGER_TOOLS,
  ...CORE_TOOLS,
  {
    name: 'archive_desktop_chat',
    description:
      "MUTATES: archives a chat in the Claude Desktop app (archived true, the default) or unarchives it, by flipping its per-profile metadata flag. Without instance this is fleet-wide: it flips every profile whose store carries that session id. After a migration that includes both the source leftover and the real chat on the target, so an unscoped call can hide a chat the owner is using. It refuses with 409 when more than one profile carries the session and no instance was named, and it refuses to archive a chat whose engine is running unless force is set. Always pass instance when you mean one copy. For a running instance it drives the app's own archive control, so the row leaves the sidebar at once. Read stillOnScreen: false means retired now; true means only the flag landed, and note says why the click did not settle. The rails refuse when another live chat in that profile shows the same title, and a row the sidebar never rendered cannot be clicked; the flag then takes effect at that instance's next restart. Unarchiving has no in-app control to drive, so it always waits for that restart. For closed instances the flag alone is reliable. The AgentHydra done-mark is the immediate in-AgentHydra signal either way.",
    inputSchema: S(
      {
        session_id: { type: 'string' },
        archived: { type: 'boolean' },
        instance: {
          type: ['string', 'number'],
          description:
            "Which desktop instance's copy to flip - number, name, label, email or dir. Omit ONLY when you mean every profile carrying this session, and then only when exactly one does.",
        },
        force: {
          type: 'boolean',
          description: "A person's word: archive even though the chat has a running engine.",
        },
      },
      ['session_id'],
    ),
    run: async (a) => {
      let instanceRef: string | undefined
      if (a.instance !== undefined && a.instance !== null && str(a.instance).trim()) {
        const row = await resolveRef(str(a.instance).trim())
        if (row.kind !== 'desktop')
          throw new Error(
            `${instanceLabel(row)} is a ${row.kind} instance; desktop chats live only in Claude DESKTOP instances.`,
          )
        instanceRef = row.ref // already 'desktop:<dir>'
      }
      return api(`/api/sessions/${encodeURIComponent(str(a.session_id))}/desktop-archive`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          archived: a.archived,
          ...(instanceRef ? { instance_ref: instanceRef } : {}),
          ...(a.force === true ? { force: true } : {}),
        }),
      })
    },
  },
  {
    name: 'move_chat_folder',
    description:
      'MUTATES: move ONE Claude DESKTOP Code chat to another working folder in its own profile (a Hydra Desk chat, the AgentHydra 2.0 window, moves with desk_chat). The thread keeps its transcript, title, model, effort and permission mode, but the copy gets a NEW session id (returned as newSessionId) and the old chat is archived, never deleted. Refuses a folder that does not exist, the same folder, a running or busy chat, a chat used in the last 10 minutes, or a profile without native control.',
    inputSchema: S(
      {
        session_id: { type: 'string', description: 'The chat to move (its CLI session id).' },
        instance: {
          type: ['string', 'number'],
          description: 'Which desktop instance holds the chat - number, name, label, email or dir.',
        },
        cwd: {
          type: 'string',
          description: 'The new working folder: an absolute path to an existing folder.',
        },
      },
      ['session_id', 'instance', 'cwd'],
    ),
    run: async (a) => {
      const row = await resolveRef(str(a.instance).trim())
      if (row.kind !== 'desktop')
        throw new Error(
          `${instanceLabel(row)} is a ${row.kind} instance; desktop chats live only in Claude DESKTOP instances.`,
        )
      return api(`/api/sessions/${encodeURIComponent(str(a.session_id))}/desktop-folder`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ instance_ref: row.ref, cwd: str(a.cwd) }),
      })
    },
  },
  // --- self-update ------------------------------------------------------------------
  {
    name: 'check_update',
    description: 'Check whether a AgentHydra update is available (git-based).',
    inputSchema: S(),
    run: () => api('/api/update'),
  },
  {
    name: 'check_versions',
    description:
      "Read-only: checks whether the whole fleet runs one Claude version. It returns the newest installed Claude Desktop build; the newest build Claude's update feed offers (desktop.available, asked at most hourly), with desktop.installBehind when the install is older; the build each open instance runs; the Claude Code version the newest Desktop asks for (engine.target) and each live chat's engine version; the Claude Code copy staged in every instance folder, closed ones included; the terminal CLI's version; and flags, one plain sentence per item out of step. A closed instance with an old staged copy is not a problem by itself, because the app fetches the new one at its next session. An open instance on an old build, or a live chat on an old engine, changes only when it restarts, and this tool restarts nothing. The daemon runs the fixing pass every 10 minutes; sync_versions runs it now.",
    inputSchema: S(),
    run: () => api('/api/versions'),
  },
  {
    name: 'sync_versions',
    description:
      "MUTATES: runs the version-drift pass now instead of waiting for its 10-minute timer. It updates the Claude Desktop install with its own Squirrel Update.exe when Claude's feed offers a newer build; each account moves to that build at its next AgentHydra open. It stages the current Claude Code into every closed instance that is behind, hard-linked from a copy the app already downloaded and verified and renamed into place in one step. It updates the npm CLI install to the Desktop's version when no process runs from it. It records one incident per item still out of step and resolves the ones that are fixed. It never closes, restarts or stops an open instance or a live chat. Set AGENTHYDRA_VERSION_AUTOFIX to 0 on the daemon to make it flag only.",
    inputSchema: S(),
    run: () => api('/api/versions/sync', { method: 'POST' }),
  },
  {
    name: 'box_doctor',
    description:
      "Read-only: reports what on this PC slows every session and, where Project Hydra is installed, whether its registry of every codebase matches the disk. It replaces Project Hydra's ph doctor. It returns findings, each either a problem (an incident until it clears; the daemon checks every 15 minutes) or a note, with detail holding the live numbers. The checks cover a command whose first PATH match is a batch shim fronting a native exe; commit charge under 5% of its limit; a clock more than five minutes off; a drive or folder agents use that exists but cannot be listed; 25 or more console hosts Claude Desktop kept for stopped terminals; the orphan reaper's task missing or idle, where its script is installed; a pile of idle children under a live parent; and hydra entries (registry paths moved or missing, unregistered or nested checkouts, stale sweeps, unreadable record lines, stale instruments, Loki, the maintain task, prerequisites), read from ph facts --json at most hourly. checked lists what this read could look at; hydra says whether Project Hydra is installed and how old its facts are. It changes nothing on the machine. Windows only; elsewhere supported is false.",
    inputSchema: S(),
    run: () => api('/api/box-doctor'),
  },

  // --- the orchestrator ------------------------------------------------------------
  // The Python toolbox under orchestrator/ decides what SHOULD happen to a chat; the daemon runs
  // it on request (server/src/orchestrator.ts). One MCP surface for the whole fleet - an agent
  // no longer has to be told "you have to use both" (owner, 2026-09-03).
  {
    name: 'orchestrator_menu',
    description:
      "Read-only: returns the orchestrator's own menu of scripts, grouped as observe (reads only), act (behind the rails), the loop and the tray switch, plus where the toolbox lives and whether python answers. Read it once before orchestrator_run, since those script names are the only ones it accepts. Prefer actions over menu: it is the same list as data, keyed by script name, giving each script's kind (observe or mutate), summary, guards and exit-code meanings. actions null means it could not be read, and actionsError says why. It never means the toolbox has no scripts.",
    inputSchema: S(),
    run: () => api('/api/orchestrator'),
  },
  {
    name: 'orchestrator_run',
    description:
      "Runs one orchestrator script by its menu name (chats, migrate_chat, dossier, audit_twins, archive_chat, census, and the rest), with its own arguments, exactly as python orch.py script would. Observe scripts are read-only. Act scripts mutate, and keep every rail they have on the command line. Nothing acts unless the tray icon is up; orchestrator_switch armed says whether it is. A live chat is never moved or archived, and every attempt is counted. force is the owner's word for one act: pass it only when the owner asked for that act. Two scripts are hand-run and do not need the icon, migrate_chat and chats --move-to, because the icon gates the unattended lanes, not the owner's own move. So for a targeted move, do not arm first: arming resumes saturate, which wakes dormant chats, and a chat with a live engine cannot move until it has been quiet for 300 seconds. Pass --idle-wait 330 with --stop-idle and the command waits that window itself; a working or stuck engine still refuses at once. The answer returns stdout, stderr, the exit code and what the driver's code means: 0 ok, 2 something failed, 3 refused, unknown or not armed, 1 daemon failure. A script's own codes are in its --help, which you can run here with args ['--help']. timeout_secs defaults to 600 (server cap 3600), but your client's transport gives up at about 60 seconds, so a blocking call that outlives it loses the report while the daemon keeps running. Any run declared longer than 50 seconds is detached: you get an operationId and a poll line at once. Any other run answers inline if it finishes within 45 seconds, and otherwise the same way, with the id. orchestrator_operation {id} returns the same verdict the blocking call would have, kept for an hour while the daemon that ran it stays up. Lost a call? orchestrator_operation with no id lists recent runs. A restart wipes those records, and the run may have finished or died with the daemon. If a poll says reason daemon-restarted, never re-fire it: read the toolbox's ledger and verify the effect directly. For a move (migrate_batch, migrate_chat), run migrate_reconcile, which lists chats left half-moved; migrate_reconcile --finish <id> settles each. The daemon refuses a restart while a move runs unless the restart is forced.",
    inputSchema: S(
      {
        script: {
          type: 'string',
          description: 'A menu name from orchestrator_menu, e.g. "chats" or "migrate_chat".',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments for that script, one per element, no shell quoting.',
        },
        timeout_secs: { type: 'number' },
        background: {
          type: 'boolean',
          description:
            'true: answer AT ONCE with `operationId` instead of waiting up to 45s for the verdict first - for anything you know runs long (migrate_batch, courier over several chats, loop --live, a --idle-wait that sleeps out a window). Then poll `orchestrator_operation {id}` for the same result the blocking call would have returned. false: block until the script finishes, however long - only for a caller whose transport can wait, since a call your client drops (at about 60s) loses the verdict for work that keeps running. Omit it for the auto rule.',
        },
        idempotency_key: {
          type: 'string',
          description:
            "A caller-chosen key that makes a RETRY of this exact request return the ORIGINAL operation instead of starting a second act. Pass one whenever the script MUTATES and you might retry it (a dropped connection, a timeout you are unsure about): it is the difference between reading the first run's verdict and running the act twice.",
        },
      },
      ['script'],
    ),
    run: async (a) => {
      const timeoutMs = a.timeout_secs != null ? Number(a.timeout_secs) * 1000 : undefined
      // ⛔ A LONG BLOCKING RUN LOSES ITS OWN REPORT (2026-09-11). `sweep --all --yes` with
      // timeout_secs 1200 (and again 1800) answered only "The operation timed out" while the
      // sweep ran five minutes to completion in the daemon: no stdout, no exit code, and - the
      // part that actually hurt - no operationId, so the finished verdict could not even be
      // fetched afterwards. The detached path already existed; the caller simply had to know
      // to ask for it, which is a rail nobody can follow the first time. A caller that DECLARES
      // a run longer than this now gets detached automatically, with the id and how to poll it.
      // An explicit `background: false` is still honoured - that is someone who wants to wait.
      // Every other run is detached on the wire and waited on for at most MCP_WAIT_MAX_MS
      // (2026-09-30: the desktop app's MCP client drops a call at about 60 s, and an undeclared
      // run carries the daemon's 10-minute default).
      const detach =
        a.background === true || (a.background == null && (timeoutMs ?? 0) > AUTO_DETACH_MS)
      const run = await runScript(
        {
          script: a.script,
          args: Array.isArray(a.args) ? a.args : [],
          timeoutMs,
          idempotencyKey:
            typeof a.idempotency_key === 'string' && a.idempotency_key.trim()
              ? a.idempotency_key.trim()
              : undefined,
        },
        detach ? 'detach' : a.background === false ? 'block' : 'wait',
      )
      if (run.detached !== true) return run
      return detachedAnswer(
        run,
        a.background === true
          ? 'Running in the daemon. Poll the id above for stdout, the exit code and the verdict; kept for an hour unless the daemon restarts, which wipes the record while the run itself carries on.'
          : detach
            ? `Detached automatically: you declared timeout_secs ${Number(a.timeout_secs)}, longer than an MCP client will hold a connection open, and a call the client abandons loses the report for work that keeps running. Poll the id above for the full result; pass background:false if you really do want to block.`
            : stillRunningNote(`orchestrator ${str(a.script)}`),
      )
    },
  },
  {
    name: 'orchestrator_operation',
    listed: true,
    description:
      "Reads an orchestrator run by its operationId: status (running, done or failed), stdout, exit code and verdict. Use it when a call timed out: the daemon keeps a finished run's result for an hour, so do not re-run the act. Omit id to list recent operations, which is how you find an id you never saw. A reason of daemon-restarted means the record was lost in a restart: do not re-fire the act; check its effect instead (migrate_reconcile lists chats left half-moved). orchestrator_cancel stops a run that is still going. Read-only.",
    inputSchema: S({
      id: {
        type: 'string',
        description:
          'The operationId to poll. Omit to LIST recent operations - do that when a call timed out and you never saw its id.',
      },
    }),
    run: async (a) =>
      api(
        typeof a.id === 'string' && a.id.trim()
          ? `/api/orchestrator/operations/${encodeURIComponent(a.id.trim())}`
          : '/api/orchestrator/operations',
      ),
  },
  {
    name: 'orchestrator_cancel',
    description:
      "MUTATES: stops a run that is still going. It is the counterpart to orchestrator_operation, which only reads. The run's whole process tree is killed, and its outcome then reads cancelled. Use it to get out of a batch launched with the wrong scope or sitting in a long wait. Before this existed, the only way was to find the pid by hand, which is outside every rail. Cancel is not an undo: whatever the run already did stays done. Chats a migrate_batch already landed stay landed on the target, and nothing moves back. Cancel stops only the remainder. The per-item report dies with the process, so a cancelled batch never returns its per-chat results. Establish what happened by reading the fleet afterwards (list_chats on the source and the target), never by assuming. A chat killed mid-move is the real hazard, because imports are serialised; prefer cancelling a batch that is still waiting or between chats, and verify the in-flight chat by name afterwards. Cancelling also frees the route lock, which the daemon keys by script name, so a corrected call (a narrower chat list, or the same move with terminate_live) can run at once instead of getting 409 busy. A finished operation is left as it is, and cancelling it is a no-op that returns its recorded status, so it is safe when you are unsure whether it still runs. An unknown id answers 404.",
    inputSchema: S(
      {
        id: {
          type: 'string',
          description:
            'The operationId to stop - the one every backgrounded orchestrator_run / move_chats answered with. Lost it? `orchestrator_operation {}` with no id lists the recent runs, newest first.',
        },
      },
      ['id'],
    ),
    run: async (a) => {
      const id = typeof a.id === 'string' ? a.id.trim() : ''
      if (!id) return { ok: false, error: 'id is required (the operationId of the run to stop)' }
      return api(`/api/orchestrator/operations/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        headers: JSON_HEADERS,
      })
    },
  },
  {
    name: 'orchestrator_loop',
    description:
      "The orchestration loop. By default it is a dry run: it walks the whole orchestration (census, waiting scan, accounts and usage bands, the sweep's four lanes, naming, reconcile, the judgment queue) and prints what it would do, touching nothing. Stalled chats, holds, collisions, hand-offs and pending deliveries are reported here. Stop and investigate if its census sanity check fails or the plan says INCOMPLETE: a read failed, so every lane is only a lower bound. live true mutates. It runs the same walk with the acting lanes armed, the same as sweep --all --yes, and that does nothing unless the tray icon is up. A live walk answers at once with an operationId, since it runs for minutes; a dry run that takes longer than 45 seconds answers the same way. Poll orchestrator_operation {id} for the plan or the report.",
    inputSchema: S({
      live: { type: 'boolean', description: 'Act instead of plan. Default false (dry).' },
      json: { type: 'boolean', description: 'Machine-readable plan (dry only).' },
    }),
    run: async (a) => {
      const args: string[] = []
      if (a.live === true) args.push('--live')
      else if (a.json === true) args.push('--json')
      const run = await runScript(
        { script: 'loop', args, timeoutMs: a.live === true ? 30 * 60_000 : undefined },
        a.live === true ? 'detach' : 'wait',
      )
      return run.detached === true
        ? detachedAnswer(
            run,
            a.live === true
              ? 'The live walk is running in the daemon (it can take many minutes). Poll the id above for its report.'
              : stillRunningNote('The dry walk'),
          )
        : run
    },
  },
  {
    name: 'orchestrator_switch',
    description:
      "The tray-icon switch. The owner's rule is that nothing acts without the status-bar icon, so the owner can always stop it. armed is read-only, and it is the first thing to check before expecting any act to land, because a disarmed fleet looks exactly like a healthy quiet one. The other actions change the switch. arm puts the icon up paused: registered, nothing acts yet. arm_now arms and starts the lanes. resume turns the switch on. pause stops the lanes but keeps the icon and dashboard up. disarm closes the icon and stops everything. Use arm only when the person's message is their own hand on the switch, never to allow unattended acts on your own initiative.",
    inputSchema: S(
      {
        action: {
          type: 'string',
          enum: ['armed', 'arm', 'arm_now', 'resume', 'pause', 'disarm'],
        },
      },
      ['action'],
    ),
    run: async (a) => {
      const action = str(a.action)
      const argv: Record<string, string[]> = {
        armed: ['armed'],
        arm: ['arm'],
        arm_now: ['arm', '--now'],
        resume: ['resume'],
        pause: ['pause'],
        disarm: ['disarm'],
      }
      const words = argv[action]
      if (!words) throw new Error(`action must be one of ${Object.keys(argv).join(', ')}`)
      const [script, ...args] = words
      const run = await runScript({ script, args, timeoutMs: 120_000 })
      return run.detached === true
        ? detachedAnswer(run, stillRunningNote(`orchestrator_switch ${action}`))
        : run
    },
  },
  {
    name: 'unblock_prompts',
    description:
      "MUTATES: answers a permission prompt that a chat is stopped on while its engine is mid-turn. Use it for a chat that has sat on Allow, Accept or Continue for ten minutes, where only a human click restarts it. Call it on a stall. fan_out_send refuses a member whose engine reads working, and a chat frozen on a prompt does read working, so more text cannot clear it; this presses the button instead. session names one chat (or several) and narrows every stage to it. Without it, this is the fleet-wide sweep, so pass session whenever you mean one chat. Nothing is pressed unless the tray icon is up: check orchestrator_switch armed first, since a disarmed fleet silently downgrades to plan-only and says so in the output. Naming a chat is not consent. A chat is pressed only where its own configured mode is bypassPermissions (or the toolbox spawned it with bypass promised), it is not held, its last words are visible in the pane, and the pending command itself classifies APPROVE against approval_policy.json. A hard-destructive command (rm -rf, force-push, a credential path) is denied and left stuck however it was invoked. A command the policy does not place is escalated to the judgment queue rather than pressed on a guess. force is the owner's word: it presses an escalated one after showing the command, and it is the documented bypass of the tray switch for one run. For a set_session_permission_mode app card, name the calling chat that is waiting, not the target whose mode changes, and invoke from another chat or the independent unblock lane. Existing bypass settings may be restored automatically; new increases need the explicit decision path. The actuator matches the target and mode card and uses Allow once. An approval receipt alone does not prove the new mode took effect. dry_run true reports what would be pressed and touches nothing. The answer gives stuck (every waiting chat with its verdict and command), results (per press: approved, no prompt showing, or could not reach that pane), denied, queuedForJudgment, and notFound, meaning a chat you named that is not waiting on anything. That is how you tell cleared from never stuck.",
    inputSchema: S({
      session: {
        type: ['string', 'array'],
        items: { type: 'string' },
        description:
          'Session id(s) to clear. Omit ONLY when you mean the whole-fleet sweep; a manager steering one chat should always pass this.',
      },
      dry_run: {
        type: 'boolean',
        description: 'Report what would be pressed and press nothing. Default false (act).',
      },
      force: {
        type: 'boolean',
        description:
          "A PERSON's word, for one run: press an ESCALATED prompt after showing its command, and act without the tray icon. Pass it only when the human asked for this act.",
      },
      max: { type: 'number', description: 'Cap how many prompts one run presses (default 6).' },
      min_wait_secs: {
        type: 'number',
        description:
          'How long a chat must have been quiet to count as stuck. Defaults to 0 when `session` is given (you have already looked at that chat) and 240 for a sweep, where the wait is what stops a click landing on a command that is merely still running.',
      },
    }),
    run: async (a) => {
      const sessions = (Array.isArray(a.session) ? a.session : a.session == null ? [] : [a.session])
        .map(str)
        .map((s) => s.trim())
        .filter(Boolean)
      const act = a.dry_run !== true
      const scan: string[] = ['--json']
      for (const sid of sessions) scan.push('--session', sid)
      if (a.min_wait_secs != null) scan.push('--min-wait', String(Number(a.min_wait_secs)))
      if (a.max != null) scan.push('--max', String(Number(a.max)))

      // The plan and the press share ONE wait budget, so the whole call answers inside it.
      const deadline = Date.now() + MCP_WAIT_MAX_MS
      const runUnblock = (args: string[], timeoutMs: number) =>
        runScript(
          { script: 'unblock_prompts', args, timeoutMs },
          'wait',
          deadline - Date.now(),
        ) as Promise<{ stdout?: string; stderr?: string; exitCode?: number; detached?: boolean }>
      const report = (r: { stdout?: string }): Record<string, unknown> | null => {
        try {
          const parsed: unknown = JSON.parse(String(r.stdout ?? ''))
          return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
        } catch {
          return null
        }
      }

      // ⛔ PROVE THE NARROWING BEFORE PRESSING ANYTHING (the reason `supports` exists — see
      // SUPPORTS in unblock_prompts.py). The daemon runs whatever orchestrator copy is INSTALLED
      // beside it, not necessarily the one this tool shipped with, and that script reads argv by
      // lookup: a copy predating `--session` IGNORES it and sweeps the whole fleet instead. With
      // `--yes` attached, the failure mode of a version skew is pressing prompts in chats nobody
      // named. So a targeted ACT plans first and refuses unless the script names the flag itself.
      if (sessions.length && act) {
        const planned = await runUnblock(scan, 5 * 60_000)
        if (planned.detached === true)
          return detachedAnswer(
            planned,
            `The planning scan that must run before any press is still running after ${MCP_WAIT_MAX_MS / 1000}s. NOTHING WAS PRESSED. Poll the id above until it is done, then call unblock_prompts again.`,
          )
        const plan = report(planned)
        const supports = Array.isArray(plan?.supports) ? (plan.supports as unknown[]).map(str) : []
        if (!supports.includes('session'))
          throw new Error(
            'refusing to press: the orchestrator answering this daemon predates `--session`, so it ' +
              'would IGNORE the chat you named and sweep the whole fleet with --yes. Update the ' +
              'orchestrator beside the running daemon (or point AGENTHYDRA_ORCHESTRATOR_DIR at a ' +
              'checkout that has it) and call again. Nothing was pressed.',
          )
      }

      const args = [...scan]
      if (act) args.push('--yes')
      if (a.force === true) args.push('--force')
      const result = await runUnblock(args, 20 * 60_000)
      if (result.detached === true)
        return detachedAnswer(
          result,
          stillRunningNote(act ? 'The press' : 'The scan') +
            " Its report is the JSON on the operation's stdout.",
        )
      return { ...result, report: report(result) }
    },
  },
]

export const SERVER_INFO = { name: 'agenthydra', version: VERSION }

/** The same tool set, with the identity tools bound to whoever sent THIS request.
 *
 * The stdio transport needs nothing of the sort: there, the server IS a child of the calling
 * engine, so "this process" and "the caller" share an ancestry. Over HTTP they are different
 * processes on the same machine, and only the route that owns the socket can say which one asked
 * - so it hands that answer in here rather than letting the identity tools guess from a process
 * that happens to be the daemon (see detectForCaller in mcp-self.ts). */
export function toolsForCaller(getCallerPid: () => Promise<number | null>): McpEngineTool[] {
  // Only the identity tools (and hydra_run, which can run them) are rebound; every other entry is
  // the SAME object (pinned by mcp-caller-identity.test.ts). The side-run wrapper is applied by the
  // HTTP route on top of this.
  const bind = (args: Record<string, unknown>) => ({ ...args, [CALLER_PID_ARG]: getCallerPid })
  return TOOLS.map((t) => {
    if (CALLER_AWARE_TOOLS.has(t.name))
      return {
        ...t,
        run: (args: Record<string, unknown>, signal?: AbortSignal) => t.run(bind(args), signal),
      }
    // hydra_run runs the bare tool (mcp-find.ts), so an identity tool it names gets the binding in
    // its own arguments. Without it the tool took the daemon for its caller: 2026-10-11, a Desk chat
    // dispatched ten workers through hydra_run { tool: 'climayte_run' }, each recorded no origin,
    // and the chat showed none of them running.
    if (t.name === 'hydra_run')
      return {
        ...t,
        run: (a: Record<string, unknown>, signal?: AbortSignal) => {
          if (!CALLER_AWARE_TOOLS.has(str(a.tool).trim())) return t.run(a, signal)
          const args =
            a.args && typeof a.args === 'object' && !Array.isArray(a.args)
              ? (a.args as Record<string, unknown>)
              : {}
          return t.run({ ...a, args: bind(args) }, signal)
        },
      }
    return t
  })
}

/*
 * STANDING INSTRUCTIONS, handed to the model in the MCP `initialize` handshake, before it calls
 * anything.
 *
 * WHY THIS EXISTS. A tool description is only read once the model has already decided to call that
 * tool, which is useless for the behaviour that matters here: checking your quota BEFORE the
 * expensive thing, and saving your work BEFORE you are cut off. Neither is discoverable from a
 * tool list. Without this block those rules had to be typed into a human's prompt every session,
 * and the one session where nobody typed them is the session that runs out of quota mid-task.
 *
 * WHY IT IS THIS SHORT. It is in context for the entire session, on every request, so every line
 * is rent. Rules only, no explanation, no API shapes (docs/AI_USAGE_SELFCHECK.md holds the
 * reasoning). If a line would not change what an agent DOES, it does not belong here.
 */
/** CliMayte's idle room for a quota check's answer: an agent reading its own quota is deciding how
 *  to do its work, and idle CLI accounts are the cheapest place for a self-contained piece of it
 *  (owner, 2026-10-02: ten sat idle for six hours). Nothing when the daemon is down (CliMayte runs
 *  only there) or nothing is idle. */
async function climayteRoom(): Promise<{ climayte?: { idleAccounts: number; hint: string } }> {
  try {
    const cap = (await apiOrLocal('/api/corch/capacity', async () => null)) as {
      idle?: number
      waiting?: number
      waitUntil?: string | null
    } | null
    const idle = cap?.idle ?? 0
    const waiting = cap?.waiting ?? 0
    const many = waiting !== 1
    // `idle` is already the accounts a new task would start on now (roomNow), so a waiting row
    // does not take that room: it may wait for its own account's reset or sit in a 10 s retry.
    if (idle >= 1) {
      const also =
        waiting > 0 ? ` ${waiting} task${many ? 's' : ''} already wait${many ? '' : 's'}.` : ''
      return {
        climayte: {
          idleAccounts: idle,
          hint: `${idle} CLI account${idle === 1 ? ' sits' : 's sit'} idle with room; climayte_run can take self-contained Claude-quality work (AgentHydra picks the account).${also}`,
        },
      }
    }
    if (waiting < 1) return {}
    // No room and work already waits: more would queue behind it (2026-10-02 04:58, 24 waiting).
    const at = cap?.waitUntil ? new Date(cap.waitUntil).toLocaleTimeString() : null
    return {
      climayte: {
        idleAccounts: idle,
        hint: `${waiting} CliMayte task${many ? 's' : ''} already wait${many ? '' : 's'}${at ? ` until ${at}` : ''}; new work queues behind ${many ? 'them' : 'it'}.`,
      },
    }
  } catch {
    return {}
  }
}

export const SERVER_INSTRUCTIONS = `AgentHydra runs every Claude and Codex account on this PC and knows how much each has left. This list shows the most used tools. hydra_find searches all of them by plain words and gives each one's exact call; hydra_run { tool, args } runs an unlisted one.

Check your own quota before heavy work, without being asked: check_my_usage {} takes about 300 ms. If its advice says shouldOffload, write your context, findings and next steps to a file now and hand what is left to climayte_run. If safeToFanOut is false, shrink or postpone the work, judging current and projected cost together, since a launched fan_out cannot be recalled. usage_budget {} says whether the cap will bite before it resets (exhaustsBeforeReset). Weekly usually binds; on Pro the 5-hour window does. A severity of 'unknown' or a failed read is not headroom.

Always name the account when you quote a percentage. A number a person gives you for an instance overrules the detection. list_usage {} shows every account. Tools that change state say MUTATES: in their description.

Give Claude-quality work to climayte_run {tasks:[{prompt, cwd}]}: self-contained tasks on idle CLI accounts. fan_out {tasks:[{cwd, prompt}]} opens visible chats on other accounts; fan_out_status reads them and fan_out_send steers them. Delete a probe chat you create afterwards with hydra_run { tool: 'fan_out_delete', args: { group } }. move_chat moves a chat to another account. add_queue_item and launch_terminal_session refuse every call.

Change a Hydra Desk chat's folder or title with desk_chat {cwd, title}. Start a dev server with dev_servers {action:"start", cwd}, which reuses the copy already running, rather than from the shell.`

/** The stdio loop, callable from main.ts's `--mcp` subcommand (the compiled exe's MCP mode). */
export function runMcp(): Promise<void> {
  return runMcpStdio({
    serverInfo: SERVER_INFO,
    // Projection + size guard beneath the side-run warning, so the warning rides on the shaped
    // answer instead of being projected away (mcp-output.ts); the call budget outermost, so it
    // times the whole call.
    tools: withRenamedTools(
      withUnlistedTools(
        withCallBudget(withDaemonWarning(withOutputShaping(TOOLS))),
        UNLISTED_TOOLS,
      ),
      RENAMED_TOOLS,
    ),
    instructions: SERVER_INSTRUCTIONS,
  })
}

/** Old tool names still answered (never listed): a chat keeps the tool list it got at its start,
 *  but its MCP process restarts onto new code with the daemon, so after a rename every call by the
 *  old name failed with "Unknown tool" mid-run (2026-10-01, Corch -> CliMayte: the orchestrator of
 *  a live run lost every corch_* tool and carried on through the HTTP routes). */
export const RENAMED_TOOLS: Readonly<Record<string, string>> = Object.fromEntries(
  TOOLS.filter((t) => t.name.startsWith('climayte_')).map((t) => [
    t.name.replace(/^climayte_/, 'corch_'),
    t.name,
  ]),
)

/** `tools` with old names answered: the stdio engine (shared server-lib mcp-stdio.mjs, synced from
 *  the kit, so not edited here) lists `tools` with `map` and looks a call up with `find(predicate)`;
 *  this array's `find` tries each old name against the predicate when no current tool matches, so a
 *  renamed tool is answered by its old name and listed only once. mcp-renamed-tools.test.ts drives
 *  it through the engine itself, so a change there that bypasses `find` fails a test. */
export function withRenamedTools<T extends { name: string }>(
  tools: T[],
  renamed: Readonly<Record<string, string>>,
): T[] {
  const list = [...tools]
  const find = (pred: (t: T) => unknown): T | undefined => tools.find((t) => pred(t))
  Object.defineProperty(list, 'find', {
    value: (pred: (t: T) => unknown): T | undefined => {
      const hit = find(pred)
      if (hit) return hit
      for (const [old, current] of Object.entries(renamed))
        if (pred({ name: old } as T)) return find((t) => t.name === current)
      return undefined
    },
  })
  return list
}

/** Tools that refuse every call. Never listed, so no agent spends a turn on one; still answered by
 *  name, so a caller that names one gets the refusal. */
export const REFUSING_TOOLS: ReadonlySet<string> = new Set(
  TOOLS.filter((t) => t.refuses).map((t) => t.name),
)

/** The tools listed directly: each says `listed: true` on its own definition (HydraTool, mcp-client.ts). Every other
 *  one is reached with hydra_find / hydra_run (mcp-find.ts) and still answered by name. Owner, 2026-10-11: keep the
 *  tool list small, the Connections way; the first set was picked from the agenthydra calls in every transcript on
 *  this PC that day (105 tools, 35k tokens of schemas; the listed ones carried over 95% of the calls).
 *  AGENTHYDRA_MCP_ALL_TOOLS=1 lists everything. */
export const LISTED_TOOLS: ReadonlySet<string> = new Set(
  TOOLS.filter((t) => t.listed).map((t) => t.name),
)

/** Every tool the listing leaves out: the refusing ones always, and the unlisted rest unless asked for all. */
export const UNLISTED_TOOLS: ReadonlySet<string> = new Set([
  ...REFUSING_TOOLS,
  ...(process.env.AGENTHYDRA_MCP_ALL_TOOLS === '1'
    ? []
    : TOOLS.map((t) => t.name).filter((n) => !LISTED_TOOLS.has(n))),
])

/** `tools` without the unlisted names in its listing; `find` still reaches every tool. */
export function withUnlistedTools<T extends { name: string }>(
  tools: T[],
  unlisted: ReadonlySet<string>,
): T[] {
  const list = tools.filter((t) => !unlisted.has(t.name))
  Object.defineProperty(list, 'find', {
    value: (pred: (t: T) => unknown): T | undefined => tools.find((t) => pred(t)),
  })
  return list
}

// Only run the stdio loop when this file is the entry point (`bun run mcp`), not when a test
// imports TOOLS/daemonBase — Bun sets import.meta.main false for module imports.
if (import.meta.main) {
  await runMcp()
}
