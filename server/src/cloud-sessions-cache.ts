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
  /** The session that started this one: a Project thread's is its Project's chat. */
  parent_id?: string
  /** The claude.ai Project a thread or a Project's own chat belongs to, by name; absent when unknown. */
  project?: string
  /** The thread's Project chat is archived or gone: the Project was closed, so nothing in it waits on anyone. */
  project_archived?: true
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

/**
 * What each session a Project thread names as its parent turned out to be: the Project's name for a
 * Project's chat, null for any other session. A Project's chat is started over from time to time, so
 * an older thread names one that is no longer listed; this keeps the answer of the one look-up that
 * found out across restarts.
 */
export function readProjectNames(root: string, accountKey: string): Record<string, string | null> {
  try {
    const parsed = JSON.parse(readFileSync(join(root, accountKey, 'projects.json'), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function writeProjectNames(
  root: string,
  accountKey: string,
  names: Record<string, string | null>,
): void {
  const dir = join(root, accountKey)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, 'projects.json.tmp')
  writeFileSync(tmp, JSON.stringify(names))
  renameSync(tmp, join(dir, 'projects.json'))
}

/** Project chat id -> whether it is archived (or gone), for the chats that left the list and were looked up. */
export function readArchivedProjects(root: string, accountKey: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(
      readFileSync(join(root, accountKey, 'projects-archived.json'), 'utf8'),
    )
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function writeArchivedProjects(
  root: string,
  accountKey: string,
  archived: Record<string, boolean>,
): void {
  const dir = join(root, accountKey)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, 'projects-archived.json.tmp')
  writeFileSync(tmp, JSON.stringify(archived))
  renameSync(tmp, join(dir, 'projects-archived.json'))
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
