// server/tests/codex-chat-list.test.ts — GET /api/codex-chats lists what each Codex app's sidebar lists.
//
// Desk's sidebar showed one of ten unarchived Codex chats (2026-10-13): it knew a Codex chat only while its
// transcript was fresh. The list now comes from each Codex home's own `threads` table, where most rows are NOT
// sidebar chats: archived chats, sub-agent and `codex exec` threads, and rows whose rollout is gone (measured
// that day: 93 unarchived sub-agent threads and 8 stale rows in one home). The fixture is a real managed instance
// (createCodexInstance, under the preload's scratch CONFIG_DIR) holding one of each.
import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listCodexChats } from '../src/core/codex-chat-list'
import { createCodexInstance, deleteCodexInstance } from '../src/core/codex-instances'

const NAME = `codex-chats-${crypto.randomUUID().slice(0, 8)}`
const created = createCodexInstance(NAME)
const INSTANCE_ID = created.data?.id as string
const HOME = created.data?.codexHome as string

afterAll(async () => {
  await deleteCodexInstance(INSTANCE_ID, NAME, { listDesktopProcesses: async () => [] })
})

function rollout(dir: string, id: string): string {
  const target = join(HOME, dir, '2026', '10', '13')
  mkdirSync(target, { recursive: true })
  const path = join(target, `rollout-2026-10-13T10-00-00-${id}.jsonl`)
  writeFileSync(path, '{}\n')
  return path
}

const DAY = 24 * 3600_000
const OLD = Date.parse('2026-10-06T10:00:00.000Z')
const id = () => crypto.randomUUID()
const named = id()
const untitled = id()
const archived = id()
const subagent = id()
const exec = id()
const gone = id()

const db = new Database(join(HOME, 'state_5.sqlite'), { create: true })
db.run(
  'create table threads (id text primary key, rollout_path text, source text, cwd text, title text, name text, archived integer, updated_at integer, updated_at_ms integer)',
)
const add = (row: [string, string, string, string, string | null, number, number]) => {
  const [tid, path, source, title, name, isArchived, ms] = row
  db.run('insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    tid,
    path,
    source,
    'C:/Users/me/project',
    title,
    name,
    isArchived,
    Math.floor(ms / 1000),
    ms,
  ])
}
add([named, rollout('sessions', named), 'vscode', 'first message', 'A renamed chat', 0, OLD])
add([
  untitled,
  rollout('sessions', untitled),
  'cli',
  'Fix the build\nmore detail',
  null,
  0,
  OLD + DAY,
])
add([
  archived,
  rollout('archived_sessions', archived),
  'vscode',
  'archived',
  'An archived chat',
  1,
  OLD,
])
add([
  subagent,
  rollout('sessions', subagent),
  JSON.stringify({ subagent: { thread_spawn: {} } }),
  'spawned',
  null,
  0,
  OLD,
])
add([exec, rollout('sessions', exec), 'exec', 'exec run', null, 0, OLD])
add([
  gone,
  join(HOME, 'sessions', 'missing.jsonl'),
  'vscode',
  'gone',
  'A chat whose rollout is gone',
  0,
  OLD,
])
db.close()

test("lists the account's unarchived chats a person started, however old, newest first; nothing else", () => {
  const rows = listCodexChats().filter((r) => r.instanceId === INSTANCE_ID)
  expect(rows).toEqual([
    {
      instance: NAME,
      instanceNum: expect.any(Number),
      instanceId: INSTANCE_ID,
      threadId: untitled,
      title: 'Fix the build',
      cwd: 'C:/Users/me/project',
      lastActivityAt: new Date(OLD + DAY).toISOString(),
    },
    {
      instance: NAME,
      instanceNum: expect.any(Number),
      instanceId: INSTANCE_ID,
      threadId: named,
      title: 'A renamed chat',
      cwd: 'C:/Users/me/project',
      lastActivityAt: new Date(OLD).toISOString(),
    },
  ])
})
