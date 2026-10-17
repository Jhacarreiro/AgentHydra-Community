// Pin service: a chat pinned to Codex runs each of its messages as a turn of a Codex thread on one of the owner's
// Codex accounts (a fake app-server here), and the turn's reply, commands and approvals land in the chat as any
// chat's do. A usage limit moves the message to another Codex account, whose new thread first reads a condensed
// handoff of the chat; pinned back to Claude, the next message carries what was said on Codex. A Codex chat run
// outside Desk continues here the same way, in its own thread on the account that holds it; another PC's chat (the
// Codex hub's) on that PC's Codex, in that PC's folder, and never on this machine's.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountInfo, ExternalSession, ServerEvent, TranscriptItem } from '@shared/protocol'
import type { FreeInstance, FreeJob, FreeResult } from '@shared/free-instances'
import type { AhCodexInstance } from '../../../src/bridge/client'
import type { FreeChats } from '../../../src/engine/chatgpt/runtime'
import { ChatManager, type ManagerBridge } from '../../../src/engine/chat-manager'
import { type CodexDirectory, codexDirectory } from '../../../src/engine/codex/accounts'
import { type OpenAppServer, relayHome, type ThreadListener } from '../../../src/engine/codex/app-server'
import { ANSWER_NOW, PIN_INTRO } from '../../../src/engine/handoff'
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

const ALPHA: AhCodexInstance = { id: 'cx-alpha', num: 7, name: 'alpha', codexHome: 'C:/Users/me/.agenthydra/codex-instances/cx-alpha', loggedIn: true }
const BETA: AhCodexInstance = { id: 'cx-beta', num: 8, name: 'beta', codexHome: 'C:/Users/me/.agenthydra/codex-instances/cx-beta', loggedIn: true }

/** App-servers the test drives: each records its calls and holds the thread listeners Desk registers. */
function fakeCodex(o: { resumeError?: string; up?: Promise<void> } = {}) {
  const servers: { home: string; calls: { method: string; params: Record<string, unknown> }[]; listeners: Map<string, ThreadListener>; released: boolean }[] = []
  let threads = 0
  let turns = 0
  let opening = 0
  const open: OpenAppServer = async (home) => {
    opening++
    // An app-server still starting answers once `up` settles.
    await o.up
    const s ={ home, calls: [] as { method: string; params: Record<string, unknown> }[], listeners: new Map<string, ThreadListener>(), released: false }
    servers.push(s)
    return {
      call: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        s.calls.push({ method, params })
        if (method === 'thread/start') return { thread: { id: `thread-${++threads}` } } as T
        if (method === 'turn/start') return { turn: { id: `turn-${++turns}` } } as T
        if (method === 'thread/resume' && o.resumeError) throw new Error(o.resumeError)
        return {} as T
      },
      listen: (threadId, l) => {
        s.listeners.set(threadId, l)
        return () => s.listeners.delete(threadId)
      },
      release: () => {
        s.released = true
      },
    }
  }
  /** The homes whose app-server a chat still holds. */
  const held = () => servers.filter((s) => !s.released).map((s) => s.home)
  const turnStarts = () => servers.flatMap((s) => s.calls.filter((c) => c.method === 'turn/start').map((c) => ({ home: s.home, ...c.params }) as { home: string; threadId: string; input: { text?: string }[] }))
  const thread = (id: string): ThreadListener => servers.findLast((s) => s.listeners.has(id))!.listeners.get(id)!
  const calls = (method: string): Record<string, unknown>[] => servers.flatMap((s) => s.calls.filter((c) => c.method === method).map((c) => ({ home: s.home, ...c.params })))
  return { open, turnStarts, thread, calls, held, opening: () => opening }
}

