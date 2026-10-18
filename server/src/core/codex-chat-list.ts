// server/src/core/codex-chat-list.ts — every Codex account's unarchived chats, as its Codex app lists them.
//
// WHY. Desk's sidebar listed a Codex chat only while its transcript had been written in the last 10 minutes, so
// with ten unarchived chats on two accounts it showed one (owner, 2026-10-13: "There's only one chat unarchived ...
// I know that's untrue"). The transcript index cannot answer this: it says which files exist, not which threads
// the Codex app shows. Codex keeps that in each home's state database (`state_<n>.sqlite`, table `threads`): the
// app's thread/list reads it, `archived` is set when a chat is archived, and `source` says whether a person
// started it (`vscode` from the desktop app, `cli` from the terminal) or Codex did (a sub-agent's thread, a
// `codex exec` run), which thread/list leaves out. Measured 2026-10-13: the default home's table held 93
// unarchived sub-agent threads and 8 unarchived chats whose rollouts were gone, none of them in any Codex app.
//
// Read-only: the database is opened readonly and never written; a home whose read fails serves its last answer.

import { Database } from 'bun:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { type CodexInstanceStore, codexInstanceStores } from './codex-instances'

/** The thread sources thread/list shows by default: chats a person started. */
const INTERACTIVE_SOURCES = new Set(['vscode', 'cli'])

export interface CodexChatRow {
  /** The Codex instance's name, as the transcript index names it. */
  instance: string
  /** Its permanent number (#60), 0 when the number registry could not be read. */
  instanceNum: number
  /** `default` or the managed instance's uuid. */
  instanceId: string
  /** The thread id, which is the session id the transcript index keys the chat on. */
  threadId: string
  title: string
  cwd: string | null
  /** When Codex last updated the thread (ISO), the order its app's sidebar uses. */
  lastActivityAt: string | null
}

/** The newest state database in a Codex home (`state_5.sqlite` as of Codex 0.162), or null. */
function stateDb(codexHome: string): string | null {
  let best: { n: number; name: string } | null = null
  try {
    for (const name of readdirSync(codexHome)) {
      const m = /^state_(\d+)\.sqlite$/.exec(name)
      if (m && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), name }
    }
  } catch {
    return null
  }
  return best ? join(codexHome, best.name) : null
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** A first message as a title: its first non-empty line, as the Codex app shortens it. */
const firstLine = (v: unknown): string =>
  text(v)
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim() ?? ''

function readHome(store: CodexInstanceStore): CodexChatRow[] {
  const path = stateDb(store.codexHome)
  if (!path) return []
  const db = new Database(path, { readonly: true })
  try {
    // `select *`: a home the current Codex has not opened yet may lack the newer columns (name, updated_at_ms).
    const rows = db.query('select * from threads where archived = 0').all() as Record<
      string,
      unknown
    >[]
    const archivedDir = `${sep}archived_sessions${sep}`
    return rows.flatMap((r) => {
      const rollout = text(r.rollout_path)
      // A row whose transcript is gone (or was moved to the archive) is not in the Codex app.
      if (
        !INTERACTIVE_SOURCES.has(text(r.source)) ||
        !rollout ||
        rollout.includes(archivedDir) ||
        !existsSync(rollout)
      )
        return []
      const ms =
        typeof r.updated_at_ms === 'number'
          ? r.updated_at_ms
          : typeof r.updated_at === 'number'
            ? r.updated_at * 1000
            : null
      const id = text(r.id)
      return [
        {
          instance: store.name,
          instanceNum: store.num,
          instanceId: store.id,
          threadId: id,
          title: text(r.name) || firstLine(r.title) || firstLine(r.first_user_message) || id,
          cwd: text(r.cwd) || null,
          lastActivityAt: ms ? new Date(ms).toISOString() : null,
        },
      ]
    })
  } finally {
    db.close()
  }
}

const lastRead = new Map<string, CodexChatRow[]>()

/** Every Codex home's unarchived chats, newest first. A home whose database cannot be read now serves its last answer. */
export function listCodexChats(): CodexChatRow[] {
  const out: CodexChatRow[] = []
  for (const store of codexInstanceStores()) {
    let rows: CodexChatRow[]
    try {
      rows = readHome(store)
      lastRead.set(store.codexHome, rows)
    } catch {
      rows = lastRead.get(store.codexHome) ?? []
    }
    out.push(...rows)
  }
  return out.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
}
