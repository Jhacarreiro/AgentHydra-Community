// server/src/cloud-sessions-cache.ts - the on-disk mirror of claude.ai's Claude Code session list.
//
// Split from cloud-sessions.ts so the foreign adapter that reads it does not pull in the poller,
// the status store or any network code: reading a cache must stay a pure file read.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The catalog row's envVar: where the cache lives, and so where the foreign adapter looks. */
export const CLOUD_SESSIONS_DIR_ENV = 'AGENTHYDRA_CLOUD_SESSIONS_DIR'

/** What the cache keeps per session: the API item reduced to what the adapter and status need. */
export interface CloudSessionRow {
  id: string
  title: string
  environment_kind: string
  status_bucket: string
  worker_status: string
  unread: boolean
  created_at: string | null
  last_event_at: string
  /** The session's tags; `hearth-thread` marks a thread of a claude.ai Project. Absent in older caches. */
  tags?: string[]
}

export function cloudSessionsRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env[CLOUD_SESSIONS_DIR_ENV]?.trim() || join(home, '.agenthydra', 'cloud-sessions')
}

/** Written whole and renamed into place, so the adapter never reads half a file. */
export function writeCloudSnapshot(
  root: string,
  accountKey: string,
  rows: CloudSessionRow[],
): void {
  const dir = join(root, accountKey)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, 'sessions.json.tmp')
  writeFileSync(tmp, JSON.stringify({ written_at: new Date().toISOString(), sessions: rows }))
  renameSync(tmp, join(dir, 'sessions.json'))
}

export function readCloudSnapshot(dir: string): CloudSessionRow[] {
  try {
    const snap = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')) as {
      sessions?: CloudSessionRow[]
    }
    return Array.isArray(snap?.sessions) ? snap.sessions : []
  } catch {
    return []
  }
}
