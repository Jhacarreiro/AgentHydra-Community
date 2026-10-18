// server/tests/climayte-chat.test.ts — a chat worker (task `chat: true`) launches like the owner's
// own `claude`, not like a delegated worker (owner, 2026-10-04: a chat asked to answer a company
// drafted the mail and handed it back, because its worker brief told it to report, not act).
//
// No account is signed in here, so every worker waits; the argv is built from the worker record the
// dispatch made, by the same function a launch uses.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteRun,
  climayteSend,
  killsLanded,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  setCliMayteOwnerDir,
} from '../src/climayte'
import { workers } from '../src/climayte-core'
import {
  CHAT_NOTE,
  cliArgv,
  workerEnv,
  writeWorkerMcp,
  writeWorkerSettings,
} from '../src/climayte-launch'
import { type CliMayteAccount, DRONE_BRIEF, LIGHT_BRIEF, WORKER_BRIEF } from '../src/climayte-lib'

const scratch = mkdtempSync(join(tmpdir(), 'climayte-chat-'))
// The owner's `.claude` sits in a home of its own; the chat's folder is outside it, so the CLI's
// CLAUDE.md walk does not reach the owner's file and the launch has to carry it.
const HOME = join(scratch, 'home')
const OWNER = join(HOME, '.claude')
const CWD = join(scratch, 'repo')
const OWNER_RULES = 'Read Connections first: call lane_brief.'
// Hydra Core's folder, off (no ON file) unless a test turns it on: the real one is on wherever core mode is live.
const CORE = join(scratch, 'core')
const savedCoreDir = process.env.AGENTHYDRA_CORE_DIR

