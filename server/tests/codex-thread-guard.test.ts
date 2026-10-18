import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { holdCodexWriterLock, resetCodexHistoryProjection } from '../src/core/codex-thread-guard'

const THREAD = '0f0f0f0f-1111-4222-8333-444444444444'
const OTHER = '0f0f0f0f-1111-4222-8333-555555555555'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const home = () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-guard-'))
  roots.push(root)
  return root
}

test('the writer lock has one holder at a time, as Codex requires', () => {
  const codexHome = home()
  const first = holdCodexWriterLock(codexHome, THREAD)
  expect(first).not.toBeNull()
  expect(holdCodexWriterLock(codexHome, THREAD)).toBeNull()
  const other = holdCodexWriterLock(codexHome, OTHER)
  expect(other).not.toBeNull()
  other!.release()
  first!.release()
  const again = holdCodexWriterLock(codexHome, THREAD)
  expect(again).not.toBeNull()
  again!.release()
})

test('resetting a thread’s history projection removes only that thread’s rows', () => {
  const codexHome = home()
  const db = new Database(join(codexHome, 'thread_history_1.sqlite'))
  // One commit for the whole fixture: each autocommit is a journal fsync, and nine of them outran
  // the 5 s limit on the Windows runner (5243 ms).
  db.exec('begin')
  db.exec(`
    CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT);
    CREATE TABLE thread_items (thread_id TEXT, item_id TEXT);
    CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER);
  `)
  for (const id of [THREAD, OTHER]) {
    db.query('INSERT INTO thread_turns VALUES (?, ?)').run(id, `${id}-turn`)
    db.query('INSERT INTO thread_items VALUES (?, ?)').run(id, `${id}-item`)
    db.query('INSERT INTO thread_history_projection_state VALUES (?, 42)').run(id)
  }
  db.exec('commit')
  db.close()
  const removed = resetCodexHistoryProjection(codexHome, THREAD)
  expect(removed.thread_turns).toEqual([{ thread_id: THREAD, turn_id: `${THREAD}-turn` }])
  expect(removed.thread_history_projection_state).toHaveLength(1)
  const after = new Database(join(codexHome, 'thread_history_1.sqlite'), { readonly: true })
  for (const table of ['thread_turns', 'thread_items', 'thread_history_projection_state'])
    expect(after.query(`SELECT thread_id FROM ${table}`).all()).toEqual([{ thread_id: OTHER }])
  after.close()
})
