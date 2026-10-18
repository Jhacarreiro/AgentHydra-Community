// A chat opened under another Desk chat keeps its parent and its manager, names the manager on its row, and its
// Claude process runs with the manager pinned (AGENTHYDRA_MANAGER); a chat with no manager runs without the pin.

import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerEvent } from '../../../../shared/protocol'
import { ChatManager, parseCreate } from '../../../src/engine/chat-manager'
import { forgetManagerStats } from '../../../src/engine/manager-stats'
import { currentManager } from '../../../src/engine/managers'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

const temps: string[] = []
const managers: ChatManager[] = []
const oldManagersDir = process.env.AGENTHYDRA_MANAGERS_DIR
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
  if (oldManagersDir === undefined) delete process.env.AGENTHYDRA_MANAGERS_DIR
  else process.env.AGENTHYDRA_MANAGERS_DIR = oldManagersDir
})

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function setup(emit: (event: ServerEvent) => void = () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'desk-submgr-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const personas = mkdtempSync(join(tmpdir(), 'desk-submgr-personas-'))
  temps.push(personas)
  process.env.AGENTHYDRA_MANAGERS_DIR = personas
  mkdirSync(join(personas, 'example-manager'))
  writeFileSync(join(personas, 'example-manager', 'persona.json'), JSON.stringify({ slug: 'example-manager', name: 'Example Manager' }))
  const q = fakeQueries()
  const m = new ChatManager({ home, claudeHome: home, emit, settings: () => DEFAULT_SETTINGS, bridge: fakeBridge().bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk' })
  managers.push(m)
  return { home, personas, m, q }
}

function sentChats(events: ServerEvent[]) {
  return events.flatMap((e) => (e.type === 'chat.upsert' ? [e.chat] : []))
}

test('a chat opened under a Desk chat keeps its parent and manager, and runs with the manager pinned', async () => {
  const { home, m, q } = setup()
  const parent = await m.create({ cwd: home, delegateToCliMayte: false })
  const child = await m.create({
    cwd: home,
    prompt: 'start',
    title: 'Example Manager · topic',
    parentId: parent.id,
    managerSlug: 'example-manager',
    delegateToCliMayte: false,
  })
  expect(m.get(child.id)).toMatchObject({
    parentId: parent.id,
    managerSlug: 'example-manager',
    manager: { slug: 'example-manager', name: 'Example Manager', title: null, oneLiner: null, photo: null },
  })
  await waitFor(() => q.all.length === 1)
  expect(q.last().options.env).toMatchObject({ AGENTHYDRA_MANAGER: 'example-manager' })
})

test('a chat with no manager runs without the pin', async () => {
  const { home, m, q } = setup()
  const chat = await m.create({ cwd: home, prompt: 'hi', delegateToCliMayte: false })
  expect(m.get(chat.id).manager).toBeNull()
  await waitFor(() => q.all.length === 1)
  expect(q.last().options.env?.AGENTHYDRA_MANAGER).toBeUndefined()
})

test('a parent that is not a Desk chat is refused', async () => {
  const { home, m } = setup()
  await expect(m.create({ cwd: home, parentId: 'no-such-chat', delegateToCliMayte: false })).rejects.toThrow('parentId names no Desk chat')
})

test('a manager slug that is not a slug is refused', () => {
  expect(() => parseCreate({ cwd: 'C:/work', managerSlug: '../evil' })).toThrow('managerSlug is not a manager slug')
})

test('the manager label is the pin, else the manager the session is on, and none without a persona', () => {
  setup()
  const personas = process.env.AGENTHYDRA_MANAGERS_DIR!
  mkdirSync(join(personas, 'sessions'))
  writeFileSync(join(personas, 'sessions', 'sess-1.json'), JSON.stringify({ manager: 'example-manager' }))
  const label = { slug: 'example-manager', name: 'Example Manager', title: null, oneLiner: null, photo: null, statsLine: null }
  expect(currentManager(null, 'sess-1')).toEqual(label)
  expect(currentManager('example-manager', null)).toEqual(label)
  expect(currentManager('ghost', 'sess-1')).toBeNull()
  expect(currentManager(null, 'unknown-session')).toBeNull()
})

test('the manager label carries its analytics line once summary.json has one', () => {
  setup()
  const personas = process.env.AGENTHYDRA_MANAGERS_DIR!
  mkdirSync(join(personas, 'analytics'))
  writeFileSync(join(personas, 'analytics', 'summary.json'), JSON.stringify({ v: 1, managers: { 'example-manager': { turns: 3, line: '3 turns · 100% answered' } } }))
  forgetManagerStats()
  expect(currentManager('example-manager', null)?.statsLine).toBe('3 turns · 100% answered')
})

test('a manager photo change sends the chats on that manager again, and no others', async () => {
  const events: ServerEvent[] = []
  const { home, personas, m } = setup((e) => events.push(e))
  const pinned = await m.create({ cwd: home, prompt: 'start', managerSlug: 'example-manager', delegateToCliMayte: false })
  const plain = await m.create({ cwd: home, prompt: 'hi', delegateToCliMayte: false })
  expect(m.get(pinned.id).manager?.photo).toBeNull()
  writeFileSync(join(personas, 'example-manager', 'avatar.png'), PNG)
  events.length = 0
  m.managerChanged('example-manager')
  const sent = sentChats(events)
  expect(sent.map((c) => c.id)).toEqual([pinned.id])
  expect(sent[0].manager).toMatchObject({ slug: 'example-manager', photo: expect.any(Number) })
  expect(sent.map((c) => c.id)).not.toContain(plain.id)
})

test('a photo dropped in by hand shows once the held label is five seconds old', () => {
  const { personas } = setup()
  expect(currentManager('example-manager', null)?.photo).toBeNull()
  writeFileSync(join(personas, 'example-manager', 'avatar.png'), PNG)
  expect(currentManager('example-manager', null)?.photo).toBeNull()
  setSystemTime(new Date(Date.now() + 6000))
  try {
    expect(currentManager('example-manager', null)?.photo).toEqual(expect.any(Number))
  } finally {
    setSystemTime()
  }
})

test('a runtime chat.upsert of a pinned chat carries its manager label', async () => {
  const events: ServerEvent[] = []
  const { home, m } = setup((e) => events.push(e))
  const chat = await m.create({ cwd: home, prompt: 'start', managerSlug: 'example-manager', delegateToCliMayte: false })
  events.length = 0
  ;(m as unknown as { onRuntimeEvent(event: ServerEvent): void }).onRuntimeEvent({ type: 'chat.upsert', chat: m.get(chat.id) })
  const sent = sentChats(events)
  expect(sent.map((c) => c.id)).toEqual([chat.id])
  expect(sent[0].manager).toMatchObject({ slug: 'example-manager', name: 'Example Manager' })
})
