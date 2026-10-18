// GET /api/chats/:id/search: Find over the whole chat, not the loaded page.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatSummary } from '@shared/protocol'
import { searchItems } from '@shared/find'
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

function boot(): { m: ChatManager; store: ChatStore } {
  const home = mkdtempSync(join(tmpdir(), 'desk-chat-search-'))
  temps.push(home)
  const store = new ChatStore(home, { debounceMs: 1 })
  store.saveChats([chat('c1')])
  store.appendItem('c1', { kind: 'user', id: 'u-first', ts: 1, text: 'zebrafinch Zebrafinch twice' } as never)
  for (let i = 0; i < 250; i++) {
    store.appendItem('c1', { kind: 'user', id: `u-${i}`, ts: 10 + i * 2, text: `\n  ask ${i}\nmore` } as never)
    store.appendItem('c1', { kind: 'assistant_text', id: `a-${i}`, ts: 11 + i * 2, text: `r${i}` })
  }
  store.flush()
  const m = new ChatManager({
    home, claudeHome: home, emit: () => {}, settings: () => ({ ...DEFAULT_SETTINGS }), bridge: fakeBridge({}).bridge,
    agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk',
  })
  managers.push(m)
  return { m, store }
}

test('a term only in the oldest page is found, and the total equals the matches over the full array', () => {
  const { m } = boot()
  const all = m.listItems('c1')
  const page = m.itemsPage('c1', undefined, 200).items
  expect(searchItems(page, 'zebrafinch')).toEqual([])
  const found = m.search('c1', 'zebrafinch')
  expect(found.total).toBe(2)
  expect(found.hits).toEqual([{ itemId: 'u-first', position: 0, nth: 0 }, { itemId: 'u-first', position: 0, nth: 1 }])
  expect(found.total).toBe(searchItems(all, 'zebrafinch').length)
  const many = m.search('c1', 'ask')
  expect(many.total).toBe(250)
  expect(many.hits[249]).toMatchObject({ itemId: 'u-249', nth: 0 })
  expect(m.search('c1', '  ')).toEqual({ hits: [], total: 0 })
})
