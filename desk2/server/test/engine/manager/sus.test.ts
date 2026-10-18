// The sus level through the manager (SPEC "Sus meter"): fine is today's behaviour, sus runs on the setting that
// pushes back least, bad pins Codex, and a refusal is counted and never sent again.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AccountInfo, TranscriptItem } from '@shared/protocol'
import { ChatManager, ChatError, climayteSetting, parsePatch, restoreSetting } from '../../../src/engine/chat-manager'
import type { CodexDirectory } from '../../../src/engine/codex/accounts'
import type { OpenAppServer, ThreadListener } from '../../../src/engine/codex/app-server'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const SID = 'sus-session-0001'
const state = (s: 'running' | 'idle'): SDKMessage => ({ type: 'system', subtype: 'session_state_changed', state: s, uuid: `s-${s}-${Math.random()}`, session_id: SID }) as unknown as SDKMessage
const reply = (text: string, model: string): SDKMessage => ({ type: 'assistant', uuid: `a-${Math.random()}`, session_id: SID, parent_tool_use_id: null, message: { id: 'm1', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: null } }) as unknown as SDKMessage
const result = (stop: string): SDKMessage => ({ type: 'result', subtype: 'success', is_error: false, uuid: `r-${Math.random()}`, session_id: SID, duration_ms: 5, total_cost_usd: 0, num_turns: 1, result: '', stop_reason: stop }) as unknown as SDKMessage

const ALPHA = { id: 'cx-alpha', num: 7, name: 'alpha', codexHome: 'C:/Users/me/.agenthydra/codex-instances/cx-alpha', loggedIn: true }

/** The home's pushback file: model-good has 30 turns and 1 pushback, model-poor 30 turns and 15. */
function seed(home: string): void {
  const row = (model: string, effort: string, turns: number, pushback: number) => [`k-${model}`, { service: 'claude', model, effort, turns, pushback, refusals: 0 }] as const
  const settings = Object.fromEntries([row('model-good', 'low', 30, 1), row('model-poor', 'high', 30, 15)])
  writeFileSync(join(home, 'pushback.json'), JSON.stringify({ v: 1, settings, backfilled: [] }))
}

async function setup(o: { seeded?: boolean; codex?: boolean } = {}) {
  const home = temp('desk-sus-home-')
  const cwd = temp('desk-sus-cwd-')
  mkdirSync(cwd, { recursive: true })
  process.env.HYDRA_DESK_HOME = home
  if (o.seeded !== false) seed(home)
  const account: AccountInfo = { id: 'acct-1', label: '#1 user (Pro)', configDir: temp('desk-sus-acct-'), number: 1, email: null, plan: 'Pro', signedIn: true, fiveHourPct: 10, weeklyPct: 10, fiveHourResetsAt: null, weeklyResetsAt: null, inUse: false }
  const codex: CodexDirectory | undefined = o.codex ? { instances: async () => [ALPHA], usage: async () => ({ snapshot: { session: { pct: 10 }, weekAll: { pct: 5 } } }) } : undefined
  const q = fakeQueries()
  const bridge = { ...fakeBridge({ roots: [] }).bridge, listAccounts: async () => [account] }
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => ({ ...DEFAULT_SETTINGS }), bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk', ...(codex ? { codex } : {}) })
  managers.push(m)
  return { m, q, cwd, home }
}
const base = { accountId: 'acct-1', permissionMode: 'bypassPermissions' as const }

test('a chat left on fine runs on its own model and effort', async () => {
  const { m, q, cwd } = await setup()
  const chat = await m.create({ cwd, prompt: 'go', model: 'model-own', effort: 'medium', ...base })
  await waitFor(() => q.all.length === 1)
  const o = q.last().options
  expect(o.model).toBe('model-own')
  expect(o.effort).toBe('medium')
  expect(m.get(chat.id).sus ?? 'fine').toBe('fine')
  expect(m.get(chat.id).susPick).toBeUndefined()
})

test('sus runs the next turn on the least-pushing setting, adds nothing to the system text, and says what it picked', async () => {
  const { m, q, cwd } = await setup()
  const chat = await m.create({ cwd, model: 'model-own', effort: 'medium', ...base })
  const patched = await m.patch(chat.id, { sus: 'sus' })
  expect(patched.sus).toBe('sus')
  expect(patched.susPick).toEqual({ model: 'model-good', effort: 'low', pushbackRate: 1 / 30, turns: 30 })
  await m.send(chat.id, 'deploy it')
  await waitFor(() => q.all.length === 1)
  const o = q.last().options
  expect(o.model).toBe('model-good')
  expect(o.effort).toBe('low')
  expect((o.systemPrompt as { append: string }).append).toBe((q.all[0]!.options.systemPrompt as { append: string }).append)
  expect((o.systemPrompt as { append: string }).append).not.toContain('authorized work')
  // The chat's own setting is untouched, so fine still means what it did.
  expect(m.get(chat.id)).toMatchObject({ model: 'model-own', effort: 'medium' })
})