async function setup(o: { external?: ExternalSession[]; items?: Record<string, TranscriptItem[]>; resumeError?: string; free?: FreeChats; up?: Promise<void>; codex?: CodexDirectory } = {}) {
  const home = temp('desk-pin-home-')
  const cwd = temp('desk-pin-cwd-')
  mkdirSync(cwd, { recursive: true })
  process.env.HYDRA_DESK_HOME = home
  const account: AccountInfo = { id: 'acct-1', label: '#1 user (Pro)', configDir: temp('desk-pin-acct-'), number: 1, email: null, plan: 'Pro', signedIn: true, fiveHourPct: 10, weeklyPct: 10, fiveHourResetsAt: null, weeklyResetsAt: null, inUse: false }
  const codex: CodexDirectory = o.codex ?? {
    instances: async () => [ALPHA, BETA],
    usage: async (id) => ({ snapshot: { session: { pct: id === ALPHA.id ? 10 : 40 }, weekAll: { pct: 5 } } }),
  }
  const fake = fakeCodex({ resumeError: o.resumeError, up: o.up })
  const q = fakeQueries()
  const events: ServerEvent[] = []
  const bridge: ManagerBridge = { ...fakeBridge({ roots: [], external: o.external, items: o.items }).bridge, listAccounts: async () => [account] }
  const m = new ChatManager({ home, claudeHome: home, emit: (e) => events.push(e), settings: () => ({ ...DEFAULT_SETTINGS }), bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk', codex, openCodex: fake.open, free: () => o.free })
  managers.push(m)
  const chat = await m.create({ cwd, title: 'Pinned', accountId: 'acct-1', permissionMode: 'bypassPermissions' })
  return { m, q, fake, chat, cwd }
}

const systemTexts = (items: TranscriptItem[]) => items.flatMap((i) => (i.kind === 'system' ? [i.text] : []))

/** One Codex turn that replies `reply` and completes. */
async function codexTurn(fake: ReturnType<typeof fakeCodex>, m: ChatManager, chatId: string, text: string, reply: string) {
  const n = fake.turnStarts().length
  await m.send(chatId, text)
  await waitFor(() => fake.turnStarts().length > n)
  const start = fake.turnStarts().at(-1)!
  const turnId = `turn-${fake.turnStarts().length}`
  const l = fake.thread(start.threadId)
  l.notify('item/agentMessage/delta', { threadId: start.threadId, turnId, itemId: `msg-${turnId}`, delta: reply })
  l.notify('item/completed', { threadId: start.threadId, turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text: reply } })
  l.notify('turn/completed', { threadId: start.threadId, turn: { id: turnId, status: 'completed', durationMs: 900 } })
  await waitFor(() => m.get(chatId).status === 'idle')
  return start
}

test("a chat pinned to Codex runs its message on the emptiest Codex account, and the turn's command, approval and reply land in the chat", async () => {
  const { m, fake, chat } = await setup()
  expect((await m.services()).map((s) => [s.kind, s.ready, s.accounts])).toEqual([
    ['claude', true, 1],
    ['codex', true, 2],
    ['chatgpt', false, 0],
  ])
  await m.patch(chat.id, { service: 'codex' })
  expect(m.get(chat.id).service).toBe('codex')
  expect(systemTexts(m.listItems(chat.id))).toContain('This chat now runs on Codex.')

  await m.send(chat.id, 'Show me the status')
  await waitFor(() => fake.turnStarts().length === 1)
  const start = fake.turnStarts()[0]!
  // The emptiest account (alpha, 10% against 40%), the chat's own folder, its permission mode as Codex's policy.
  expect(start.home).toBe(ALPHA.codexHome)
  expect(start.input[0]!.text).toBe('Show me the status')
  expect(start).toMatchObject({ threadId: 'thread-1', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })

  const l = fake.thread('thread-1')
  const command = `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'git status'`
  l.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } })
  l.notify('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-1', command, status: 'inProgress' } })
  const answer = l.request('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command, reason: 'It reads the repository.' })
  await waitFor(() => m.get(chat.id).status === 'needs_you')
  const ask = m.listItems(chat.id).find((i) => i.kind === 'permission')!
  expect(ask).toMatchObject({ toolName: 'PowerShell', input: { command: 'git status' }, reason: 'It reads the repository.', state: 'pending' })
  m.respondPermission(chat.id, ask.id, { decision: 'allow' })
  expect(await answer).toEqual({ decision: 'accept' })

  l.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-1', command, status: 'completed', aggregatedOutput: 'nothing to commit', exitCode: 0 } })
  l.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'All ' })
  l.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'clean.' })
  l.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1', text: 'All clean.' } })
  l.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', durationMs: 1200 } })
  await waitFor(() => m.get(chat.id).status === 'idle')

  const items = m.listItems(chat.id)
  expect(items.find((i) => i.kind === 'tool_use' && i.id === 'cmd-1')).toMatchObject({ name: 'PowerShell', input: { command: 'git status' }, status: 'done', result: { text: 'nothing to commit', isError: false } })
  expect(items.find((i) => i.kind === 'permission')).toMatchObject({ state: 'allowed' })
  expect(items.filter((i) => i.kind === 'assistant_text').map((i) => i.text)).toEqual(['All clean.'])
  expect(items.find((i) => i.kind === 'result')).toMatchObject({ ok: true, durationMs: 1200 })
  expect(m.get(chat.id).serviceThreads?.codex).toEqual({ accountId: ALPHA.id, label: '#7 alpha', threadId: 'thread-1' })
})

test("a usage limit moves the message to another Codex account, whose new thread first reads the chat's record", async () => {
  const { m, fake, chat } = await setup()
  await m.patch(chat.id, { service: 'codex' })
  await codexTurn(fake, m, chat.id, 'Plan the release', 'Three steps: build, test, tag.')

  await m.send(chat.id, 'Do step one')
  await waitFor(() => fake.turnStarts().length === 2)
  fake.thread('thread-1').notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-2', status: 'failed', error: { message: 'You hit your limit.', codexErrorInfo: 'usageLimitExceeded' } } })
  await waitFor(() => fake.turnStarts().length === 3)

  const moved = fake.turnStarts()[2]!
  expect(moved.home).toBe(BETA.codexHome)
  expect(moved.threadId).toBe('thread-2')
  const text = moved.input[0]!.text!
  expect(text.startsWith(`${PIN_INTRO}Codex, which has not seen it yet: until now it ran on another Codex account (#7 alpha).`)).toBe(true)
  expect(text).toContain('Three steps: build, test, tag.')
  expect(text.endsWith(`${ANSWER_NOW}Do step one`)).toBe(true)
  expect(systemTexts(m.listItems(chat.id))).toContain('#7 alpha hit its Codex usage limit, so this chat goes on on another Codex account.')
  expect(m.get(chat.id).serviceThreads?.codex?.accountId).toBe(BETA.id)
})

