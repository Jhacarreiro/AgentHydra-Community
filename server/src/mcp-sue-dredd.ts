// server/src/mcp-sue-dredd.ts - sue and dredd: the doors to Sue (simulated visitors) and Dredd (the judge that picks the
// review instruments). Both engines live in their own private checkout; these tools only start it on disk, never carry
// its code. The checkout is SUE_DREDD_HOME, else a folder named sue-dredd beside this AgentHydra checkout.
// Each call runs `node <checkout>/sue/sue.mjs <action> --json-file <file>` (Dredd: dredd/dredd.mjs and its flags,
// dredd/README.md) and hands back what the engine printed. A wave or a hearing outlives the call budget: it keeps
// running detached, and the answer names the file its output is going to.
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { APP_ROOT } from './config'
import { type HydraTool, MCP_CALL_BUDGET_MS, S, str } from './mcp-client'
import { folderOf } from './mcp-dashboards'

const WAIT_MS = MCP_CALL_BUDGET_MS - 8_000

export type Engine = 'sue' | 'dredd'

export type Launched =
  | { done: true; code: number | null; stdout: string; stderr: string }
  | { done: false; pid: number | undefined; outFile: string; errFile: string }

export interface LaunchOpts {
  cwd: string
  env: Record<string, string>
  waitMs: number
  /** Past waitMs: true leaves it running detached, false stops it. */
  keep: boolean
  /** Where its stdout and stderr go. */
  dir: string
}

export interface SueDreddDeps {
  env: Record<string, string | undefined>
  appRoot: string
  launch: (cmd: string, args: string[], opts: LaunchOpts) => Promise<Launched>
  /** The calling folder (the cwd argument, else the calling Desk chat's), or null when there is none. */
  folder: (a: Record<string, unknown>) => Promise<{ cwd: string; chatId: string | null } | null>
  tmp: () => string
}

const killTree = (pid: number | undefined) => {
  if (!pid) return
  if (process.platform === 'win32')
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
}

export const launchEngine = (cmd: string, args: string[], o: LaunchOpts) =>
  new Promise<Launched>((done) => {
    const outFile = join(o.dir, 'out.txt')
    const errFile = join(o.dir, 'err.txt')
    const out = openSync(outFile, 'w')
    const err = openSync(errFile, 'w')
    const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
    let settled = false
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
    })
    closeSync(out)
    closeSync(err)
    child.unref()
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      if (o.keep) return done({ done: false, pid: child.pid, outFile, errFile })
      killTree(child.pid)
      done({
        done: true,
        code: null,
        stdout: read(outFile),
        stderr: `${read(errFile)}\nstopped at the ${o.waitMs / 1000} s call budget`,
      })
    }, o.waitMs)
    const finish = (code: number | null, extra = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ done: true, code, stdout: read(outFile), stderr: read(errFile) + extra })
    }
    child.on('error', (e) => finish(null, `\n${e.message}`))
    child.on('exit', (code) => finish(code))
  })

const folder = async (a: Record<string, unknown>) => {
  try {
    const { cwd, chat } = await folderOf(a)
    return { cwd, chatId: chat?.id ?? null }
  } catch {
    return null
  }
}

const LIVE_DEPS: SueDreddDeps = {
  env: process.env,
  appRoot: APP_ROOT,
  launch: launchEngine,
  folder,
  tmp: () => mkdtempSync(join(tmpdir(), 'sue-dredd-door-')),
}

const ENTRY: Record<Engine, string> = {
  sue: join('sue', 'sue.mjs'),
  dredd: join('dredd', 'dredd.mjs'),
}