test('sus with no setting at 20 turns falls back to the chat own setting', async () => {
  const { m, q, cwd } = await setup({ seeded: false })
  const chat = await m.create({ cwd, model: 'model-own', effort: 'medium', ...base })
  const patched = await m.patch(chat.id, { sus: 'sus' })
  expect(patched.susPick).toBeNull()
  await m.send(chat.id, 'go')
  await waitFor(() => q.all.length === 1)
  expect(q.last().options.model).toBe('model-own')
})

test('a finished turn is counted under the setting that ran it, and a refusal is never sent again', async () => {
  const { m, q, cwd } = await setup({ seeded: false })
  const chat = await m.create({ cwd, prompt: 'go', model: 'model-own', effort: 'medium', ...base })
  await waitFor(() => q.all.length === 1)
  const fake = q.last()
  fake.push(state('running'), reply("I can't help with that.", 'model-own-0001'), result('refusal'), state('idle'))
  await waitFor(() => m.get(chat.id).status === 'idle')
  expect(m.pushbackRows()).toEqual([{ service: 'claude', model: 'model-own-0001', effort: 'medium', turns: 1, pushback: 0, refusals: 1, pushbackRate: 0 }])
  await new Promise((r) => setTimeout(r, 50))
  expect(fake.sent.length).toBe(1)
  expect(q.all.length).toBe(1)
  expect(fake.calls.setModel).toEqual([])
})

test('a turn whose closing text pushes back counts as pushback', async () => {
  const { m, q, cwd } = await setup({ seeded: false })
  const chat = await m.create({ cwd, prompt: 'go', model: 'model-own', ...base })
  await waitFor(() => q.all.length === 1)
  q.last().push(state('running'), reply('Are you sure you want to touch your production server?', 'model-own-0001'), result('end_turn'), state('idle'))
  await waitFor(() => m.get(chat.id).status === 'idle')
  expect(m.pushbackRows()[0]).toMatchObject({ effort: 'default', turns: 1, pushback: 1, refusals: 0, pushbackRate: 1 })
})

test('bad pins the chat to Codex, fine or sus unpins it, and without Codex the patch is the 409', async () => {
  const none = await setup()
  const c0 = await none.m.create({ cwd: none.cwd, ...base })
  await expect(none.m.patch(c0.id, { sus: 'bad' })).rejects.toMatchObject({ status: 409, message: 'Codex is not set up in this Desk.' })
  expect(none.m.get(c0.id).sus).toBeUndefined()

  const { m, cwd } = await setup({ codex: true })
  const chat = await m.create({ cwd, ...base })
  expect((await m.patch(chat.id, { sus: 'bad' })).service).toBe('codex')
  expect(m.get(chat.id).sus).toBe('bad')
  const back = await m.patch(chat.id, { sus: 'sus' })
  expect(back.service ?? null).toBeNull()
  expect(back.sus).toBe('sus')
  await m.patch(chat.id, { sus: 'bad' })
  const fine = await m.patch(chat.id, { sus: 'fine' })
  expect(fine.service ?? null).toBeNull()
  expect(fine.sus).toBeUndefined()
})

test('a chat can be created on a level, and the patch parser takes only the three', async () => {
  const { m, cwd } = await setup({ codex: true })
  expect((await m.create({ cwd, sus: 'bad', ...base })).service).toBe('codex')
  expect((await m.create({ cwd, sus: 'sus', ...base })).sus).toBe('sus')
  expect(parsePatch({ sus: 'sus' })).toEqual({ sus: 'sus' })
  expect(() => parsePatch({ sus: 'worse' })).toThrow(ChatError)
})

test('the pushback list holds every setting with turns, lowest rate first', async () => {
  const { m } = await setup()
  expect(m.pushbackRows().map((r) => [r.model, r.pushbackRate])).toEqual([
    ['model-good', 1 / 30],
    ['model-poor', 0.5],
  ])
})

// CliMayte worker chats (the Desk's default): their turns run as a worker, not a ChatRuntime.

