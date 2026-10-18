// GET /api/chats/:id/index and /items/:itemId: the chat's TranscriptIndex (cached by the file's stamp) and one item by id.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatSummary } from '@shared/protocol'
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
  const home = mkdtempSync(join(tmpdir(), 'desk-chat-index-'))
  temps.push(home)
  const store = new ChatStore(home, { debounceMs: 1 })
  store.saveChats([chat('c1')])
  store.appendItem('c1', { kind: 'task', id: 'task-old', ts: 1, taskId: 't1', status: 'running', description: 'build example' } as never)
  for (let i = 0; i < 250; i++) {
    store.appendItem('c1', { kind: 'user', id: `u-${i}`, ts: 10 + i * 2, text: `\n  ask ${i}\nmore` } as never)
    store.appendItem('c1', { kind: 'assistant_text', id: `a-${i}`, ts: 11 + i * 2, text: `r${i}` })
  }
  store.appendItem('c1', { kind: 'todos', id: 'todo-1', ts: 600, todos: [] } as never)
  store.appendItem('c1', { kind: 'todos', id: 'todo-2', ts: 601, todos: [] } as never)
  store.flush()
  const m = new ChatManager({
    home, claudeHome: home, emit: () => {}, settings: () => ({ ...DEFAULT_SETTINGS }), bridge: fakeBridge({}).bridge,
    agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk',
  })
  managers.push(m)
  return { m, store }
}

test('the index matches the items: first lines, newest todos, an old task; an appended item changes it; one item by id', () => {
  const { m, store } = boot()
  const idx = m.transcriptIndex('c1')
  expect(idx.total).toBe(503)
  expect(idx.userMessages.length).toBe(250)
  expect(idx.userMessages[3]).toMatchObject({ id: 'u-3', firstLine: 'ask 3', images: 0 })
  expect(idx.latestTodos?.id).toBe('todo-2')
  expect(idx.recentTasks.map((t) => t.id)).toEqual(['task-old'])
  expect(m.transcriptIndex('c1')).toBe(idx)
  store.appendItem('c1', { kind: 'user', id: 'u-new', ts: 700, text: 'fresh' } as never)
  store.flush()
  const next = m.transcriptIndex('c1')
  expect(next.total).toBe(504)
  expect(next.lastUserText).toBe('fresh')
  expect(m.itemById('c1', 'u-new')?.id).toBe('u-new')
  expect(m.itemById('c1', 'nope')).toBeNull()
})

test('a running task older than the newest 200 items is in runningTasks while a turn runs', () => {
  const { m } = boot()
  ;(m as unknown as { entry(id: string): { runtime: unknown } }).entry('c1').runtime = { running: true, isPending: () => false, shutdown: async () => {}, close: async () => {} }
  const idx = m.transcriptIndex('c1')
  expect(idx.runningTasks.map((t) => t.id)).toEqual(['task-old'])
  expect(idx.total).toBe(503)
})