beforeAll(() => {
  mkdirSync(OWNER, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  mkdirSync(CORE, { recursive: true })
  process.env.AGENTHYDRA_CORE_DIR = CORE
  writeFileSync(join(OWNER, 'CLAUDE.md'), OWNER_RULES)
  setCliMayteAccountsProvider(() => [])
  setCliMayteClaudeCommand(['claude'])
  setCliMayteOwnerDir(OWNER)
})
afterAll(async () => {
  climayteCancel({ group: 'chat-test' })
  await killsLanded()
  setCliMayteOwnerDir(null)
  setCliMayteClaudeCommand(null)
  setCliMayteAccountsProvider(null)
  if (savedCoreDir === undefined) delete process.env.AGENTHYDRA_CORE_DIR
  else process.env.AGENTHYDRA_CORE_DIR = savedCoreDir
  rmSync(scratch, { recursive: true, force: true })
})

const dispatch = (task: Record<string, unknown>) => {
  const reply = climayteRun({
    group: 'chat-test',
    tasks: [{ prompt: 'Answer the company', cwd: CWD, ...task }],
  })
  const w = workers.get(reply.workers[0]?.id ?? '')
  if (!w) throw new Error('no worker made')
  return w
}

const valueAfter = (argv: string[], flag: string): string | undefined =>
  argv[argv.indexOf(flag) + 1]

describe('chat workers', () => {
  test('every worker launches with its role, so the Hydra Core hook can skip seats and drones', () => {
    const chat = dispatch({ title: 'a chat', chat: true })
    const prime = workerEnv(chat, 'C:/Users/me/.claude')
    expect(prime.AGENTHYDRA_ROLE).toBe('prime')
    expect(prime.AGENTHYDRA_CLIMAYTE_CHAT).toBe('1')
    expect(
      workerEnv({ ...chat, role: 'seat', persona: 'person:example' }, 'C:/Users/me/.claude')
        .AGENTHYDRA_ROLE,
    ).toBe('seat')
    expect(workerEnv(dispatch({ title: 'a drone' }), 'C:/Users/me/.claude').AGENTHYDRA_ROLE).toBe(
      'drone',
    )
  })

  test('a chat gets no worker brief, the owner instructions and skills, and Opus xhigh', () => {
    const w = dispatch({ title: 'a chat', chat: true })
    expect(w).toMatchObject({ chat: true, effort: 'xhigh' })
    expect(w.model).toContain('opus')
    expect(w.auto).toBeUndefined()

    const argv = cliArgv(w, 'sid', false, 'hooks.json', null)
    expect(argv).not.toContain(WORKER_BRIEF)
    expect(argv).not.toContain('--append-system-prompt')
    expect(valueAfter(argv, '--effort')).toBe('xhigh')
    expect(valueAfter(argv, '--add-dir')).toBe(HOME)
    const prompt = readFileSync(valueAfter(argv, '--append-system-prompt-file') ?? '', 'utf8')
    expect(prompt.startsWith(CHAT_NOTE)).toBe(true)
    expect(prompt).toContain(OWNER_RULES)
    expect(prompt).not.toContain('a CliMayte worker')
  })

  test("a Desk chat's add-ons: its servers (the owner's of a name win) and its append, once", () => {
    writeFileSync(
      join(HOME, '.claude.json'),
      JSON.stringify({
        mcpServers: { shared: { type: 'http', url: 'http://owner.example.test/mcp' } },
      }),
    )
    const media = 'To show the person a picture, GIF or video, put it in your reply'
    const w = dispatch({
      title: 'a desk chat',
      chat: true,
      desk: {
        append: `Desk text. ${media}, as the Desk words it.`,
        mcpServers: {
          redesign: { type: 'http', url: 'http://desk.example.test/mcp' },
          shared: { type: 'http', url: 'http://desk.example.test/other' },
        },
      },
    })
    const file = writeWorkerMcp(w) ?? ''
    const servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers
    expect(servers.redesign.url).toBe('http://desk.example.test/mcp')
    expect(servers.shared.url).toBe('http://owner.example.test/mcp')

    const argv = cliArgv(w, 'sid', false, 'hooks.json', file)
    const prompt = readFileSync(valueAfter(argv, '--append-system-prompt-file') ?? '', 'utf8')
    expect(prompt.split('Desk text.').length).toBe(2)
    expect(prompt.split(media).length).toBe(2)
    expect(prompt.indexOf('the manager the owner talks to')).toBeLessThan(
      prompt.indexOf('Desk text.'),
    )
    expect(prompt.indexOf('Desk text.')).toBeLessThan(prompt.indexOf(OWNER_RULES))
    rmSync(join(HOME, '.claude.json'))
  })

  test("a message brings a chat's add-ons as they are now, so a chat started before them gets them", () => {
    const w = dispatch({ title: 'an old chat', chat: true })
    expect(w.desk).toBeUndefined()
    const desk = {
      append: 'Design first.',
      mcpServers: { redesign: { type: 'http', url: 'http://desk.example.test/mcp' } },
    }
    expect(climayteSend(w.id, 'show me options', { desk }).ok).toBe(true)
    expect(w.desk).toEqual(desk)
    expect(JSON.parse(readFileSync(writeWorkerMcp(w) ?? '', 'utf8')).mcpServers.redesign.url).toBe(
      'http://desk.example.test/mcp',
    )

    const task = dispatch({ title: 'a task' })
    expect(climayteSend(task.id, 'hi', { desk })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/only for a chat/),
    })
    expect(
      climayteSend(w.id, 'hi', { desk: { append: 'x'.repeat(20_001), mcpServers: {} } }).ok,
    ).toBe(false)
    expect(w.desk).toEqual(desk)
  })

  test('a chat without desk keeps the media sentence once', () => {
    const w = dispatch({ title: 'plain chat', chat: true })
    const argv = cliArgv(w, 'sid', false, 'hooks.json', null)
    const prompt = readFileSync(valueAfter(argv, '--append-system-prompt-file') ?? '', 'utf8')
    expect(prompt.split('To show the person a picture').length).toBe(2)
  })

  test('desk is refused without chat, and a longer append is refused, not cut', () => {
    const desk = { append: 'x', mcpServers: {} }
    expect(() => dispatch({ title: 'not a chat', desk })).toThrow(/only for a chat/)
    expect(() =>
      dispatch({ chat: true, desk: { append: 'x'.repeat(20_001), mcpServers: {} } }),
    ).toThrow(/at most 20000/)
    expect(
      dispatch({ chat: true, desk: { append: 'x'.repeat(20_000), mcpServers: {} } }).desk,
    ).toBeDefined()
  })

  test("a chat's heir launches on the model and effort the chat had", () => {
    const w = dispatch({ title: 'heir', chat: true, model: 'opus', effort: 'max' })
    const first = cliArgv(w, 'sid', false, 'hooks.json', null)
    const heir = cliArgv(w, 'sid2', false, 'hooks.json', null)
    for (const flag of ['--model', '--effort'])
      expect(valueAfter(heir, flag)).toBe(valueAfter(first, flag))
    expect(valueAfter(heir, '--effort')).toBe('max')
  })

  test("an ordinary worker's argv is what it was: the worker brief, no chat flags", () => {
    const w = dispatch({ title: 'a task', model: 'sonnet', effort: 'medium', ownerWords: 'fixed' })
    expect(w.chat).toBeUndefined()
    const argv = cliArgv(w, 'sid', false, 'hooks.json', 'mcp.json')
    expect(argv).toEqual([
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--session-id',
      'sid',
      '--model',
      w.model as string,
      '--effort',
      'medium',
      '--mcp-config',
      'mcp.json',
      '--settings',
      'hooks.json',
      '--append-system-prompt',
      `${WORKER_BRIEF} ${DRONE_BRIEF}`,
    ])
  })

  // 2026-10-13: manager_open and desk_chat answered "this process is not a Desk chat" in a Desk chat run as a CliMayte
  // chat: the owner's agenthydra entry (HTTP) won over the Desk's and carried no chat id.
  test("a Desk chat's agenthydra server is told which Desk chat calls it", () => {
    writeFileSync(
      join(HOME, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          agenthydra: { type: 'http', url: 'http://127.0.0.1:3747/api/mcp' },
          other: { type: 'http', url: 'http://other.example.test/mcp' },
        },
      }),
    )
    const desk = { append: 'Desk text.', mcpServers: {}, chatId: 'desk-chat-1' }
    const w = dispatch({ title: 'a desk chat with an id', chat: true, desk })
    const servers = JSON.parse(readFileSync(writeWorkerMcp(w) ?? '', 'utf8')).mcpServers
    expect(servers.agenthydra.headers).toEqual({ 'x-hydra-desk-chat': 'desk-chat-1' })
    expect(servers.other.headers).toBeUndefined()

    const plain = dispatch({ title: 'a chat with no Desk', chat: true })
    const own = JSON.parse(readFileSync(writeWorkerMcp(plain) ?? '', 'utf8')).mcpServers
    expect(own.agenthydra.headers).toBeUndefined()
    rmSync(join(HOME, '.claude.json'))
  })

  // 2026-10-13: Manager Hydra's router (a UserPromptSubmit hook in the owner's settings) never ran in a CliMayte chat: its
  // account folder has settings of its own, and the launch carried only the guards.
  test("a chat carries the owner's Manager Hydra router hook; a worker does not", () => {
    // As managers/install.mjs writes it on Windows.
    const router = { type: 'command', command: 'node "C:\\x\\managers\\router.mjs"' }
    writeFileSync(
      join(OWNER, 'settings.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'python other_hook.py' }] },
            { hooks: [router] },
          ],
        },
      }),
    )
    const acct = { configDir: join(scratch, 'acct') } as CliMayteAccount
    const prompts = (file: string) =>
      JSON.parse(readFileSync(file, 'utf8')).hooks.UserPromptSubmit as unknown
    const chat = dispatch({ title: 'a routed chat', chat: true })
    expect(prompts(writeWorkerSettings(chat, acct))).toEqual([{ hooks: [router] }])
    const worker = dispatch({ title: 'a task' })
    expect(prompts(writeWorkerSettings(worker, acct))).toBeUndefined()
    rmSync(join(OWNER, 'settings.json'))
    const unrouted = dispatch({ title: 'a chat, no router installed', chat: true })
    expect(prompts(writeWorkerSettings(unrouted, acct))).toBeUndefined()
  })

  // 2026-10-13: core mode leaves every CLAUDE.md holding only the Hydra Core line, which orders a core_scope call a
  // worker (no AgentHydra MCP, no chat key) cannot make; its settings leave both files out.
  test("in core mode a worker's settings leave out the account's and the owner's CLAUDE.md", () => {
    writeFileSync(join(CORE, 'ON'), '')
    writeFileSync(join(CORE, 'excludes.json'), JSON.stringify(['C:/p/**/CLAUDE.md']))
    const acct = { configDir: join(scratch, 'acct') } as CliMayteAccount
    const excludes = (file: string) =>
      JSON.parse(readFileSync(file, 'utf8')).claudeMdExcludes as unknown
    const core = dispatch({ title: 'a core task' })
    rmSync(join(CORE, 'ON'))
    expect(excludes(writeWorkerSettings(core, acct))).toBeUndefined()
    writeFileSync(join(CORE, 'ON'), '')
    expect(excludes(writeWorkerSettings(core, acct))).toEqual([
      join(scratch, 'acct', 'CLAUDE.md').replace(/\\/g, '/'),
      join(OWNER, 'CLAUDE.md').replace(/\\/g, '/'),
      'C:/p/**/CLAUDE.md',
    ])
    rmSync(join(CORE, 'ON'))
  })

  // 2026-10-13: Hydra Core's president rule (a Stop hook) reached the owner's terminal sessions only; a Desk chat
  // launches with its own settings and never ran it.
  test('in core mode a chat stops through the Hydra Core hook; a worker does not', () => {
    const acct = { configDir: join(scratch, 'acct') } as CliMayteAccount
    const stops = (file: string) =>
      (JSON.parse(readFileSync(file, 'utf8')).hooks.Stop ?? []) as Array<{
        hooks: Array<{ type: string; command?: string }>
      }>
    const isCore = (g: { hooks: Array<{ command?: string }> }) =>
      g.hooks.some((h) => h.command?.endsWith('hydra-core/hook.mjs"'))
    const chat = dispatch({ title: 'a core chat', chat: true })
    const worker = dispatch({ title: 'a core worker task' })
    expect(stops(writeWorkerSettings(chat, acct)).some(isCore)).toBe(false)
    writeFileSync(join(CORE, 'ON'), '')
    expect(stops(writeWorkerSettings(chat, acct)).some(isCore)).toBe(true)
    const workerStops = stops(writeWorkerSettings(worker, acct))
    expect(workerStops.some(isCore)).toBe(false)
    expect(workerStops.map((g) => g.hooks[0]?.type)).toEqual(['http'])
    rmSync(join(CORE, 'ON'))
  })

  // 2026-10-13: HSwarm's edit-only builders waited behind the CPU gate with the build-and-test workers; a light
  // worker runs nothing, and starts none of the owner's MCP servers (each a process per worker).
  test("a light worker launches with no shell and no MCP server but CliMayte's own", () => {
    writeFileSync(
      join(HOME, '.claude.json'),
      JSON.stringify({ mcpServers: { heavy: { command: 'node', args: ['server.js'] } } }),
    )
    const w = dispatch({ title: 'an edit', light: true })
    const file = writeWorkerMcp(w) ?? ''
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers)).toEqual([
      'climayte-worker',
    ])
    const argv = cliArgv(w, 'sid', false, 'hooks.json', file)
    expect(argv).toContain('--strict-mcp-config')
    const at = argv.indexOf('--disallowedTools')
    expect(argv.slice(at, at + 3)).toEqual(['--disallowedTools', 'Bash', 'PowerShell'])
    expect(argv[at + 3]?.startsWith('--')).toBe(true) // the variadic list ends at an option
    expect(valueAfter(argv, '--append-system-prompt')).toContain(LIGHT_BRIEF)
    expect(() => dispatch({ title: 'x', light: true, chat: true })).toThrow(/not a chat/)
    expect(() => dispatch({ title: 'x', light: true, commit: true })).toThrow(/no shell to commit/)
    rmSync(join(HOME, '.claude.json'))
  })
})
