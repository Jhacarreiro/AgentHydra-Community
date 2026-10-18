// Outside chats (core/README.md, "Store"): Claude sessions on disk and Codex threads, read where they are. The list and the
// rows are Desk 2's own (bridge/external.ts mapExternal), the transcripts its own readers (bridge/session-jsonl.ts); the
// daemon answers the index and the Codex tails, as Desk's bridge asks it.
import { homedir } from 'node:os'
import {
  type AhCliInstance,
  type AhCodexChatRow,
  type AhSessionRow,
  type AhTail,
  createClient,
} from '../../desk2/server/src/bridge/client'
import { mapExternal, tailToItems } from '../../desk2/server/src/bridge/external'
import {
  claudeProjectRoots,
  findSessionJsonlAsync,
  sessionJsonlOlder,
  sessionJsonlPage,
} from '../../desk2/server/src/bridge/session-jsonl'
import type { ExternalSession, History, Page } from './types'

/** The list is read at most this often: a thread made a moment ago shows within a minute. */
const LIST_FRESH_MS = 5_000
/** The Claude projects folders are re-read at most this often (Desk's ROOTS_FRESH_MS plays the same role). */
const ROOTS_FRESH_MS = 60_000
/** Items per daemon tail page: Desk's first read (120), and its older read (200). */
const TAIL_LIMIT = 120
const OLDER_LIMIT = 200

const noAgents = { agentStatus: [], live: [], chats: [], workers: [] }

export function history(): History {
  const client = createClient()
  let listed: { at: number; rows: ExternalSession[] } | null = null
  /** The last answer of each read, kept when a read fails (as Desk's keepLast does), so one failed poll empties nothing. */
  const kept: { sessions: AhSessionRow[]; codex: AhCodexChatRow[] } = { sessions: [], codex: [] }
  let roots: { at: number; dirs: string[] } | null = null

  /** The 24 hours' index rows and Codex threads, mapped as Desk's list maps them. Cached LIST_FRESH_MS unless `fresh`. */
  async function list(fresh = false): Promise<ExternalSession[]> {
    if (!fresh && listed && Date.now() - listed.at < LIST_FRESH_MS) return listed.rows
    const [sessions, codex] = await Promise.allSettled([client.sessions(), client.codexChats()])
    if (sessions.status === 'fulfilled') kept.sessions = sessions.value
    if (codex.status === 'fulfilled') kept.codex = codex.value
    // A session the index lists is listed whatever its age, as the 24 hours' window asks; Desk's zswarm rule still holds.
    const wanted = new Set(
      kept.sessions.filter((s) => s.source !== 'zswarm').map((s) => s.session_id),
    )
    const rows = mapExternal(
      { ...noAgents, sessions: kept.sessions, codexChats: kept.codex, wanted },
      new Set(),
      Date.now(),
    )
    listed = { at: Date.now(), rows }
    return rows
  }

  /** One session by id: the list, a fresh list, else its own index row (a session older than the list's window). */
  async function find(id: string): Promise<ExternalSession | null> {
    const hit =
      (await list()).find((s) => s.id === id) ?? (await list(true)).find((s) => s.id === id)
    if (hit) return hit
    const row = await client.session(id).catch(() => null)
    if (!row) return null
    return (
      mapExternal({ ...noAgents, sessions: [row], wanted: new Set([id]) }, new Set()).find(
        (s) => s.id === id,
      ) ?? null
    )
  }

  /** The Claude projects folders: the default home plus each CLI instance's config dir, re-read every ROOTS_FRESH_MS. */
  async function projectRoots(): Promise<string[]> {
    if (!roots || Date.now() - roots.at >= ROOTS_FRESH_MS) {
      const instances: AhCliInstance[] = await client.cliInstances().catch(() => [])
      roots = {
        at: Date.now(),
        dirs: claudeProjectRoots(
          instances.map((i) => i.configDir),
          homedir(),
        ),
      }
    }
    return roots.dirs
  }

  /** A Claude session's JSONL file, if one is on disk. Codex threads have none: they are read from the daemon. */
  async function jsonlOf(row: ExternalSession): Promise<string | null> {
    if (row.source === 'codex') return null
    return findSessionJsonlAsync(row.id, await projectRoots(), row.cwd)
  }

  function tailPage(t: AhTail): Page {
    const start = t.history_start ?? 0
    return { items: tailToItems(t), olderBefore: start > 0 ? start : null }
  }

  return {
    list: () => list(),

    find,

    async tail(id) {
      const row = await find(id)
      if (!row) return null
      const file = await jsonlOf(row)
      if (file) {
        // The whole session file's last page; what is above it is older()'s, from the byte the page begins at.
        const { items, start } = sessionJsonlPage(file)
        return { items, olderBefore: start > 0 ? start : null }
      }
      const t = await client.tail(id, TAIL_LIMIT).catch(() => null)
      return t && !t.error ? tailPage(t) : null
    },

    async older(id, before) {
      // A byte offset: a whole, positive number. Anything else (negative, fractional, NaN, past 2^53) answers nothing.
      if (!Number.isSafeInteger(before) || before <= 0) return null
      const row = await find(id)
      if (!row) return null
      const file = await jsonlOf(row)
      if (file) {
        // sessionJsonlOlder reads the file through to its cut, so the page is the whole of what is above it.
        const items = await sessionJsonlOlder(file, before).catch(() => null)
        return items ? { items, olderBefore: null } : null
      }
      const t = await client.tail(id, OLDER_LIMIT, before).catch(() => null)
      return t && !t.error ? tailPage(t) : null
    },
  }
}
