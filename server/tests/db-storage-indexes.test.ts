// server/src/db.ts - the storage migration (docs/STORAGE-PLAN.md piece 10).
// The sessions list and the edits cap rely on these indexes; a fresh file must come up with them,
// in incremental auto-vacuum mode, stamped with the schema version, and every later start on that
// file must leave it as it is.

import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db, reclaimFreePages } from '../src/db'

const names = () =>
  db
    .query<{ name: string }, []>("select name from sqlite_master where type = 'index'")
    .all()
    .map((r) => r.name)
const one = (sql: string) => Object.values(db.query<Record<string, number>, []>(sql).get() ?? {})[0]

describe('db storage migration', () => {
  test('hot-query indexes exist and the dead ones are gone', () => {
    const have = names()
    expect(have).toContain('idx_scan_cache_thread')
    expect(have).toContain('idx_scan_cache_limit')
    expect(have).toContain('idx_session_edits_ts_id')
    expect(have).not.toContain('idx_session_edits_ts')
    expect(have).not.toContain('session_stats_gone')
  })

  test('the thread_key list read is served by the partial index', () => {
    const plan = db
      .query<{ detail: string }, []>(
        'explain query plan select cache_key, thread_key from session_scan_cache where thread_key is not null and scan_version >= 1',
      )
      .all()
      .map((r) => r.detail)
      .join(' ')
    expect(plan).toContain('idx_scan_cache_thread')
  })

  test('versioned, incremental auto-vacuum, and reclaiming is safe', () => {
    // 2 since piece 12 (usage_samples); a fresh file runs every step and ends on the newest.
    expect(one('pragma user_version')).toBe(2)
    expect(one('pragma auto_vacuum')).toBe(2)
    expect(reclaimFreePages()).toBeGreaterThanOrEqual(0)
  })
})

// The checks above read the one fresh file this process opened, so they cannot see what a later
// start does to it: session_stats_gone was created on every start and dropped only by the version-1
// step, so a fresh file came up without it and every later start put it back. Each start here is a
// child Bun, because db.ts opens its file at import and `bun test` shares one module cache.
describe('db storage migration across restarts', () => {
  const home = mkdtempSync(join(tmpdir(), 'agenthydra-db-restart-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))
  const DB_MOD = JSON.stringify(join(import.meta.dir, '..', 'src', 'db.ts'))
  const SPAWNS_A_CHILD_BUN = 30_000

  /** One daemon start's worth of db.ts on `file`: the schema it leaves and its version stamp. */
  function start(file: string): { version: number; schema: string[] } {
    const proc = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `const { db } = await import(${DB_MOD});
         const schema = db.query("select type || ' ' || name || ': ' || coalesce(sql, '') as s from sqlite_master order by type, name").all().map((r) => r.s);
         console.log(JSON.stringify({ version: db.query('pragma user_version').get().user_version, schema }));`,
      ],
      {
        env: {
          ...process.env,
          AGENTHYDRA_HOME: home,
          AGENTHYDRA_DB: file,
          AGENTHYDRA_DATA_DIR: join(home, 'data'),
          AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const out = proc.stdout.toString().trim()
    if (!proc.success || !out) throw new Error(`child failed: ${proc.stderr.toString() || out}`)
    return JSON.parse(out.slice(out.lastIndexOf('\n') + 1))
  }

  test(
    'a second start leaves the schema exactly as the first left it',
    () => {
      const file = join(home, 'restart.db')
      const first = start(file)
      expect(first.schema.join('\n')).not.toContain('session_stats_gone')
      expect(start(file)).toEqual(first)
    },
    2 * SPAWNS_A_CHILD_BUN,
  )

  test(
    'a start drops the session_stats_gone an older build put back, and keeps the rows',
    () => {
      // A build from before the fix, sharing the file (the Desk, the CLI, an older checkout), creates
      // the index on every start and leaves user_version as it is: the file carries it at the newest
      // version, past any step that could drop it once.
      const file = join(home, 'shared.db')
      const fresh = start(file)
      const older = new Database(file)
      older.exec('create index if not exists session_stats_gone on session_stats(gone_at)')
      older.exec(
        "insert into session_stats (session_key, session_id, source, cost_usd, gone_at) values ('k', 's', 'claude', 1.5, 7)",
      )
      older.close()
      expect(start(file)).toEqual(fresh)
      const after = new Database(file, { readonly: true })
      expect(after.query('select session_key, cost_usd, gone_at from session_stats').all()).toEqual(
        [{ session_key: 'k', cost_usd: 1.5, gone_at: 7 }],
      )
      after.close()
    },
    2 * SPAWNS_A_CHILD_BUN,
  )
})
