// server/tests/sessions-archived-unread.test.ts — the "Not archived" list keeps a chat that was put
// away before anyone read it.
//
// Found 2026-10-14: a chat was archived on its account 25 s after that
// account hit a usage limit, still unread and not done, and the sidebar's default filter (Not
// archived) never showed it, whatever apps were ticked. Pinned here through the same listSessions the
// route calls: a recent, unread, not-done archived chat is on the Not archived list and still says
// archived; a read one, a done one and one quiet for over a week stay off it.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'agenthydra-archived-unread-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const projectDir = join(home, '.claude', 'projects', 'D--demo')
mkdirSync(projectDir, { recursive: true })

const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(home, '.claude', 'projects'),
  AGENTHYDRA_HOME: join(home, '.agenthydra'),
  AGENTHYDRA_DB: join(home, 'test.db'),
  AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
  AGENTHYDRA_INSTANCES_ROOT: join(home, '.claude-instances'),
}
const SRC = (file: string) => JSON.stringify(join(import.meta.dir, '..', 'src', file))
const SPAWNS_A_CHILD_BUN = 30_000

const LIVE = 'bbbbbbbb-0000-4000-8000-000000000001' // not archived
const UNREAD = 'bbbbbbbb-0000-4000-8000-000000000002' // archived before anyone read it
const READ = 'bbbbbbbb-0000-4000-8000-000000000003' // archived after it was read
const DONE = 'bbbbbbbb-0000-4000-8000-000000000004' // archived unread, but marked done
const OLD = 'bbbbbbbb-0000-4000-8000-000000000005' // archived unread, quiet for 30 days

const nowSec = Math.floor(Date.now() / 1000)

function transcript(sessionId: string, mtimeSec: number): void {
  const turn = (uuid: string, role: 'user' | 'assistant', ts: string) =>
    JSON.stringify({
      type: role,
      uuid,
      message: { role, content: 'hello', ...(role === 'assistant' ? { model: 'claude-x' } : {}) },
      cwd: 'D:\\demo',
      timestamp: ts,
    })
  const path = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(
    path,
    `${turn(`u-${sessionId}`, 'user', '2026-01-01T10:00:00.000Z')}\n${turn(`a-${sessionId}`, 'assistant', '2026-01-01T10:00:05.000Z')}\n`,
  )
  utimesSync(path, mtimeSec, mtimeSec)
}

/** One Desktop metadata file, in the layout the real store uses. Unread is the app's own test:
 *  the last activity is newer than the last time the app focused the chat. */
function desktopRecord(sessionId: string, archived: boolean, unread: boolean): void {
  const dir = join(home, '.claude-instances', 'acct', 'claude-code-sessions', 'org', 'user')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `local_${sessionId}.json`),
    JSON.stringify({
      cliSessionId: sessionId,
      isArchived: archived,
      lastActivityAt: 2_000,
      lastFocusedAt: unread ? 1_000 : 3_000,
    }),
  )
}

transcript(LIVE, nowSec - 60)
transcript(UNREAD, nowSec - 120)
transcript(READ, nowSec - 180)
transcript(DONE, nowSec - 240)
transcript(OLD, nowSec - 30 * 86_400)
desktopRecord(LIVE, false, false)
desktopRecord(UNREAD, true, true)
desktopRecord(READ, true, false)
desktopRecord(DONE, true, true)
desktopRecord(OLD, true, true)

interface Row {
  id: string
  archived: boolean
}
let listed: { active: Row[]; archived: Row[] } | null = null

/** Both single-state lists, in a cold process, with DONE marked done the way the route marks it. */
function list(): { active: Row[]; archived: Row[] } {
  if (listed) return listed
  const body = `
    const { db } = await import(${SRC('db.ts')});
    db.query('insert into session_marks (session_id, done, updated_at) values (?, 1, ?)').run(${JSON.stringify(DONE)}, Date.now());
    const { listSessions } = await import(${SRC('sessions.ts')});
    const pick = (rows) => rows.map((r) => ({ id: r.session_id, archived: r.archived }));
    const active = pick(await listSessions({ limit: 50, sinceMs: null, archived: 'active' }));
    const archived = pick(await listSessions({ limit: 50, sinceMs: null, archived: 'archived' }));
    console.log(JSON.stringify({ active, archived }));`
  const proc = Bun.spawnSync([process.execPath, '-e', body], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = proc.stdout.toString().trim()
  if (!proc.success || !out) throw new Error(`child failed: ${proc.stderr.toString() || out}`)
  listed = JSON.parse(out.slice(out.lastIndexOf('\n') + 1))
  return listed as { active: Row[]; archived: Row[] }
}
const ids = (rows: Row[]) => rows.map((r) => r.id).sort()

test(
  'Not archived lists a recent archived chat nobody read, and its row still says archived',
  () => {
    const { active } = list()
    expect(ids(active)).toEqual([LIVE, UNREAD].sort())
    expect(active.find((r) => r.id === UNREAD)?.archived).toBe(true)
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'Archived still lists every archived chat, the unread one included',
  () => {
    expect(ids(list().archived)).toEqual([UNREAD, READ, DONE, OLD].sort())
  },
  SPAWNS_A_CHILD_BUN,
)