/** The home's pushback file with settings CliMayte's send can name: Sonnet high pushes back least. */
function seedClaude(home: string): void {
  const row = (model: string, effort: string, turns: number, pushback: number) => [`k-${model}`, { service: 'claude', model, effort, turns, pushback, refusals: 0 }] as const
  const settings = Object.fromEntries([row('claude-sonnet-5-5', 'high', 30, 1), row('claude-opus-5-5', 'xhigh', 30, 15)])
  writeFileSync(join(home, 'pushback.json'), JSON.stringify({ v: 1, settings, backfilled: [] }))
}

async function workerSetup(o: { seed?: 'claude' | 'unnamed' | 'none'; codex?: boolean } = {}) {
  const home = temp('desk-sus-worker-')
  process.env.HYDRA_DESK_HOME = home
  if ((o.seed ?? 'claude') === 'claude') seedClaude(home)
  if (o.seed === 'unnamed') seed(home)
  const b = fakeBridge({ roots: [] })
  const codexTurns: string[] = []
  const threads = new Map<string, ThreadListener>()
  const openCodex: OpenAppServer = async () => ({
    call: async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } } as T
      if (method === 'turn/start') {
        codexTurns.push(String((params.input as { text?: string }[])[0]?.text ?? ''))
        return { turn: { id: `turn-${codexTurns.length}` } } as T
      }
      return {} as T
    },
    listen: (threadId, l) => {
      threads.set(threadId, l)
      return () => threads.delete(threadId)
    },
    release: () => {},
  })
  const codex: CodexDirectory | undefined = o.codex ? { instances: async () => [ALPHA], usage: async () => ({ snapshot: { session: { pct: 10 }, weekAll: { pct: 5 } } }) } : undefined
  const make = (): ChatManager => {
    const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => ({ ...DEFAULT_SETTINGS }), bridge: b.bridge, queryImpl: fakeQueries().queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, ...(codex ? { codex, openCodex } : {}) })
    managers.push(m)
    return m
  }
  /** The Desk again on the same home and AgentHydra, the first one closed. */
  const restart = async (old: ChatManager): Promise<ChatManager> => {
    await old.closeAll()
    managers.splice(managers.indexOf(old), 1)
    return make()
  }
  /** Codex answers its latest turn with `text`. */
  const codexReply = (text: string): void => {
    const turnId = `turn-${codexTurns.length}`
    const l = threads.get('thread-1')!
    l.notify('item/completed', { threadId: 'thread-1', turnId, item: { type: 'agentMessage', id: `msg-${codexTurns.length}`, text } })
    l.notify('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed', durationMs: 5 } })
  }
  return { m: make(), b, home, codexTurns, codexReply, restart }
}

/** Each message the worker got, with the model and effort it carried (null: none). */
const sentSettings = (w: { b: ReturnType<typeof fakeBridge> }) => w.b.state.sentToWorker.map((s) => [s.text, s.setting ?? null])
const SONNET_HIGH = { model: 'sonnet', effort: 'high' }
/** The worker's own setting before Sus, as AgentHydra's worker record has it. */
const OWN = { reportedModel: 'claude-opus-5-5', model: 'opus', effort: 'high' }

/** A worker chat started with `prompt`, its worker running on `ran`. */
async function workerChat(w: Awaited<ReturnType<typeof workerSetup>>, req: { prompt: string; sus?: 'sus' | 'bad' }, ran = { reportedModel: 'claude-opus-5-5', effort: 'xhigh' }) {
  const chat = await w.m.create({ cwd: w.home, ...req })
  await waitFor(() => !!w.m.get(chat.id).workerId)
  const row = w.b.state.rows[0]!
  Object.assign(row, { status: 'running', ...ran })
  await w.m.syncWorkers(chat.id)
  return { chat, row }
}

const TURN: TranscriptItem[] = [
  { kind: 'user', id: 'u-1', ts: 9, text: 'Restart the production database' },
  { kind: 'assistant_text', id: 'a-1', ts: 10, text: "I can't help with that without a backup." },
]
const PUSHED = { service: 'claude' as const, model: 'claude-opus-5-5', effort: 'xhigh', turns: 1, pushback: 1, refusals: 0, pushbackRate: 1 }

test("a worker chat's finished turn is counted once, under the model and effort its attempt ran on", async () => {
  const w = await workerSetup({ seed: 'none' })
  const { chat, row } = await workerChat(w, { prompt: 'Restart the production database' })
  w.b.state.workerItems['worker-session-1'] = TURN
  Object.assign(row, { status: 'done' })
  await w.m.syncWorkers(chat.id)
  await waitFor(() => w.m.get(chat.id).status === 'idle')
  expect(w.m.pushbackRows()).toEqual([PUSHED])
  // Read again, and the backfill over the same transcript: the turn is not counted a second time.
  await w.m.syncWorkers(chat.id)
  expect(w.m.backfillPushback()).toEqual({ chats: 1, turns: 0 })
  expect(w.m.pushbackRows()).toEqual([PUSHED])
})