test('pinned back to Claude by way of ChatGPT, which never ran, the next message carries what was said on Codex, and shows only what was typed', async () => {
  const { m, q, fake, chat } = await setup({ free: fakeFree([GPT(3, 'alpha', true)]).free })
  await m.patch(chat.id, { service: 'codex' })
  await codexTurn(fake, m, chat.id, 'Name the module', 'Call it ledger.')
  await m.patch(chat.id, { service: 'chatgpt' })
  await m.patch(chat.id, { service: null })
  expect(systemTexts(m.listItems(chat.id))).toContain('This chat runs on Claude again.')

  await m.send(chat.id, 'Write it')
  await waitFor(() => q.all.length === 1 && q.last().sent.length === 1)
  const sent = JSON.stringify(q.last().sent[0]!.message.content)
  expect(sent).toContain(`${PIN_INTRO}Claude, which has not seen it yet: until now it ran on Codex.`)
  expect(sent).toContain('Call it ledger.')
  const items = m.listItems(chat.id)
  expect(items.filter((i) => i.kind === 'user').map((i) => i.text)).toEqual(['Name the module', 'Write it'])
  expect(systemTexts(items)).toContain('Caught up on what was said on Codex.')
  // Caught up: the message after it carries nothing.
  expect(m.get(chat.id).serviceLeftAt?.claude).toBeUndefined()
})

test('a Codex chat run outside Desk continues here in its own thread, on the account that holds it, with no hand-off', async () => {
  const threadId = '0f0f0f0f-1111-4222-8333-444444444444'
  const earlier: TranscriptItem[] = [
    { kind: 'user', id: 'u-1', ts: 1, text: 'What changed?' },
    { kind: 'assistant_text', id: 'a-1', ts: 2, text: 'Two files.' },
  ]
  const outside = (cwd: string): ExternalSession => ({ id: threadId, title: 'From Codex', cwd, source: 'codex', instance: '#8 beta', status: 'idle', activity: null, lastActivityAt: 2, model: null, accountId: null, codexAccountId: BETA.id, canResume: true, fromPc: null, pinned: false, archived: false, unread: false, group: null })
  const cwd = temp('desk-pin-outside-')
  const { m, fake } = await setup({ external: [outside(cwd)], items: { [threadId]: earlier } })

  const chat = await m.importSession({ sessionId: threadId })
  expect(chat).toMatchObject({ service: 'codex', sessionId: null, cwd, serviceThreads: { codex: { accountId: BETA.id, label: '#8 beta', threadId } } })
  // A second import (another window) lands on the same chat; a fork is refused in a sentence.
  expect((await m.importSession({ sessionId: threadId })).id).toBe(chat.id)
  await expect(m.importSession({ sessionId: threadId, fork: true })).rejects.toThrow('This Codex chat continues in place: Fork works on Claude chats.')

  const start = await codexTurn(fake, m, chat.id, 'Carry on', 'Carrying on.')
  // Its own thread, resumed where it lives: the thread holds its history, so the message goes as typed.
  expect(start).toMatchObject({ home: BETA.codexHome, threadId })
  expect(start.input[0]!.text).toBe('Carry on')
  expect(fake.calls('thread/resume')).toEqual([expect.objectContaining({ home: BETA.codexHome, threadId })])
  expect(fake.calls('thread/start')).toEqual([])
  // Let go once the turn ends: Codex lets one program write a thread at a time, its Codex app is the other. The chat
  // holds no app-server between turns (its exit frees the thread at once) and unsubscribes the thread, which a server
  // other chats keep up unloads a minute later.
  expect(fake.held()).toEqual([])
  expect(fake.calls('thread/unsubscribe')).toEqual([{ home: BETA.codexHome, threadId }])
  expect(m.listItems(chat.id).filter((i) => i.kind === 'assistant_text').map((i) => i.text)).toEqual(['Two files.', 'Carrying on.'])
})

