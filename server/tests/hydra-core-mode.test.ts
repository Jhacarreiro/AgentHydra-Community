// server/tests/hydra-core-mode.test.ts - core mode (the file <core dir>/ON): a CliMayte chat carries almost nothing.
// Flag off must leave the note, the owner CLAUDE.md, the router hook and the manager tools exactly as they were.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setCliMayteOwnerDir } from '../src/climayte'
import { CHAT_NOTE, chatPromptText, coreHookGroups } from '../src/climayte-launch'
import type { CliMayteWorker } from '../src/climayte-lib'
import { workerHooks } from '../src/climayte-signal'
import { coreChatExcludes, coreModeOn } from '../src/hydra-core-mode'
import { MANAGER_TOOLS } from '../src/mcp-managers'

const scratch = mkdtempSync(join(tmpdir(), 'hydra-core-mode-'))
const CORE = join(scratch, 'core')
const HOME = join(scratch, 'home')
const OWNER = join(HOME, '.claude')
const CWD = join(scratch, 'repo')
const OWNER_RULES = 'Read Connections first: call lane_brief.'
const CORE_NOTE =
  'The owner reads every reply you write. No terminal is attached, so nothing that waits for an interactive prompt or a permission dialog can be answered. Your process can end any time after your reply (when its last background command ends, or when the next owner message stops it), and everything it started in the background ends with it. Background sub-agents are refused: run sub-agents in the foreground (several Agent calls in one message run in parallel), and give work that must outlive the reply to climayte_run, which messages this chat when it finishes.'
const REFUSAL =
  'Core mode: sub-manager chats are off. Use core_use { chat, id, mode: "consult" | "hire" } to ask or hire a hidden copy.'

const savedCoreDir = process.env.AGENTHYDRA_CORE_DIR
const worker = (desk?: { append: string }) => ({ cwd: CWD, desk }) as unknown as CliMayteWorker
const CLI = { id: 'mode-session', resume: false }
const setFlag = (on: boolean) => {
  if (on) writeFileSync(join(CORE, 'ON'), '')
  else rmSync(join(CORE, 'ON'), { force: true })
}

beforeAll(() => {
  mkdirSync(OWNER, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  mkdirSync(CORE, { recursive: true })
  writeFileSync(join(OWNER, 'CLAUDE.md'), OWNER_RULES)
  process.env.AGENTHYDRA_CORE_DIR = CORE
  setCliMayteOwnerDir(OWNER)
})
afterAll(() => {
  setCliMayteOwnerDir(null)
  if (savedCoreDir === undefined) delete process.env.AGENTHYDRA_CORE_DIR
  else process.env.AGENTHYDRA_CORE_DIR = savedCoreDir
  rmSync(scratch, { recursive: true, force: true })
})

describe('flag off', () => {
  test('the chat note and the owner CLAUDE.md are as before', () => {
    setFlag(false)
    expect(coreModeOn()).toBe(false)
    const text = chatPromptText(worker(), CLI)
    expect(text.startsWith(CHAT_NOTE)).toBe(true)
    expect(text).toContain(OWNER_RULES)
  })

  test('no extra excludes, even with an excludes.json', () => {
    setFlag(false)
    writeFileSync(join(CORE, 'excludes.json'), JSON.stringify(['C:/extra/CLAUDE.md']))
    expect(coreChatExcludes()).toEqual([])
  })

  test('manager tools are not refused by core mode', async () => {
    setFlag(false)
    const ask = MANAGER_TOOLS.find((t) => t.name === 'manager_ask')
    await expect(ask?.run({ chat: 'c', message: '' })).rejects.toThrow('message is required')
  })
})

describe('flag on', () => {
  test('the chat note is the two core sentences, with no manager wording and no owner CLAUDE.md', () => {
    setFlag(true)
    const text = chatPromptText(worker(), CLI)
    expect(text).toBe(CORE_NOTE)
    expect(text).not.toContain(OWNER_RULES)
    expect(text).not.toMatch(/manager|orchestrat|successor/i)
  })

  test('the Desk append that a chat carries follows the note', () => {
    setFlag(true)
    const text = chatPromptText(worker({ append: 'DESK APPEND' }), CLI)
    expect(text).toBe(`${CORE_NOTE}\n\nDESK APPEND`)
  })

  test('excludes.json adds its paths for chats', () => {
    setFlag(true)
    writeFileSync(
      join(CORE, 'excludes.json'),
      JSON.stringify(['C:/extra/CLAUDE.md', 'D:/glob/**/*.md']),
    )
    expect(coreChatExcludes()).toEqual(['C:/extra/CLAUDE.md', 'D:/glob/**/*.md'])
  })

  test('a missing excludes.json adds nothing', () => {
    setFlag(true)
    rmSync(join(CORE, 'excludes.json'), { force: true })
    expect(coreChatExcludes()).toEqual([])
  })

  test('the chat hook is the Hydra Core hook, for the prompt and the session start', () => {
    setFlag(true)
    const groups = coreHookGroups()
    const command = groups[0]?.hooks[0]?.command ?? ''
    expect(command.startsWith('node "')).toBe(true)
    expect(command.endsWith('hydra-core/hook.mjs"')).toBe(true)
    const hooks = workerHooks({
      signalFile: 'x',
      claims: null,
      promptHooks: groups,
      sessionStartHooks: groups,
    })
    expect(hooks.UserPromptSubmit).toEqual(groups)
    expect(hooks.SessionStart).toEqual(groups)
  })

  test('without a session-start hook group, SessionStart is absent', () => {
    const hooks = workerHooks({ signalFile: 'x', claims: null, promptHooks: [] })
    expect('SessionStart' in hooks).toBe(false)
    expect('UserPromptSubmit' in hooks).toBe(false)
  })

  test('manager_open, manager_ask and manager_read refuse with one line', async () => {
    setFlag(true)
    for (const name of ['manager_open', 'manager_ask', 'manager_read']) {
      const tool = MANAGER_TOOLS.find((t) => t.name === name)
      await expect(
        tool?.run({ manager: 'x', prompt: 'p', chat: 'c', message: 'm' }),
      ).rejects.toThrow(REFUSAL)
    }
    setFlag(false)
  })
})
