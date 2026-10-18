// GET /api/chats/:id/items?before&limit pages a chat's items; without a query the answer is the whole list as before.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import { ChatManager } from '../src/engine/chat-manager'
import { ChatStore } from '../src/engine/store'
import { DEFAULT_SETTINGS } from '../src/settings'
import { fakeBridge } from './engine/manager/fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function chat(id: string): ChatSummary {
  return {
    id, sessionId: 's-' + id, title: 'Chat ' + id, cwd: 'C:/Users/me/p',
    account: { id: 'default', label: 'Default', configDir: null }, accountAuto: true, model: null, effort: null,
    permissionMode: 'bypassPermissions', delegateToCliMayte: false, status: 'closed', activity: null, turnStartedAt: null,
    lastError: null, limitResetsAt: null, unread: false, pinned: false, archived: false, group: null, forkedFrom: null,
    createdAt: 1, updatedAt: 2, costUsd: 0, contextPct: 0, pendingCount: 0, queuedCount: 0, climayteActive: 0,
  }
}

function boot(n: number): ChatManager {
  const home = mkdtempSync(join(tmpdir(), 'desk-items-page-'))
  temps.push(home)
  const seed = new ChatStore(home, { debounceMs: 1 })
  seed.saveChats([chat('c1')])
  for (let i = 0; i < n; i++) seed.appendItem('c1', { kind: 'assistant_text', id: `a-${i}`, ts: i + 1, text: `t${i}` })
  seed.flush()
  const m = new ChatManager({
    home, claudeHome: home, emit: () => {}, settings: () => ({ ...DEFAULT_SETTINGS }), bridge: fakeBridge({}).bridge,
    agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk',
  })
  managers.push(m)
  return m
}

test('a 600-item chat pages 200+200+200 without a gap or duplicate; the whole body is unchanged and not cached from a page', () => {
  const m = boot(600)
  const whole = m.itemsBody('c1')
  const ids: string[] = []
  let before: number | undefined
  for (let pages = 0; pages < 3; pages++) {
    const p = m.itemsPage('c1', before, 200)
    expect(p.items.length).toBe(200)
    expect(p.total).toBe(600)
    ids.unshift(...p.items.map((i: TranscriptItem) => i.id))
    before = p.olderBefore
  }
  expect(before).toBe(0)
  expect(new Set(ids).size).toBe(600)
  expect(ids).toEqual(JSON.parse(whole.body).map((i: TranscriptItem) => i.id))
  expect(m.itemsBody('c1').body).toBe(whole.body)
  expect(m.itemsPage('c1', 0, 200).items).toEqual([])
})