test("a Codex chat its Codex app holds open waits, in a sentence, and is never started over in a new thread", async () => {
  const threadId = '0f0f0f0f-1111-4222-8333-555555555555'
  const cwd = temp('desk-pin-held-')
  const outside: ExternalSession = { id: threadId, title: 'Held', cwd, source: 'codex', instance: '#8 beta', status: 'idle', activity: null, lastActivityAt: 2, model: null, accountId: null, codexAccountId: BETA.id, canResume: true, fromPc: null, pinned: false, archived: false, unread: false, group: null }
  const { m, fake } = await setup({ external: [outside], items: { [threadId]: [] }, resumeError: `thread ${threadId} already has an active writer` })
  const chat = await m.importSession({ sessionId: threadId })
  await m.send(chat.id, 'Carry on')
  await waitFor(() => m.listItems(chat.id).some((i) => i.kind === 'result'))
  expect(m.listItems(chat.id).find((i) => i.kind === 'result')).toMatchObject({ ok: false, error: 'The Codex app on #8 beta has this chat open, so only it can write to it now. Close the chat there, then send again.' })
  expect(fake.calls('thread/start')).toEqual([])
  expect(m.get(chat.id).serviceThreads?.codex?.threadId).toBe(threadId)
})

const OTHER_PC = 'hub:other-pc'

/**
 * The Codex hub's directory: this machine's accounts (alpha), then another PC behind the hub, its relay open while
 * `online()`. While `answering()` is false AgentHydra itself does not answer.
 */
const hubDirectory = (online: () => boolean, own: AhCodexInstance[] = [ALPHA], answering = () => true): CodexDirectory =>
  codexDirectory({
    codexInstances: async () => {
      if (!answering()) throw new Error('fetch failed')
      return own
    },
    codexUsage: async () => ({ snapshot: { session: { pct: 10 }, weekAll: { pct: 5 } } }),
    codexRelayPcs: async () => [{ id: OTHER_PC, pc: 'OTHER-PC', pushedAt: '', chats: 1, relay: online() }],
  })

/** A Codex chat the other PC pushed to the hub, in its own folder, as AgentHydra lists it. */
const hubChat = (id: string, cwd: string): ExternalSession => ({ id, title: 'From the other PC', cwd, source: 'codex', instance: 'OTHER-PC', status: 'idle', activity: null, lastActivityAt: 2, model: null, accountId: null, codexAccountId: OTHER_PC, canResume: true, fromPc: 'OTHER-PC', pinned: false, archived: false, unread: false, group: null })

test("another PC's Codex chat continues on that PC's Codex, in its folder as that PC names it, which this machine need not have", async () => {
  const onWindows = '0f0f0f0f-1111-4222-8333-666666666661'
  const onMac = '0f0f0f0f-1111-4222-8333-666666666662'
  const relative = '0f0f0f0f-1111-4222-8333-666666666663'
  const winCwd = 'C:\\Users\\me\\work\\ledger'
  const macCwd = '/Users/me/work/ledger'
  const external = [hubChat(onWindows, winCwd), hubChat(onMac, macCwd), hubChat(relative, 'work/ledger')]
  const { m, fake } = await setup({ external, items: { [onWindows]: [], [onMac]: [] }, codex: hubDirectory(() => true) })

  // As Desk's Continue asks for it: the folder the row names.
  const win = await m.importSession({ sessionId: onWindows, cwd: winCwd })
  const mac = await m.importSession({ sessionId: onMac, cwd: macCwd })
  expect(win).toMatchObject({ service: 'codex', cwd: winCwd, serviceThreads: { codex: { accountId: OTHER_PC, label: 'OTHER-PC', threadId: onWindows } } })
  expect(mac.cwd).toBe(macCwd)
  await codexTurn(fake, m, win.id, 'Carry on', 'Carrying on.')
  await codexTurn(fake, m, mac.id, 'Carry on', 'Carrying on.')
  expect(fake.calls('thread/resume').map((c) => [c.home, c.threadId, c.cwd])).toEqual([
    [relayHome(OTHER_PC), onWindows, winCwd],
    [relayHome(OTHER_PC), onMac, macCwd],
  ])
  // A folder no PC could name is still refused.
  await expect(m.importSession({ sessionId: relative, cwd: 'work/ledger' })).rejects.toThrow('cwd must be an absolute path, got "work/ledger"')
})

test("Pin service counts only this machine's Codex accounts: another PC's Codex never takes a pinned chat", async () => {
  const { m } = await setup({ codex: hubDirectory(() => true) })
  expect((await m.services()).find((s) => s.kind === 'codex')).toMatchObject({ ready: true, accounts: 1 })
  const { m: hubOnly } = await setup({ codex: hubDirectory(() => true, []) })
  expect((await hubOnly.services()).find((s) => s.kind === 'codex')).toMatchObject({ ready: false, accounts: 0, why: 'No Codex account is signed in.' })
})

/**
 * A hub chat imported while its PC's relay was open; `offline()` closes that relay before the test sends, `down()`
 * stops AgentHydra answering.
 */
