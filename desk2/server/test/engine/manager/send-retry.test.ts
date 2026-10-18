// A CliMayte chat's message AgentHydra did not answer is kept and sent again with the same request id, so it is
// never dropped and never taken twice (2026-10-13: "Your message was not sent: ... did not answer POST
// /api/corch/workers within 4000 ms" while AgentHydra had started the worker anyway; sent again by hand, a second
// worker ran the same message).

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@shared/protocol'
import { BridgeError } from '../../../src/bridge/client'
import { ChatBusyError, ChatManager } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const late = () => new BridgeError('timeout', 'AgentHydra did not answer POST /api/corch/workers within 30000 ms')

function setup(home?: string, b = fakeBridge()) {
  if (!home) {
    home = mkdtempSync(join(tmpdir(), 'desk-send-retry-'))
    temps.push(home)
  }
  process.env.HYDRA_DESK_HOME = home
  const m = new ChatManager({
    home,
    claudeHome: home,
    emit: () => {},
    settings: () => DEFAULT_SETTINGS,
    bridge: b.bridge,
    queryImpl: fakeQueries().queryImpl,
    agentHydraMcp: null,
    env: { PATH: '/bin' },
    storeDebounceMs: 1,
    retryDelays: { firstMs: 5, maxMs: 20 },
  })
  managers.push(m)
  return { m, b, home }
}

