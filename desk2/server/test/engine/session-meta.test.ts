// The Unassigned holding area's marks (server/src/engine/session-meta.ts): a chat taken off its account stays listed
// however old, is drawn Unassigned only while no account shows it, and its mark is dropped once an account has shown it
// for longer than the archive behind an Unassign can take. Losing either rule loses the chat: listed nowhere, or listed
// in Unassigned while an account runs it.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExternalSession } from '@shared/protocol'
import { SessionMetaStore, UNASSIGN_GRACE_MS } from '../../src/engine/session-meta'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'desk-meta-'))
  dirs.push(dir)
  return dir
}

const session = (id: string): ExternalSession => ({
  id,
  title: 'Example chat',
  cwd: 'C:/work/alpha',
  source: 'desktop',
  instance: '#5',
  status: 'idle',
  activity: null,
  lastActivityAt: 1,
  model: null,
  accountId: null,
  canResume: true,
  fromPc: null,
  pinned: false,
  archived: false,
  unread: false,
  group: null
})

test('an Unassigned chat stays listed and is drawn Unassigned while no account shows it, its note with it, after a restart too', () => {
  const dir = home()
  let now = 1_000_000
  const store = new SessionMetaStore(dir, () => now)
  store.patch('s-1', { unassigned: true, note: 'Waiting for a fresh account' })
  store.patch('s-2', { pinned: true })
  store.flushSync()

  const again = new SessionMetaStore(dir, () => now)
  expect(again.listedIds().sort()).toEqual(['s-1', 's-2'])
  expect(again.apply([session('s-1')])[0]).toMatchObject({ unassigned: true, note: 'Waiting for a fresh account' })
  // Shown by an account while the archive behind the Unassign may still be under way: not drawn Unassigned, mark kept.
  now += UNASSIGN_GRACE_MS - 1
  expect(again.apply([session('s-1')], new Set(['s-1']))[0]?.unassigned).toBe(false)
  expect(again.get('s-1')?.unassigned).toBe(true)
})

test('a chat archived here stays archived until it is used again, after a restart too, an older mark dating from the file', () => {
  const dir = home()
  const now = 1_000_000
  const store = new SessionMetaStore(dir, () => now)
  store.patch('s-1', { archived: true })
  store.flushSync()

  const again = new SessionMetaStore(dir, () => now)
  expect(again.apply([{ ...session('s-1'), lastActivityAt: now - 1 }])[0]?.archived).toBe(true)
  expect(again.apply([{ ...session('s-1'), lastActivityAt: now + 1 }])[0]?.archived).toBe(false)
  expect(again.get('s-1')).toBeNull()

  // Marked before the time was kept: the file's last write stands in for it.
  writeFileSync(join(dir, 'session-meta.json'), JSON.stringify({ 's-2': { archived: true } }))
  utimesSync(join(dir, 'session-meta.json'), now / 1000, now / 1000)
  const old = new SessionMetaStore(dir, () => now)
  expect(old.apply([{ ...session('s-2'), lastActivityAt: now - 1000 }])[0]?.archived).toBe(true)
  expect(old.apply([{ ...session('s-2'), lastActivityAt: now + 1000 }])[0]?.archived).toBe(false)
})

test('a mark older than the grace is dropped once an account shows the chat (moved there some other way)', () => {
  const dir = home()
  let now = 1_000_000
  const store = new SessionMetaStore(dir, () => now)
  store.patch('s-1', { unassigned: true })
  store.flushSync()
  now += UNASSIGN_GRACE_MS + 1
  const again = new SessionMetaStore(dir, () => now)
  expect(again.apply([session('s-1')], new Set(['s-1']))[0]?.unassigned).toBe(false)
  expect(again.get('s-1')).toBeNull()
  expect(again.listedIds()).toEqual([])
})