async function hubImport(o: { resumeError?: string } = {}) {
  const threadId = '0f0f0f0f-1111-4222-8333-777777777777'
  const cwd = 'C:\\Users\\me\\work\\ledger'
  let online = true
  let answering = true
  const codex = hubDirectory(() => online, [ALPHA], () => answering)
  const { m, fake } = await setup({ external: [hubChat(threadId, cwd)], items: { [threadId]: [] }, codex, resumeError: o.resumeError })
  const chat = await m.importSession({ sessionId: threadId, cwd })
  const bound = { accountId: OTHER_PC, label: 'OTHER-PC', threadId }
  expect(chat.serviceThreads?.codex).toEqual(bound)
  /** Nothing reached this machine's own Codex, and the chat is still the PC's. */
  const stayed = () => {
    expect(fake.calls('thread/start')).toEqual([])
    expect(fake.calls('thread/resume').every((c) => c.home === relayHome(OTHER_PC))).toBe(true)
    expect(fake.turnStarts().every((t) => t.home === relayHome(OTHER_PC))).toBe(true)
    expect(m.get(chat.id).serviceThreads?.codex).toEqual(bound)
  }
  return { m, fake, chat, stayed, offline: () => (online = false), down: () => (answering = false) }
}

const resultOf = (m: ChatManager, chatId: string) => m.listItems(chatId).find((i) => i.kind === 'result')

test("another PC's Codex chat whose PC went off says so on the next send, and never moves to this machine's Codex", async () => {
  const { m, fake, chat, stayed, offline } = await hubImport()
  offline()
  await m.send(chat.id, 'Carry on')
  await waitFor(() => !!resultOf(m, chat.id))
  expect(resultOf(m, chat.id)).toMatchObject({ ok: false, error: 'OTHER-PC is not connected to the Codex hub now (it is off, or its pusher is not running), so this chat cannot continue here.' })
  expect(fake.opening()).toBe(0)
  stayed()
})

test("another PC's Codex chat says AgentHydra is not answering when it is not, not that the PC is off", async () => {
  const { m, fake, chat, stayed, down } = await hubImport()
  down()
  await m.send(chat.id, 'Carry on')
  await waitFor(() => !!resultOf(m, chat.id))
  expect(resultOf(m, chat.id)).toMatchObject({ ok: false, error: 'AgentHydra is not answering, so Desk cannot see the Codex accounts.' })
  expect(fake.opening()).toBe(0)
  stayed()
})

test("another PC's Codex chat gone from that PC says so, and is not started over on this machine's Codex", async () => {
  const { m, chat, stayed } = await hubImport({ resumeError: 'thread 0f0f0f0f-1111-4222-8333-777777777777 not found' })
  await m.send(chat.id, 'Carry on')
  await waitFor(() => !!resultOf(m, chat.id))
  expect(resultOf(m, chat.id)).toMatchObject({ ok: false, error: 'thread 0f0f0f0f-1111-4222-8333-777777777777 not found' })
  stayed()
})

test("another PC's Codex chat at that PC's usage limit waits for it, and is not moved to this machine's Codex", async () => {
  const { m, fake, chat, stayed } = await hubImport()
  await m.send(chat.id, 'Carry on')
  await waitFor(() => fake.turnStarts().length === 1)
  const threadId = chat.serviceThreads!.codex!.threadId
  fake.thread(threadId).notify('turn/completed', { threadId, turn: { id: 'turn-1', status: 'failed', error: { message: 'You hit your limit.', codexErrorInfo: 'usageLimitExceeded' } } })
  await waitFor(() => m.get(chat.id).status === 'limited')
  expect(systemTexts(m.listItems(chat.id))).toContain("OTHER-PC hit its Codex usage limit. This chat goes on only on that PC's Codex, so it waits until the limit there resets.")
  expect(fake.turnStarts()).toHaveLength(1)
  expect(fake.held()).toEqual([])
  stayed()
})

const GPT = (n: number, name: string, unlimited: boolean): FreeInstance => ({ id: `0000000${n}-aaaa-4bbb-8ccc-000000000000`, num: n, provider: 'chatgpt', name, autoName: false, loggedIn: true, checkedAt: 1, lastSignedInAt: 1, lastActiveAt: n, usage: unlimited ? { available: true, unlimited_text: true, plan: 'free', is_snapshot: false, observed_at: null, note: '', windows: [] } : null })

/** Free instances the test drives: each message is a job the test finishes. */
function fakeFree(instances: FreeInstance[]) {
  const jobs = new Map<string, FreeJob>()
  const asked: Record<string, unknown>[] = []
  const cancelled: string[] = []
  const running = (id: string) => [...jobs.values()].some((j) => j.instanceId === id && j.state === 'running')
  const free: FreeChats = {
    allInstances: () => instances,
    start: (r) => {
      const req = r as Record<string, unknown>
      // As Free instances: one operation a chat asks for at a time per account.
      if (running(String(req.instanceId))) throw new Error('This account already has an operation running.')
      asked.push(req)
      const job: FreeJob = { id: String(req.requestId), instanceId: String(req.instanceId), provider: 'chatgpt', command: req.command as FreeJob['command'], state: 'running', phase: 'working', startedAt: 1 }
      jobs.set(job.id, job)
      return job
    },
    get: (id) => jobs.get(id)!,
    cancel: (id) => {
      cancelled.push(id)
    },
    occupied: running,
  }
  /** Ends a job: the last one started, else the one with that request id. */
  const finish = (result: FreeResult, requestId?: unknown) => Object.assign(requestId === undefined ? [...jobs.values()].at(-1)! : jobs.get(String(requestId))!, { state: 'done', result })
  return { free, asked, finish, cancelled }
}

