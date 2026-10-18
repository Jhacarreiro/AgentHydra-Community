// Hydra Desk's own marks on outside sessions (SPEC "Session meta"): pinned, archived, unread, a title,
// a sidebar group, a note and the Unassigned holding area per session id, in <home>/session-meta.json, written
// atomically (temp file + rename). They live here because the sessions' own files belong to Claude Desktop or the
// CLI and are never written. The bridge applies them to every external list it answers.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ExternalSession, SessionMeta, SessionMetaPatch } from '@shared/protocol'
import { AsyncFile } from '../async-file'

const UNMARKED: SessionMeta = { title: null, pinned: false, archived: false, unread: false, group: null, note: null, unassigned: false }

const isUnmarked = (m: SessionMeta): boolean => (Object.keys(UNMARKED) as (keyof SessionMeta)[]).every((k) => m[k] === UNMARKED[k])

/**
 * How long an Unassigned mark stands while the chat still shows on an account. The sidebar marks the chat first and
 * then has its account's app archive it, which takes seconds, and a list read before the archive still has the chat
 * on that account. Past this, a marked chat that shows on an account was put there some other way (an agent's
 * move_chat, the app itself), and the mark is dropped.
 */
export const UNASSIGN_GRACE_MS = 2 * 60 * 1000

export class SessionMetaStore {
  readonly file: string
  readonly tombFile: string
  private readonly byId: Map<string, SessionMeta>
  /** When each Unassigned mark was set (UNASSIGN_GRACE_MS); kept in the file beside the marks as `unassignedAt`. */
  private readonly unassignedAt = new Map<string, number>()
  /** When each chat was archived here; kept in the file as `archivedAt`. A mark from before it was kept dates from the
   *  file's last write, the latest it can have been set. */
  private readonly archivedAt = new Map<string, number>()
  private readonly tombs: Set<string>
  private readonly marksWriter: AsyncFile
  private readonly tombWriter: AsyncFile
  private readonly now: () => number

  constructor(home: string, now: () => number = Date.now) {
    this.file = join(home, 'session-meta.json')
    this.tombFile = join(home, 'session-tombstones.json')
    this.now = now
    this.byId = new Map(Object.entries(this.load()))
    this.tombs = new Set(this.loadTombs())
    this.marksWriter = new AsyncFile(this.file)
    this.tombWriter = new AsyncFile(this.tombFile)
  }

  get(sessionId: string): SessionMeta | null {
    const m = this.byId.get(sessionId)
    return m ? { ...m } : null
  }

  /** The sessions of deleted chats: never listed as outside sessions again, not even after a restart. */
  tombstoned(): string[] {
    return [...this.tombs]
  }

  tombstone(sessionIds: string[]): void {
    const fresh = sessionIds.filter((id) => !this.tombs.has(id))
    if (!fresh.length) return
    for (const id of fresh) this.tombs.add(id)
    this.tombWriter.write(JSON.stringify([...this.tombs], null, 2))
  }

  /** Server shutdown: what is not on disk yet is written now. */
  flushSync(): void {
    this.marksWriter.flushSync()
    this.tombWriter.flushSync()
  }

  /** The sessions the bridge keeps listed however old: the pinned ones, and the Unassigned ones (on no account, so no app lists them). */
  listedIds(): string[] {
    return [...this.byId].filter(([, m]) => m.pinned || m.unassigned).map(([id]) => id)
  }

  /** Applies the patch and writes the file now; a session left with no marks is dropped from it. */
  patch(sessionId: string, p: SessionMetaPatch): SessionMeta {
    const prev = this.byId.get(sessionId)
    const next: SessionMeta = { ...UNMARKED, ...prev }
    for (const k of Object.keys(UNMARKED) as (keyof SessionMeta)[]) if (p[k] !== undefined) Object.assign(next, { [k]: p[k] })
    if (next.unassigned && !prev?.unassigned) this.unassignedAt.set(sessionId, this.now())
    if (!next.unassigned) this.unassignedAt.delete(sessionId)
    if (next.archived && !prev?.archived) this.archivedAt.set(sessionId, this.now())
    if (!next.archived) this.archivedAt.delete(sessionId)
    if (isUnmarked(next)) this.byId.delete(sessionId)
    else this.byId.set(sessionId, next)
    this.save()
    return { ...next }
  }

  /**
   * The list with each session's marks on it (its title replaced when renamed here). `onAccount`: the sessions an
   * account's app lists now (unarchived). Such a session is not Unassigned whatever its mark says, and a mark older
   * than UNASSIGN_GRACE_MS on one is dropped. A chat archived here and used since, in its own app or by anyone, is
   * shown again and its mark dropped, as a mail app brings back an archived thread with a new reply (owner, 2026-10-14:
   * a Codex chat its app showed and used was missing from the sidebar under a mark set here hours before).
   */
  apply(list: ExternalSession[], onAccount: ReadonlySet<string> = new Set()): ExternalSession[] {
    return list.map((s) => {
      const m = this.byId.get(s.id)
      if (!m) return s
      let unassigned = m.unassigned
      if (unassigned && onAccount.has(s.id)) {
        unassigned = false
        if (this.now() - (this.unassignedAt.get(s.id) ?? 0) > UNASSIGN_GRACE_MS) this.patch(s.id, { unassigned: false })
      }
      let archived = m.archived
      if (archived && (s.lastActivityAt ?? 0) > (this.archivedAt.get(s.id) ?? Number.POSITIVE_INFINITY)) {
        archived = false
        this.patch(s.id, { archived: false })
      }
      return { ...s, title: m.title ?? s.title, pinned: m.pinned, archived, unread: m.unread, group: m.group, note: m.note, unassigned }
    })
  }

  /** A missing or unreadable file is no marks; malformed entries are skipped. */
  private load(): Record<string, SessionMeta> {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const written = statSync(this.file).mtimeMs
    const out: Record<string, SessionMeta> = {}
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const m = v as Partial<SessionMeta> & { unassignedAt?: unknown; archivedAt?: unknown }
      out[id] = {
        title: typeof m.title === 'string' ? m.title : null,
        pinned: m.pinned === true,
        archived: m.archived === true,
        unread: m.unread === true,
        group: typeof m.group === 'string' ? m.group : null,
        note: typeof m.note === 'string' && m.note ? m.note : null,
        unassigned: m.unassigned === true,
      }
      if (m.unassigned === true) this.unassignedAt.set(id, typeof m.unassignedAt === 'number' ? m.unassignedAt : 0)
      if (m.archived === true) this.archivedAt.set(id, typeof m.archivedAt === 'number' ? m.archivedAt : written)
    }
    return out
  }

  private loadTombs(): string[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.tombFile, 'utf8'))
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  private save(): void {
    const rows = [...this.byId].map(([id, m]) => {
      const at = this.unassignedAt.get(id)
      const archivedAt = this.archivedAt.get(id)
      return [id, { ...m, ...(at === undefined ? {} : { unassignedAt: at }), ...(archivedAt === undefined ? {} : { archivedAt }) }] as const
    })
    this.marksWriter.write(JSON.stringify(Object.fromEntries(rows), null, 2))
  }
}