test('the backfill counts a worker chat by its transcript, leaving the turn still at work', async () => {
  const w = await workerSetup({ seed: 'none' })
  const { chat } = await workerChat(w, { prompt: 'Restart the production database' })
  w.b.state.workerItems['worker-session-1'] = [...TURN, { kind: 'user', id: 'u-2', ts: 11, text: 'There is one.' }, { kind: 'assistant_text', id: 'a-2', ts: 12, text: 'Restarting.' }]
  await w.m.syncWorkers(chat.id)
  expect(w.m.get(chat.id).status).toBe('working')
  expect(w.m.backfillPushback()).toEqual({ chats: 1, turns: 1 })
  expect(w.m.pushbackRows()).toEqual([PUSHED])
})

/** A worker chat whose first turn is over, on its own setting. */
async function idleWorkerChat(w: Awaited<ReturnType<typeof workerSetup>>, req: { prompt: string; sus?: 'sus' } = { prompt: 'go' }) {
  const { chat, row } = await workerChat(w, req, OWN)
  Object.assign(row, { status: 'done' })
  w.b.state.workerItems['worker-session-1'] = [{ kind: 'user', id: 'u-1', ts: 9, text: req.prompt }, { kind: 'assistant_text', id: 'a-1', ts: 10, text: 'Done.' }]
  await w.m.syncWorkers(chat.id)
  return chat
}

test('sus on a worker chat starts and sends its worker on the least-pushing setting; fine sends CliMayte its launch setting back once', async () => {
  const w = await workerSetup()
  const chat = await idleWorkerChat(w, { prompt: 'go', sus: 'sus' })
  expect(w.b.state.started[0]).toMatchObject({ model: 'sonnet', effort: 'high' })
  expect(w.m.get(chat.id)).toMatchObject({ sus: 'sus', susPick: { model: 'claude-sonnet-5-5', effort: 'high', pushbackRate: 1 / 30, turns: 30 } })
  // Started on the pick: it had no setting of its own, so it goes back to how CliMayte launches a Desk chat.
  expect(w.m.get(chat.id).susRestore).toEqual({ model: null, effort: null })
  await w.m.send(chat.id, 'again')
  await w.m.patch(chat.id, { sus: 'fine' })
  await w.m.send(chat.id, 'once more')
  await w.m.send(chat.id, 'and again')
  expect(sentSettings(w)).toEqual([
    ['again', SONNET_HIGH],
    ['once more', { model: 'opus', effort: 'xhigh' }],
    ['and again', null],
  ])
  expect(w.m.get(chat.id).susRestore).toBeUndefined()
})

test("leaving sus to fine sends a worker chat's own setting back once, then nothing", async () => {
  const w = await workerSetup()
  const chat = await idleWorkerChat(w)
  await w.m.patch(chat.id, { sus: 'sus' })
  await w.m.send(chat.id, 'a')
  await w.m.send(chat.id, 'b')
  expect(w.m.get(chat.id).susRestore).toEqual({ model: 'opus', effort: 'high' })
  await w.m.patch(chat.id, { sus: 'fine' })
  await w.m.send(chat.id, 'c')
  await w.m.send(chat.id, 'd')
  expect(sentSettings(w)).toEqual([
    ['a', SONNET_HIGH],
    ['b', SONNET_HIGH],
    ['c', { model: 'opus', effort: 'high' }],
    ['d', null],
  ])
})