test('a chat pinned to ChatGPT asks a Free ChatGPT account, goes on in that ChatGPT chat, and a limit moves it to another account', async () => {
  const A = GPT(3, 'alpha', true)
  const B = GPT(4, 'beta', false)
  const f = fakeFree([B, A])
  const { m, chat } = await setup({ free: f.free })
  expect((await m.services()).find((s) => s.kind === 'chatgpt')).toMatchObject({ ready: true, accounts: 2 })
  await m.patch(chat.id, { service: 'chatgpt' })

  const ask = async (text: string, result: FreeResult) => {
    const n = f.asked.length
    await m.send(chat.id, text)
    await waitFor(() => f.asked.length > n)
    f.finish(result)
  }
  const chatId = '11111111-2222-4333-8444-555555555555'
  // The account with unlimited text first; a new ChatGPT chat named for this one, its id making the name the account's
  // own (the Free runtime refuses a name one of its chats has).
  await ask('Name three rivers', { ok: true, chat_id: chatId, is_temporary: true, response: 'Nile, Amazon, Danube.' })
  await waitFor(() => m.get(chat.id).status === 'idle')
  expect(f.asked[0]).toMatchObject({ instanceId: A.id, provider: 'chatgpt', command: 'chat', name: `Pinned ${chat.id.slice(0, 8)}`, prompt: 'Name three rivers' })
  expect(m.get(chat.id).serviceThreads?.chatgpt).toEqual({ accountId: A.id, label: '#3 alpha', threadId: chatId })
  expect(m.listItems(chat.id).filter((i) => i.kind === 'assistant_text').map((i) => i.text)).toEqual(['Nile, Amazon, Danube.'])
  expect(m.listItems(chat.id).find((i) => i.kind === 'result')).toMatchObject({ ok: true })

  // The next message goes on in that ChatGPT chat; at its limit, in a new one on the other account that first reads the chat.
  await ask('Which is longest?', { ok: false, error: { code: 'rate_limited', message: 'ChatGPT limit reached.' } })
  expect(f.asked[1]).toMatchObject({ instanceId: A.id, command: 'resume', chatId, prompt: 'Which is longest?' })
  await waitFor(() => f.asked.length === 3)
  const moved = f.asked[2]!
  expect(moved).toMatchObject({ instanceId: B.id, command: 'chat' })
  const prompt = String(moved.prompt)
  expect(prompt.startsWith(`${PIN_INTRO}ChatGPT, which has not seen it yet: until now it ran on another ChatGPT account (#3 alpha).`)).toBe(true)
  expect(prompt).toContain('Nile, Amazon, Danube.')
  expect(prompt.endsWith(`${ANSWER_NOW}Which is longest?`)).toBe(true)
  f.finish({ ok: true, chat_id: '66666666-2222-4333-8444-555555555555', is_temporary: true, response: 'The Nile.' })
  await waitFor(() => m.get(chat.id).status === 'idle')
  expect(systemTexts(m.listItems(chat.id))).toContain('#3 alpha hit its ChatGPT limit, so this chat goes on on another ChatGPT account.')
  expect(m.get(chat.id).serviceThreads?.chatgpt?.accountId).toBe(B.id)
  expect(m.listItems(chat.id).filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text)).toEqual(['Name three rivers', 'Which is longest?'])
})

test("two chats on ChatGPT's one free account: the second chat's message waits for the first's to end, then goes, never refused", async () => {
  const f = fakeFree([GPT(3, 'alpha', true)])
  const { m, chat, cwd } = await setup({ free: f.free })
  const other = await m.create({ cwd, title: 'Second', accountId: 'acct-1', permissionMode: 'bypassPermissions' })
  await m.patch(chat.id, { service: 'chatgpt' })
  await m.patch(other.id, { service: 'chatgpt' })
  await m.send(chat.id, 'First question')
  await waitFor(() => f.asked.length === 1)
  await m.send(other.id, 'Second question')
  await waitFor(() => m.get(other.id).activity === 'Waiting for #3 alpha to finish another message')
  expect(f.asked).toHaveLength(1)

  f.finish({ ok: true, chat_id: '77777777-2222-4333-8444-000000000001', is_temporary: true, response: 'First answer.' }, f.asked[0]!.requestId)
  await waitFor(() => f.asked.length === 2)
  expect(String(f.asked[1]!.prompt)).toBe('Second question')
  f.finish({ ok: true, chat_id: '77777777-2222-4333-8444-000000000002', is_temporary: true, response: 'Second answer.' }, f.asked[1]!.requestId)
  await waitFor(() => m.get(other.id).status === 'idle')
  expect(m.get(chat.id).status).toBe('idle')
  for (const [id, answer] of [[chat.id, 'First answer.'], [other.id, 'Second answer.']] as const) {
    const items = m.listItems(id)
    expect(items.filter((i) => i.kind === 'assistant_text').map((i) => i.text)).toEqual([answer])
    expect(items.find((i) => i.kind === 'result')).toMatchObject({ ok: true })
  }
})

