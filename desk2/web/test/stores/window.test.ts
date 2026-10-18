import { afterAll, describe, expect, test } from 'bun:test'
import type { ChatSummary, ServerEvent, TranscriptIndex, TranscriptItem } from '@shared/protocol'
import { saveGlobals } from '../save-globals'

// The store keeps a window of each chat's items (the newest page plus pages loaded above) and its index.
function summary(id: string, status: ChatSummary['status'] = 'idle'): ChatSummary {
  return {
    id, sessionId: null, title: `Chat ${id}`, cwd: 'C:/work/window', account: { id: 'default', label: 'Default', configDir: null },
    accountAuto: false, model: null, effort: null, permissionMode: 'bypassPermissions', delegateToCliMayte: false, status,
    activity: null, turnStartedAt: null, lastError: null, limitResetsAt: null, unread: false, pinned: false, archived: false,
    group: null, forkedFrom: null, createdAt: 1, updatedAt: 1, costUsd: 0, contextPct: null, pendingCount: 0, queuedCount: 0, climayteActive: 0,
  }
}
const msg = (n: number): TranscriptItem => ({ kind: 'user', id: `m${n}`, ts: n, text: `note ${n}` })
const ALL = Array.from({ length: 450 }, (_, i) => msg(i))
const INDEX: TranscriptIndex = { total: 450, userMessages: [], latestTodos: null, runningTasks: [], recentTasks: [], lastUserText: '' }

let socket: { onmessage: ((e: { data: string }) => void) | null } | null = null
const restoreGlobals = saveGlobals('document', 'window', 'location', 'Notification', 'WebSocket', 'fetch')
const g = globalThis as Record<string, unknown>
g.document ??= { title: 'Hydra Desk', hidden: false, createElement: () => ({}) }
g.window ??= { location: { protocol: 'http:', host: 'localhost:7801' }, addEventListener() {}, dispatchEvent() {}, focus() {} }
g.location ??= { protocol: 'http:', host: 'localhost:7801' }
g.Notification ??= { permission: 'denied', requestPermission() {} }
g.WebSocket = class {
  static OPEN = 1
  static CONNECTING = 0
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  constructor() {
    socket = this
  }
  close() {}
}
g.fetch = async (path: string) => {
  const url = new URL(path, 'http://x')
  let out: unknown = { ok: true }
  if (url.pathname.endsWith('/index')) out = INDEX
  else if (url.pathname.endsWith('/items')) {
    const before = url.searchParams.get('before')
    const end = before === null ? ALL.length : Number(before)
    const start = Math.max(0, end - 200)
    out = { items: ALL.slice(start, end), total: ALL.length, olderBefore: start }
  }
  return new Response(JSON.stringify(out), { status: 200 })
}
const { useDesk } = await import('../../src/stores/desk')
const desk = useDesk()
desk.disconnect()
await desk.init()
afterAll(async () => {
  for (const c of desk.chats.value) push({ type: 'chat.removed', chatId: c.id })
  await new Promise((r) => setTimeout(r, 0))
  desk.disconnect()
  restoreGlobals()
})
const push = (e: ServerEvent) => socket?.onmessage?.({ data: JSON.stringify(e) })
const chats = (list: ChatSummary[]): ServerEvent =>
  ({
    type: 'hello', version: 'test', chats: list,
    settings: { defaultModel: null, defaultEffort: null, defaultPermissionMode: 'bypassPermissions', defaultAccountId: 'auto', delegateToCliMayte: false, idleCloseMinutes: 30, browserIdleMinutes: 15, notifications: true, projectFolders: [], projectRoots: [], hiddenProjects: [], pinnedProjects: [], babysitter: true, instanceManager: true, orchestrator: false, orchestratorModel: 'opus', routines: true, collapseMode: 'off', coreEngine: false },
  }) as ServerEvent
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
}

describe('the window per chat', () => {
  test('load keeps the newest page, an upsert lands in it, loadOlder prepends contiguously', async () => {
    push(chats([summary('w1')]))
    const first = await desk.loadItems('w1')
    expect(first.length).toBe(200)
    expect(first[0]!.id).toBe('m250')
    expect(desk.hasOlder('w1')).toBe(true)
    await until(() => desk.indexByChat.value.has('w1'))
    expect(desk.indexByChat.value.get('w1')?.total).toBe(450)

    push({ type: 'item.upsert', chatId: 'w1', item: { kind: 'user', id: 'm300', ts: 300, text: 'edited' } } as ServerEvent)
    expect(desk.itemsByChat.value.get('w1')!.find((i) => i.id === 'm300')).toMatchObject({ text: 'edited' })

    expect(await desk.loadOlder('w1')).toBe(200)
    const ids = desk.itemsByChat.value.get('w1')!.map((i) => i.id)
    expect(ids.slice(0, 3)).toEqual(['m50', 'm51', 'm52'])
    expect(ids.length).toBe(400)
    expect(new Set(ids).size).toBe(400)
  })

  test('past 12 chats the first one drops its pages and keeps its index; a running chat stays', async () => {
    const list = [summary('k0', 'working'), ...Array.from({ length: 13 }, (_, i) => summary(`c${i}`))]
    push(chats(list))
    await desk.loadItems('c0')
    await until(() => desk.indexByChat.value.has('c0'))
    await desk.loadItems('k0')
    for (let i = 1; i < 13; i++) await desk.loadItems(`c${i}`)
    expect(desk.itemsByChat.value.has('c0')).toBe(false)
    expect(desk.indexByChat.value.has('c0')).toBe(true)
    expect(desk.itemsByChat.value.has('k0')).toBe(true)
  })
})
