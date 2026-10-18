// The row menu's Last action line reads lastActionAt: it moves with the chat's transcript, never with a mark (owner,
// 2026-10-14: "how long ago the last message was sent or The Last Action was performed").

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatManager } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(ok()).toBe(true)
}

test('a message sent is the last action; reading, renaming and pinning the chat later leave it, the next message moves it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-last-action-'))
  temps.push(home)
  const folder = join(home, 'proj')
  mkdirSync(folder, { recursive: true })
  let now = 1_000_000
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge: fakeBridge().bridge, queryImpl: fakeQueries().queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, now: () => now })
  managers.push(m)
  const chat = await m.create({ cwd: folder, prompt: 'go' })
  await until(() => m.get(chat.id).lastActionAt !== undefined)
  expect(m.get(chat.id).lastActionAt).toBe(1_000_000)

  now = 2_000_000
  await m.patch(chat.id, { unread: false, title: 'Renamed', pinned: true })
  expect(m.get(chat.id).updatedAt).toBe(2_000_000)
  expect(m.get(chat.id).lastActionAt).toBe(1_000_000)

  now = 3_000_000
  await m.send(chat.id, 'again')
  await until(() => m.get(chat.id).lastActionAt === 3_000_000)
})