test('a message sent after the pin moved while Codex was still replying waits, shown queued and able to be taken back, and goes to ChatGPT with what Codex said once that reply ends', async () => {
  const f = fakeFree([GPT(3, 'alpha', true)])
  const { m, fake, chat } = await setup({ free: f.free })
  await m.patch(chat.id, { service: 'codex' })
  await m.send(chat.id, 'Draft the plan')
  await waitFor(() => fake.turnStarts().length === 1)
  const l = fake.thread('thread-1')
  await m.patch(chat.id, { service: 'chatgpt' })
  expect(await m.send(chat.id, 'Now shorten it')).toEqual({ queued: true })
  // Codex's reply is not cut off, and ChatGPT is not asked while it runs.
  expect(fake.calls('turn/interrupt')).toEqual([])
  expect(f.asked).toEqual([])
  expect(m.listItems(chat.id).find((i) => i.kind === 'user' && i.text === 'Now shorten it')).toMatchObject({ queued: true })
  await m.send(chat.id, 'Never mind')
  const takenBack = m.listItems(chat.id).find((i) => i.kind === 'user' && i.text === 'Never mind')!
  expect(await m.cancelQueued(chat.id, takenBack.id)).toMatchObject({ cancelled: true })

  l.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1', text: 'Step one, step two.' } })
  l.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', durationMs: 900 } })
  await waitFor(() => f.asked.length === 1)
  const prompt = String(f.asked[0]!.prompt)
  expect(prompt).toContain('Step one, step two.')
  expect(prompt.endsWith(`${ANSWER_NOW}Now shorten it`)).toBe(true)
  f.finish({ ok: true, chat_id: '77777777-2222-4333-8444-555555555555', is_temporary: true, response: 'Two steps.' })
  await waitFor(() => m.get(chat.id).status === 'idle')
  const items = m.listItems(chat.id)
  expect(items.flatMap((i) => (i.kind === 'user' ? [[i.text, i.queued ?? false]] : []))).toEqual([
    ['Draft the plan', false],
    ['Now shorten it', false],
  ])
  expect(items.filter((i) => i.kind === 'assistant_text').map((i) => i.text)).toEqual(['Step one, step two.', 'Two steps.'])
  expect(f.asked).toHaveLength(1)
})

/** The worker's JSONL once its first turn is written: the message it was started with, then its reply. */
const KIWI_TURN: TranscriptItem[] = [
  { kind: 'user', id: 'u-1', ts: 9, text: 'Remember the word KIWI' },
  { kind: 'assistant_text', id: 'a-1', ts: 10, text: 'Noted: KIWI.' },
]

/** A CliMayte chat whose worker is replying, pinned to Codex, with 'Which word?' waiting for that reply. */
async function workerCrossing(now?: () => number) {
  const home = temp('desk-pin-worker-')
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const fake = fakeCodex()
  const codex: CodexDirectory = { instances: async () => [ALPHA], usage: async () => ({ snapshot: { session: { pct: 10 }, weekAll: { pct: 5 } } }) }
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => ({ ...DEFAULT_SETTINGS }), bridge: b.bridge, queryImpl: fakeQueries().queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, codex, openCodex: fake.open, ...(now ? { now } : {}) })
  managers.push(m)
  const chat = await m.create({ cwd: home, prompt: 'Remember the word KIWI' })
  await waitFor(() => !!m.get(chat.id).workerId)
  const row = b.state.rows[0]!
  Object.assign(row, { status: 'running' })
  await m.syncWorkers(chat.id)
  await m.patch(chat.id, { service: 'codex' })
  expect(await m.send(chat.id, 'Which word?')).toEqual({ queued: true })
  return { b, fake, m, chat, row }
}

// Live, 2026-10-14: a new session's file is not there at its first poll, and the bridge waits 5 s, then 10, before
// looking for a missed file again; the worker's done came in while that wait hid its reply, and Codex was asked bare.
test("a CliMayte worker's turn end reads its transcript afresh, so the message waiting for its reply carries it", async () => {
  const { b, fake, m, chat, row } = await workerCrossing()
  const read = b.bridge.workerItems
  b.bridge.workerItems = async (ids, cwd, o) => (o?.rescan ? read(ids, cwd, o) : [])
  b.state.workerItems['worker-session-1'] = KIWI_TURN
  Object.assign(row, { status: 'done' })
  await m.syncWorkers(chat.id)
  await waitFor(() => fake.turnStarts().length === 1)
  expect(String(fake.turnStarts()[0]!.input[0]!.text)).toContain('Noted: KIWI.')
})

