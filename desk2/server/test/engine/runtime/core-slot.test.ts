// An in-process Desk chat under Hydra Core's slot or file placement gets its pack in the appended system prompt, built
// and kept by the chat's Desk id (placement.json), as a CliMayte chat launch does; its Claude process carries
// HYDRA_DESK_CHAT_ID so the hook keys its messages by the same chat; and a new session in the chat keeps its lead.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import type { ChatSummary, DeskSettings } from '@shared/protocol'
import { ChatRuntime } from '../../../src/engine/chat-runtime'
import { coreSlot } from '../../../src/engine/core-slot'
import { ChatStore } from '../../../src/engine/store'
import { type CoreFixture, coreFixture } from '../../fixtures/hydra-core'

const SETTINGS = {
  defaultModel: null, defaultEffort: null, defaultPermissionMode: 'default', defaultAccountId: 'auto', delegateToCliMayte: false,
  idleCloseMinutes: 30, browserIdleMinutes: 15, notifications: true, projectFolders: [], projectRoots: [], hiddenProjects: [],
  pinnedProjects: [], babysitter: true, instanceManager: true, orchestrator: false, orchestratorModel: 'opus', routines: true, collapseMode: 'off', coreEngine: false,
} as DeskSettings

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CHAT = '0d6b2a51-7c1e-4f3a-9b8e-1a2b3c4d5e6f'

let home: string
let store: ChatStore
let core: CoreFixture | null = null

beforeEach(() => {
  // core-place.ts runs in a child: no lead-pick call leaves this machine under test.
  process.env.AGENTHYDRA_LEAD_MODEL = 'off'
  home = mkdtempSync(join(tmpdir(), 'desk-core-slot-'))
  store = new ChatStore(home, { debounceMs: 1 })
})

afterEach(() => {
  delete process.env.AGENTHYDRA_LEAD_MODEL
  core?.done()
  core = null
  if (home) rmSync(home, { recursive: true, force: true })
})

function chat(over: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: CHAT, sessionId: null, title: 'Invented chat', cwd: 'C:/Users/me/app', account: { id: 'default', label: 'Default', configDir: null },
    accountAuto: false, model: null, effort: null, permissionMode: 'default', delegateToCliMayte: false, status: 'closed', activity: null,
    turnStartedAt: null, lastError: null, limitResetsAt: null, unread: false, pinned: false, archived: false, group: null, forkedFrom: null,
    createdAt: 1, updatedAt: 1, costUsd: 0, contextPct: null, pendingCount: 0, queuedCount: 0, climayteActive: 0, ...over,
  }
}

/** Sends `text` as the chat's message and returns the options its query was started with (the slot is placed first, in a child). */
async function launch(over: Partial<ChatSummary>, text: string): Promise<Options> {
  let seen: Options | undefined
  const rt = new ChatRuntime({
    chat: chat(over),
    store,
    emit: () => {},
    queryImpl: ({ options }) => {
      seen = options
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }), close() {}, interrupt: async () => {} } as unknown as Query
    },
    env: { PATH: '/bin' },
    settings: SETTINGS,
    agentHydraMcp: null,
  })
  rt.send(text)
  for (let waited = 0; !seen && waited < 20_000; waited += 10) await Bun.sleep(10)
  if (!seen) throw new Error('the query was not started')
  return seen
}

const append = (o: Options) => (o.systemPrompt as { append: string }).append
const placed = (dir: string) => JSON.parse(readFileSync(join(dir, 'chats', CHAT, 'placement.json'), 'utf8'))

test('a fresh chat under slot gets its slot by Desk chat id, launched with the session placement.json records', async () => {
  core = coreFixture({ on: true, placement: 'slot' })
  const o = await launch({}, 'sketch the dashboard layout')
  expect(o.env?.HYDRA_DESK_CHAT_ID).toBe(CHAT)
  expect(append(o)).toContain('Ada Example: invented brief for dashboard layouts.')
  expect(o.sessionId).toMatch(UUID)
  const p = placed(core.dir)
  expect(p).toMatchObject({ placement: 'slot', lead: 'person:ada-layout', prompt: 'sketch the dashboard layout' })
  expect(p.started).toEqual([o.sessionId])
})

test('a new session in the chat (a handoff) keeps the lead its first message picked', async () => {
  core = coreFixture({ on: true, placement: 'slot' })
  await launch({}, 'sketch the dashboard layout')
  const next = await launch({ sessionId: 'b1c2d3e4-0000-4000-8000-000000000001' }, 'now edit the release notes copy')
  expect(next.resume).toBe('b1c2d3e4-0000-4000-8000-000000000001')
  expect(next.sessionId).toBeUndefined()
  expect(append(next)).toContain('Ada Example: invented brief for dashboard layouts.')
  expect(append(next)).not.toContain('Bo Example')
  expect(placed(core.dir).started).toContain('b1c2d3e4-0000-4000-8000-000000000001')
})

test('under file placement the prompt names the pack file', async () => {
  core = coreFixture({ on: true, placement: 'file' })
  const o = await launch({}, 'sketch the dashboard layout')
  expect(append(o)).toContain(join(core.dir, 'chats', CHAT, 'pack.md'))
  expect(readFileSync(join(core.dir, 'chats', CHAT, 'pack.md'), 'utf8')).toContain('Ada Example')
})

test('no slot with core mode off, under attach, or for a sub-chat; the chat id still reaches the hook', async () => {
  core = coreFixture({ placement: 'slot' })
  const off = await launch({}, 'sketch the dashboard layout')
  expect(off.env?.HYDRA_DESK_CHAT_ID).toBe(CHAT)
  expect(off.sessionId).toBeUndefined()
  expect(append(off)).not.toContain('Ada Example')
  core.done()
  core = coreFixture({ on: true, placement: 'attach' })
  expect(append(await launch({}, 'sketch the dashboard layout'))).not.toContain('Ada Example')
  core.done()
  core = coreFixture({ on: true, placement: 'slot' })
  expect(append(await launch({ parentId: 'a-parent-chat' }, 'sketch the dashboard layout'))).not.toContain('Ada Example')
  expect(existsSync(join(core.dir, 'chats', CHAT, 'placement.json'))).toBe(false)
})

test('the Desk server keeps serving while a chat places its slot: a timer fires before the placement is back', async () => {
  core = coreFixture({ on: true, placement: 'slot' })
  const started = performance.now()
  let placedMs = 0
  const slot = coreSlot({ chat: CHAT, session: 'c1d2e3f4-0000-4000-8000-000000000002', fresh: true, cwd: 'C:/Users/me/app', prompt: 'sketch the dashboard layout', rest: 0 })
  void slot.then(() => { placedMs = performance.now() - started })
  const tickMs = await new Promise<number>((r) => setTimeout(() => r(performance.now() - started), 10))
  expect(placedMs).toBe(0)
  expect(tickMs).toBeLessThan(200)
  expect(await slot).toContain('Ada Example')
})