/** The sue-dredd checkout holding `engine`: SUE_DREDD_HOME, else sue-dredd beside the AgentHydra checkout. */
export function resolveCheckout(engine: Engine, env: SueDreddDeps['env'], appRoot: string): string {
  const fromEnv = str(env.SUE_DREDD_HOME).trim()
  const beside = join(dirname(resolve(appRoot)), 'sue-dredd')
  const tried = fromEnv ? [resolve(fromEnv), beside] : [beside]
  for (const home of tried) if (existsSync(join(home, ENTRY[engine]))) return home
  const env_ = fromEnv
    ? `SUE_DREDD_HOME (${resolve(fromEnv)}) has no ${ENTRY[engine]}`
    : 'SUE_DREDD_HOME is not set'
  throw new Error(
    `${engine} runs only from the sue-dredd checkout, and none was found: ${env_}, and ${beside} has no ${ENTRY[engine]}. ` +
      'Set SUE_DREDD_HOME to the checkout root, or clone it into a folder named sue-dredd beside AgentHydra. Nothing ran.',
  )
}

const parseJson = (text: string): unknown => {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

const tail = (r: { stdout: string; stderr: string; code: number | null }) =>
  (r.stderr.trim() || r.stdout.trim()).slice(-1200) || `exit ${r.code}`

const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? { ...(v as Record<string, unknown>) }
    : {}

const running = (
  engine: Engine,
  action: string,
  r: Extract<Launched, { done: false }>,
  extra: Record<string, unknown> = {},
) => ({
  ok: true,
  running: true,
  pid: r.pid ?? null,
  output: r.outFile,
  errors: r.errFile,
  note: `${engine} ${action} is still running past the ${WAIT_MS / 1000} s call budget, detached. Its answer is being written to output; ${engine === 'sue' ? "sue { action:'status', params:{ runId } }" : "dredd { action:'status', params:{ docket } }"} reads it once it names the run.`,
  ...extra,
})

/** One finished engine run as the tool's answer: its JSON, else its text when it succeeded, else an error. */
function answerOf(
  engine: Engine,
  action: string,
  r: Extract<Launched, { done: true }>,
  textOk: boolean,
): unknown {
  const json = parseJson(r.stdout)
  if (json !== null) return json
  if (textOk && r.code === 0 && r.stdout.trim()) return { ok: true, output: r.stdout.trim() }
  throw new Error(`${engine} ${action} answered no JSON (exit ${r.code}): ${tail(r)}`)
}

const ACTION = /^[a-z][a-z_-]*$/

// Sue's actions that start people, a field or a round: they run on detached past the call budget.
const SUE_STARTS = new Set([
  'run',
  'focus_group',
  'ape',
  'art',
  'inbox_test',
  'blind_round',
  'field',
])

// Dredd's actions: the long ones (a convened docket, a board meeting) run on detached; a hearing and a resolve
// detach in the engine itself (--detach) and come back with the docket in seconds.
const DREDD_ACTIONS = [
  'docket',
  'plan',
  'convene',
  'hearing',
  'resolve',
  'collect',
  'status',
  'stop',
  'dockets',
  'doctor',
  'bench',
  'boardroom',
]
const DREDD_LONG = new Set(['convene', 'collect', 'boardroom', 'hearing', 'resolve'])
const DREDD_NEEDS_DOCKET = new Set(['collect', 'resolve', 'status', 'stop'])

const PARAMS = {
  type: 'object',
  description: "The action's arguments, exactly as the engine takes them (its README).",
  additionalProperties: true,
}
const CWD_ARG = {
  type: 'string',
  description:
    "The folder the run belongs to (the engine's --workspace). Omit it inside a Desk chat.",
}

export function sueDreddTools(deps: SueDreddDeps = LIVE_DEPS): HydraTool[] {
  const launchEnv = (chatId: string | null): Record<string, string> => {
    const session = str(deps.env.CLAUDE_CODE_SESSION_ID).trim()
    return {
      SUE_LAUNCHED_VIA: 'mcp',
      ...(session ? { SUE_LAUNCHED_SESSION: session } : {}),
      ...(chatId ? { SUE_LAUNCHED_CHAT: chatId } : {}),
    }
  }

  async function sue(a: Record<string, unknown>) {
    const action = str(a.action).trim()
    if (action === 'move')
      throw new Error(
        "sue's 'move' is not served here: a chat-brain Sue moves with the engine's own sue/hand.mjs. Nothing ran.",
      )
    if (!ACTION.test(action))
      throw new Error(
        `action must be one of Sue's actions (run, status, report, personas, ...), not "${action}"`,
      )
    const home = resolveCheckout('sue', deps.env, deps.appRoot)
    const params = record(a.params)
    const here = await deps.folder(a)
    // A relative file is where the calling chat wrote it, not where the engine runs.
    if (typeof params.file === 'string' && here && !isAbsolute(params.file))
      params.file = resolve(here.cwd, params.file)
    const dir = deps.tmp()
    const argsFile = join(dir, 'args.json')
    writeFileSync(argsFile, JSON.stringify(params))
    // A blind round names its folder by project; every other action runs in the calling folder.
    const workspace =
      action === 'blind_round'
        ? params.workspace
          ? ['--workspace', str(params.workspace)]
          : []
        : here
          ? ['--workspace', here.cwd]
          : []
    const keep = SUE_STARTS.has(action)
    const r = await deps.launch(
      'node',
      [join(home, 'sue', 'sue.mjs'), action, ...workspace, '--json-file', argsFile],
      {
        cwd: here?.cwd || home,
        env: launchEnv(here?.chatId ?? null),
        waitMs: WAIT_MS,
        keep,
        dir,
      },
    )
    if (!r.done) return running('sue', action, r)
    if (!keep) rmSync(dir, { recursive: true, force: true })
    return answerOf('sue', action, r, false)
  }

  async function dredd(a: Record<string, unknown>) {
    const action = str(a.action).trim()
    if (!DREDD_ACTIONS.includes(action))
      throw new Error(`action must be one of ${DREDD_ACTIONS.join(', ')}, not "${action}"`)
    const home = resolveCheckout('dredd', deps.env, deps.appRoot)
    const p = record(a.params)
    if (action === 'bench')
      return JSON.parse(readFileSync(join(home, 'dredd', 'bench.json'), 'utf8'))
    const ask = str(p.ask).trim()
    const docket = str(p.docket).trim()
    if (DREDD_NEEDS_DOCKET.has(action) && !docket)
      throw new Error(
        `dredd '${action}' needs params.docket, the directory a previous convene or hearing returned ('dockets' lists them)`,
      )
    const reads =
      action === 'status' || action === 'stop' || action === 'dockets' || action === 'doctor'
    if (!reads && !ask && !docket)
      throw new Error(
        `dredd '${action}' needs params.ask (the person's own words) or params.docket`,
      )
    const dir = deps.tmp()
    const root = str(p.root).trim()
    const flags = root ? ['--root', root] : []
    let cmd = 'node'
    let argv: string[]
    if (action === 'boardroom') {
      cmd = 'bun'
      argv = [join(home, 'dredd', 'boardroom.mjs'), '--quiet', ...flags]
      if (docket) argv.push('--docket', docket)
      if (p.rounds != null)
        argv.push('--rounds', String(Math.max(1, Math.floor(Number(p.rounds)) || 1)))
      if (Array.isArray(p.seats) && p.seats.length)
        argv.push('--seats', p.seats.map(String).join(','))
      if (ask) argv.push(ask)
    } else {
      argv = [join(home, 'dredd', 'dredd.mjs'), ...flags]
      if (action === 'doctor') argv.push('--doctor')
      if (action === 'status' || action === 'stop' || action === 'dockets') argv.push(`--${action}`)
      if (action === 'plan') argv.push('--member')
      if (action === 'convene') argv.push('--convene')
      if (action === 'hearing') argv.push('--hearing', '--detach')
      if (action === 'resolve') argv.push('--resolve', '--detach')
      if (action === 'collect') argv.push('--collect')
      if (action === 'docket' || action === 'plan') argv.push('--json')
      if (docket) argv.push('--docket', docket)
      if (p.announce === true) argv.push('--announce')
      const url = str(p.url).trim()
      if (url) argv.push('--url', url)
      const runs = Array.isArray(p.run) ? p.run.map(String).join(',') : str(p.run).trim()
      if (runs) argv.push('--run', runs)
      if (action === 'status' && Number.isFinite(Number(p.fromLine)) && p.fromLine != null)
        argv.push('--from-line', String(Math.max(0, Math.floor(Number(p.fromLine)))))
      if (action === 'dockets' && Number.isFinite(Number(p.limit)) && p.limit != null)
        argv.push('--limit', String(Math.max(1, Math.floor(Number(p.limit)))))
      // The ask goes in a file: no shell quoting, and a detached hearing reads it from there.
      if (ask) {
        const askFile = join(dir, 'ask.txt')
        writeFileSync(askFile, ask)
        argv.push('--ask-file', askFile)
      }
    }
    const keep = DREDD_LONG.has(action)
    const r = await deps.launch(cmd, argv, {
      cwd: home,
      env: { DREDD_DOOR: 'mcp' },
      waitMs: WAIT_MS,
      keep,
      dir,
    })
    if (!r.done) return running('dredd', action, r, docket ? { docket } : {})
    if (!keep) rmSync(dir, { recursive: true, force: true })
    const answer = answerOf('dredd', action, r, true)
    if (
      (action === 'hearing' || action === 'resolve') &&
      typeof answer === 'object' &&
      answer !== null
    ) {
      const out = str((answer as { output?: unknown }).output)
      const dk = docket || /^Docket: (.+)$/m.exec(out)?.[1]?.trim() || null
      if (dk)
        return {
          ...(answer as object),
          docket: dk,
          poll: "dredd { action:'status', params:{ docket } } until verdict.md is in the answer; 'stop' ends it",
        }
    }
    return answer
  }

  return [
    {
      name: 'sue',
      callerChat: 'deskChat',
      description:
        "Runs Sue, the simulated website visitors, from the sue-dredd checkout on disk (SUE_DREDD_HOME, else sue-dredd beside AgentHydra): node sue/sue.mjs <action> with params as its JSON arguments, and returns the engine's JSON answer. A run, focus_group, ape, art, inbox_test, field or blind_round that is still going at the call budget keeps running detached; the answer names its output file. Actions and params: sue/README.md in that checkout. MUTATES when the action starts people or saves one.",
      inputSchema: S(
        {
          action: {
            type: 'string',
            description:
              'run | status | report | analytics | stop | personas | presue | save_persona | edit_persona | journal | scoreboard | profiles | focus_group | ape | art | room | room_say | watch | inbox_test | inbox_test_report | blind_round | field',
          },
          params: PARAMS,
          cwd: CWD_ARG,
        },
        ['action'],
      ),
      run: sue,
    },
    {
      name: 'dredd',
      callerChat: 'deskChat',
      description:
        'Asks Dredd, the judge that picks which review instruments to run for an ask, from the sue-dredd checkout on disk (SUE_DREDD_HOME, else sue-dredd beside AgentHydra), and returns its answer. params: ask, url, root, docket, run, announce, rounds, seats, fromLine, limit. A hearing and a resolve detach in the engine and return their docket; a convene, collect or boardroom still going at the call budget keeps running detached. Manual: dredd/README.md in that checkout. MUTATES when the action convenes, hears, resolves or stops.',
      inputSchema: S(
        {
          action: { type: 'string', enum: DREDD_ACTIONS, description: DREDD_ACTIONS.join(' | ') },
          params: PARAMS,
        },
        ['action'],
      ),
      run: dredd,
    },
  ]
}

export const SUE_DREDD_TOOLS: HydraTool[] = sueDreddTools()