test("a CliMayte worker that reads done before its transcript shows the turn stays busy until it does, and what waited goes with the reply", async () => {
  const { b, fake, m, chat, row } = await workerCrossing()
  Object.assign(row, { status: 'done' })
  await m.syncWorkers(chat.id)
  expect(m.get(chat.id).status).toBe('working')
  expect(fake.turnStarts()).toEqual([])

  b.state.workerItems['worker-session-1'] = KIWI_TURN
  await m.syncWorkers(chat.id)
  await waitFor(() => fake.turnStarts().length === 1)
  expect(String(fake.turnStarts()[0]!.input[0]!.text)).toContain('Noted: KIWI.')
})

test('a CliMayte worker whose transcript never shows the turn reads done 15 s after its worker did, and what waited goes', async () => {
  let skew = 0
  const { fake, m, chat, row } = await workerCrossing(() => Date.now() + skew)
  Object.assign(row, { status: 'done' })
  await m.syncWorkers(chat.id)
  expect(m.get(chat.id).status).toBe('working')
  expect(fake.turnStarts()).toEqual([])
  skew = 15_000
  await m.syncWorkers(chat.id)
  await waitFor(() => fake.turnStarts().length === 1)
  expect(String(fake.turnStarts()[0]!.input[0]!.text)).toContain('Which word?')
})

test("a message sent after the pin moved while a CliMayte worker was still replying goes to Codex once the worker's reply ends, with that reply", async () => {
  const home = temp('desk-pin-worker-')
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const fake = fakeCodex()
  const codex: CodexDirectory = { instances: async () => [ALPHA], usage: async () => ({ snapshot: { session: { pct: 10 }, weekAll: { pct: 5 } } }) }
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => ({ ...DEFAULT_SETTINGS }), bridge: b.bridge, queryImpl: fakeQueries().queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, codex, openCodex: fake.open })
  managers.push(m)
  const chat = await m.create({ cwd: home, prompt: 'Remember the word KIWI' })
  await waitFor(() => !!m.get(chat.id).workerId)
  const row = b.state.rows[0]!
  Object.assign(row, { status: 'running' })
  await m.syncWorkers(chat.id)
  await m.patch(chat.id, { service: 'codex' })
  expect(await m.send(chat.id, 'Which word?')).toEqual({ queued: true })
  expect(fake.turnStarts()).toEqual([])

  // The worker's status comes from AgentHydra's list, not a runtime event: its reply ending sends what waited. A
  // change to the chat while its transcript is still being read (a rename here) does not send it early.
  b.state.workerItems['worker-session-1'] = KIWI_TURN
  Object.assign(row, { status: 'done' })
  const read = b.bridge.workerItems
  let reading = false
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  b.bridge.workerItems = async (...args) => {
    reading = true
    await held
    return read(...args)
  }
  const sync = m.syncWorkers(chat.id)
  await waitFor(() => reading)
  await m.patch(chat.id, { title: 'Renamed' })
  await new Promise((r) => setTimeout(r, 50))
  expect(fake.turnStarts()).toEqual([])
  release()
  await sync
  await waitFor(() => fake.turnStarts().length === 1)
  const text = String(fake.turnStarts()[0]!.input[0]!.text)
  expect(text).toContain('Noted: KIWI.')
  expect(text.endsWith(`${ANSWER_NOW}Which word?`)).toBe(true)
})

test('a ChatGPT chat deleted mid-message stops that message and sends nothing it had queued', async () => {
  const f = fakeFree([GPT(3, 'alpha', true)])
  const { m, chat } = await setup({ free: f.free })
  await m.patch(chat.id, { service: 'chatgpt' })
  await m.send(chat.id, 'First')
  await waitFor(() => f.asked.length === 1)
  expect(await m.send(chat.id, 'Second')).toEqual({ queued: true })
  await m.delete(chat.id)
  expect(f.asked.map((a) => a.prompt)).toEqual(['First'])
  expect(f.cancelled).toEqual([String(f.asked[0]!.requestId)])
})

test('a Codex chat deleted while its app-server is still starting lets that app-server go once it is up, and starts no turn', async () => {
  let up = () => {}
  const { m, fake, chat } = await setup({ up: new Promise<void>((r) => (up = r)) })
  await m.patch(chat.id, { service: 'codex' })
  await m.send(chat.id, 'Show me the status')
  await waitFor(() => fake.opening() === 1)
  const gone = m.delete(chat.id)
  up()
  await gone
  expect(fake.held()).toEqual([])
  expect(fake.turnStarts()).toEqual([])
})

test('a Codex turn is counted under its setting, a pushing one as pushback, a clean one as zero', async () => {
  const { m, fake, chat } = await setup()
  await m.patch(chat.id, { service: 'codex' })
  await codexTurn(fake, m, chat.id, 'Show the status', 'The tree is clean.')
  await codexTurn(fake, m, chat.id, 'Deploy it', "I can't help with that.")
  expect(m.pushbackRows()).toEqual([{ service: 'codex', model: 'default', effort: 'default', turns: 2, pushback: 1, refusals: 0, pushbackRate: 0.5 }])
})