test("leaving sus to bad sends nothing to the worker while on Codex, and its own setting back once after", async () => {
  const w = await workerSetup({ codex: true })
  const chat = await idleWorkerChat(w)
  await w.m.patch(chat.id, { sus: 'sus' })
  await w.m.send(chat.id, 'a')
  // Its reply to 'a' is in before the pin moves, so Codex is not waiting on it.
  const row = w.b.state.rows[0]!
  Object.assign(row, { status: 'running' })
  await w.m.syncWorkers(chat.id)
  w.b.state.workerItems['worker-session-1'] = [...w.b.state.workerItems['worker-session-1']!, { kind: 'user', id: 'u-2', ts: 11, text: 'a' }, { kind: 'assistant_text', id: 'a-2', ts: 12, text: 'Done again.' }]
  Object.assign(row, { status: 'done' })
  await w.m.syncWorkers(chat.id)
  await waitFor(() => w.m.get(chat.id).status === 'idle')
  await w.m.patch(chat.id, { sus: 'bad' })
  await w.m.send(chat.id, 'on codex')
  await waitFor(() => w.codexTurns.length === 1)
  w.codexReply('On it.')
  await waitFor(() => w.m.get(chat.id).status === 'idle')
  expect(w.m.get(chat.id).susRestore).toEqual({ model: 'opus', effort: 'high' })
  await w.m.patch(chat.id, { sus: 'fine' })
  await w.m.send(chat.id, 'b')
  await w.m.send(chat.id, 'c')
  // 'b' first carries what was said on Codex: its own words are its last line.
  expect(sentSettings(w).map(([text, set]) => [String(text).split('\n').at(-1), set])).toEqual([
    ['a', SONNET_HIGH],
    ['b', { model: 'opus', effort: 'high' }],
    ['c', null],
  ])
})

test('a restart keeps what a worker chat goes back to, and sus with no pick left sends it once', async () => {
  const w = await workerSetup()
  const chat = await idleWorkerChat(w)
  await w.m.patch(chat.id, { sus: 'sus' })
  await w.m.send(chat.id, 'a')
  // No setting qualifies after the restart: sus has nothing to send, so the worker goes back to its own.
  rmSync(join(w.home, 'pushback.json'))
  const m2 = await w.restart(w.m)
  expect(m2.get(chat.id)).toMatchObject({ sus: 'sus', susRestore: { model: 'opus', effort: 'high' } })
  await m2.send(chat.id, 'b')
  await m2.send(chat.id, 'c')
  expect(sentSettings(w)).toEqual([
    ['a', SONNET_HIGH],
    ['b', { model: 'opus', effort: 'high' }],
    ['c', null],
  ])
  expect(restoreSetting({ model: 'some-other-model', effort: 'default' })).toEqual({ model: 'opus', effort: 'xhigh' })
})

test('sus on a worker chat sends no override while no setting qualifies or the pick is one CliMayte cannot name', async () => {
  for (const seedAs of ['none', 'unnamed'] as const) {
    const w = await workerSetup({ seed: seedAs })
    const { chat } = await workerChat(w, { prompt: 'go', sus: 'sus' })
    expect(w.b.state.started[0]!.model).toBeUndefined()
    expect(w.b.state.started[0]!.effort).toBeUndefined()
    expect(w.m.get(chat.id).susPick ?? null).toEqual(seedAs === 'none' ? null : { model: 'model-good', effort: 'low', pushbackRate: 1 / 30, turns: 30 })
  }
  expect(climayteSetting('claude-haiku-5-5', 'medium')).toEqual({ model: 'haiku', effort: 'medium' })
  expect(climayteSetting('opus', 'default')).toBeNull()
  expect(climayteSetting('default', 'high')).toBeNull()
})

test('bad on a worker chat sends its next turns to Codex, and leaving it goes back to the worker', async () => {
  const w = await workerSetup({ codex: true })
  const { chat, row } = await workerChat(w, { prompt: 'Remember the word KIWI' })
  Object.assign(row, { status: 'done' })
  w.b.state.workerItems['worker-session-1'] = [{ kind: 'user', id: 'u-1', ts: 9, text: 'Remember the word KIWI' }, { kind: 'assistant_text', id: 'a-1', ts: 10, text: 'Noted: KIWI.' }]
  await w.m.syncWorkers(chat.id)
  expect(await w.m.patch(chat.id, { sus: 'bad' })).toMatchObject({ sus: 'bad', service: 'codex' })
  await w.m.send(chat.id, 'Which word?')
  await waitFor(() => w.codexTurns.length === 1)
  expect(w.codexTurns[0]).toContain('Noted: KIWI.')
  expect(w.b.state.sentToWorker).toEqual([])
  const back = await w.m.patch(chat.id, { sus: 'fine' })
  expect(back.service ?? null).toBeNull()
  expect(back.sus).toBeUndefined()
})

test('a worker chat is created on sus or bad', async () => {
  const w = await workerSetup({ codex: true })
  expect(await w.m.create({ cwd: w.home, sus: 'bad' })).toMatchObject({ sus: 'bad', service: 'codex', workerId: null })
  expect(await w.m.create({ cwd: w.home, sus: 'sus' })).toMatchObject({ sus: 'sus', workerId: null, susPick: { model: 'claude-sonnet-5-5' } })
})