async function until(ok: () => boolean, what: string, show?: () => unknown): Promise<void> {
  const end = Date.now() + 5_000
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${show ? `: ${JSON.stringify(show())}` : ''}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const lines = (m: ChatManager, id: string) =>
  m.listItems(id).filter((i): i is Extract<TranscriptItem, { kind: 'system' }> => i.kind === 'system').map((i) => i.text)
const users = (m: ChatManager, id: string) =>
  m.listItems(id).filter((i): i is Extract<TranscriptItem, { kind: 'user' }> => i.kind === 'user')

test('a first message AgentHydra answered too late is sent again with its id: one worker, never "not sent"', async () => {
  const { m, b, home } = setup()
  b.state.failNext.push({ err: late(), took: true })
  const chat = await m.create({ cwd: home, prompt: 'reply with the word pong' })
  await until(() => !!m.get(chat.id).workerId, 'the worker')
  expect(b.state.started).toHaveLength(1)
  expect(b.state.requestIds).toHaveLength(2)
  expect(new Set(b.state.requestIds).size).toBe(1)
  expect(lines(m, chat.id).some((t) => /kept and sent again/.test(t))).toBe(true)
  expect(lines(m, chat.id).some((t) => /not sent/i.test(t))).toBe(false)
  // Its bubble stays until the worker's own copy arrives.
  expect(users(m, chat.id)).toEqual([expect.objectContaining({ text: 'reply with the word pong' })])
})

test('a follow-up AgentHydra answered too late is queued once, however many tries reach it', async () => {
  const { m, b, home } = setup()
  const chat = await m.create({ cwd: home, prompt: 'first' })
  await until(() => !!m.get(chat.id).workerId, 'the worker')
  // The first turn is over: the follow-up runs as soon as AgentHydra has it.
  b.state.workerItems['worker-session-1'] = [{ kind: 'user', id: 'u-1', ts: 1, text: 'first' }]
  Object.assign(b.state.rows[0]!, { status: 'done' })
  await m.syncWorkers(chat.id)
  b.state.requestIds.length = 0
  b.state.failNext.push({ err: late(), took: true }, { err: late(), took: true })
  expect(await m.send(chat.id, 'second')).toEqual({ queued: true })
  // Held while it was sent again, it is the turn starting now.
  const taken = () => users(m, chat.id).find((u) => u.text === 'second')
  await until(() => b.state.requestIds.length === 3 && !!taken() && !taken()?.queued, 'the third try taken', () => ({ ids: b.state.requestIds.length, sent: b.state.sentToWorker, users: users(m, chat.id), lines: lines(m, chat.id), chat: m.get(chat.id).status }))
  expect(b.state.sentToWorker).toEqual([{ id: 'w1', text: 'second' }])
  expect(new Set(b.state.requestIds).size).toBe(1)
  expect(lines(m, chat.id).some((t) => /not sent/i.test(t))).toBe(false)
})

test('a later message waits behind a held one and goes after it, in order; the queue waits too', async () => {
  const { m, b, home } = setup()
  const chat = await m.create({ cwd: home, prompt: 'first' })
  await until(() => !!m.get(chat.id).workerId, 'the worker')
  b.state.takesRequestIds = null // AgentHydra does not answer at all for now
  b.state.failNext.push({ err: late() })
  await m.send(chat.id, 'one')
  expect(await m.send(chat.id, 'two')).toEqual({ queued: true })
  await expect(m.send(chat.id, 'three', undefined, { onlyIfReady: true })).rejects.toBeInstanceOf(ChatBusyError)
  expect(users(m, chat.id).filter((u) => u.queued && u.text !== 'first').map((u) => u.text)).toEqual(['one', 'two'])
  // Undo while one is still being sent would cut the session under it.
  await expect(m.rewind(chat.id, users(m, chat.id)[0]!.id)).rejects.toThrow(/still sending/)
  b.state.takesRequestIds = true
  await until(() => b.state.sentToWorker.length === 2, 'both sent')
  expect(b.state.sentToWorker.map((s) => s.text)).toEqual(['one', 'two'])
  expect(b.state.started).toHaveLength(1)
})

test('a refusal after a late answer is final: the bubble goes and the chat keeps the words and says why', async () => {
  const { m, b, home } = setup()
  const chat = await m.create({ cwd: home, prompt: 'first' })
  await until(() => !!m.get(chat.id).workerId, 'the worker')
  b.state.failNext.push({ err: late() }, { err: new BridgeError('http', 'No such worker w1', 404) })
  await m.send(chat.id, 'lost?')
  await until(() => lines(m, chat.id).some((t) => /not sent/.test(t)), 'the not-sent line')
  expect(lines(m, chat.id).find((t) => /not sent/.test(t))).toBe('Your message was not sent: CliMayte did not take it: No such worker w1\n\nlost?')
  expect(users(m, chat.id).some((u) => u.text === 'lost?')).toBe(false)
  expect(b.state.sentToWorker).toEqual([])
})

test('AgentHydra failing on its side is tried a few times, then the message is given back', async () => {
  const { m, b, home } = setup()
  const chat = await m.create({ cwd: home, prompt: 'first' })
  await until(() => !!m.get(chat.id).workerId, 'the worker')
  b.state.requestIds.length = 0
  const broken = () => ({ err: new BridgeError('http', 'internal error', 500) })
  b.state.failNext.push(broken(), broken(), broken(), broken(), broken(), broken(), broken())
  await m.send(chat.id, 'retry me')
  await until(() => lines(m, chat.id).some((t) => /not sent/.test(t)), 'the not-sent line')
  // The first send and five more.
  expect(b.state.requestIds).toHaveLength(6)
  expect(b.state.failNext).toHaveLength(1)
})

test('an AgentHydra that reads no request id is not sent it again: it could run it twice', async () => {
  const { m, b, home } = setup()
  const chat = await m.create({ cwd: home, prompt: 'first' })
  await until(() => !!m.get(chat.id).workerId, 'the worker')
  b.state.takesRequestIds = false
  b.state.requestIds.length = 0
  b.state.failNext.push({ err: late(), took: true })
  await m.send(chat.id, 'maybe sent')
  await until(() => lines(m, chat.id).some((t) => /may have gone through/.test(t)), 'the warning')
  expect(b.state.requestIds).toHaveLength(1)
  expect(lines(m, chat.id).find((t) => /may have gone through/.test(t))).toEndWith('\n\nmaybe sent')
  expect(users(m, chat.id).some((u) => u.text === 'maybe sent')).toBe(false)
})

test('a message held when the server stopped is sent after the restart, with the same id', async () => {
  const first = setup()
  first.b.state.takesRequestIds = null
  first.b.state.failNext.push({ err: late(), took: true })
  const chat = await first.m.create({ cwd: first.home, prompt: 'survive a restart' })
  await until(() => first.b.state.requestIds.length === 1 && users(first.m, chat.id).some((u) => u.queued), 'the held message')
  await first.m.closeAll()
  managers.splice(managers.indexOf(first.m), 1)

  first.b.state.takesRequestIds = true
  const again = setup(first.home, first.b)
  await until(() => !!again.m.get(chat.id).workerId, 'the worker after the restart')
  expect(first.b.state.started).toHaveLength(1)
  expect(new Set(first.b.state.requestIds).size).toBe(1)
  expect(first.b.state.requestIds).toHaveLength(2)
})

test('Cancel on a held message: one never sent goes at once, one AgentHydra may have is taken back from the worker', async () => {
  const { m, b, home } = setup()
  const chat = await m.create({ cwd: home, prompt: 'first' })
  await until(() => !!m.get(chat.id).workerId, 'the worker')
  b.state.requestIds.length = 0
  b.state.takesRequestIds = null // AgentHydra does not answer for now
  b.state.failNext.push({ err: late(), took: true })
  await m.send(chat.id, 'one')
  await m.send(chat.id, 'two')
  const idOf = (text: string) => users(m, chat.id).find((u) => u.text === text)!.id

  // Never sent: it goes without asking AgentHydra, which is down.
  expect(await m.cancelQueued(chat.id, idOf('two'))).toEqual({ ok: true, cancelled: true, message: 'Taken back: it is not sent.' })
  expect(b.state.heldCancels).toEqual([])
  // Sent once and not answered: AgentHydra is asked to take it back, and it stays while AgentHydra cannot be.
  b.state.cancelHeldRoute = false
  await expect(m.cancelQueued(chat.id, idOf('one'))).rejects.toThrow(/could not take it back/)
  b.state.cancelHeldRoute = true
  expect(await m.cancelQueued(chat.id, idOf('one'))).toMatchObject({ cancelled: true })
  expect(b.state.heldCancels).toEqual([{ id: 'w1', text: 'one' }])
  expect(users(m, chat.id).map((u) => u.text)).toEqual(['first'])

  // Neither is sent again once AgentHydra answers.
  b.state.takesRequestIds = true
  await new Promise((r) => setTimeout(r, 100))
  expect(b.state.requestIds).toHaveLength(1)
  expect(b.state.sentToWorker.map((s) => s.text)).toEqual(['one'])
})

test('a first message that may have started the worker cannot be taken back', async () => {
  const { m, b, home } = setup()
  b.state.takesRequestIds = null
  b.state.failNext.push({ err: late(), took: true })
  const chat = await m.create({ cwd: home, prompt: 'start me' })
  await until(() => users(m, chat.id).some((u) => u.queued), 'the held message')
  const r = await m.cancelQueued(chat.id, users(m, chat.id)[0]!.id)
  expect(r).toMatchObject({ cancelled: false })
  expect(r.message).toMatch(/may already have started this chat/)
  b.state.takesRequestIds = true
  await until(() => !!m.get(chat.id).workerId, 'the worker')
  expect(b.state.started).toHaveLength(1)
})

test('a worker that fails keeps a message the chat is still sending: no "send it again" line that would run it twice', async () => {
  const { m, b, home } = setup()
  const chat = await m.create({ cwd: home, prompt: 'first' })
  await until(() => !!m.get(chat.id).workerId, 'the worker')
  b.state.takesRequestIds = null
  b.state.failNext.push({ err: late() })
  await m.send(chat.id, 'keep me')
  Object.assign(b.state.rows[0]!, { status: 'failed', error: 'The worker failed.' })
  await m.syncWorkers(chat.id)
  expect(lines(m, chat.id).filter((t) => t.startsWith('Not delivered'))).toEqual(['Not delivered, send it again: "first"'])
  expect(users(m, chat.id).find((u) => u.text === 'keep me')).toMatchObject({ queued: true })
  b.state.takesRequestIds = true
  await until(() => b.state.sentToWorker.some((s) => s.text === 'keep me'), 'the message sent')
})
