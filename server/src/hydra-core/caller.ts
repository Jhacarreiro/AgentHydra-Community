// server/src/hydra-core/caller.ts - who calls core_use or fan_out: its role, its own Desk chat, and the chat key its
// seats are kept under. A Prime is the chat, not the session (ROLES.md), so the key is the Desk chat id whenever
// there is one, whether the caller named its chat by id, session id or title.

import { join } from 'node:path'
import { appendJournal } from '../climayte-journal'
import { type CliMayteRole, roleOf } from '../climayte-lib'
import { POINTER_DIR } from '../instance'
import { api } from '../mcp-client'
import { pickDeskChat } from '../mcp-find'
import { type DeskChat, deskChats } from '../mcp-managers'
import { callerOrigin } from '../mcp-self'
import { appendLog } from './log'
import { chatKeyOk } from './paths'

/** The CliMayte journal (climayte-core's JOURNAL_PATH), built here so the MCP server never loads the daemon side. */
const JOURNAL_PATH = join(POINTER_DIR, 'corch', 'journal.jsonl')

export type SeatParent = DeskChat & { parentId?: string }

type WorkerRow = {
  id?: string
  group?: string
  title?: string
  role?: CliMayteRole
  chat?: boolean
  desk?: { manager?: string; chatId?: string }
}

export interface Caller {
  /** Undefined: the daemon could not tell who calls (`why` says how the trace failed). */
  role: CliMayteRole | undefined
  /** The CliMayte worker the caller is, when it is one. */
  worker: WorkerRow | null
  /** The caller's own Desk chat id: its worker's chat, or the Desk chat whose session it is. */
  deskChat: string | null
  why: string | null
}

/** The calling session's worker row and Desk chat, from the route's caller binding (callerOrigin); with no traced
 *  caller, the env worker id (a stdio MCP, where this process is the caller). */
export async function traceCaller(
  a: Record<string, unknown>,
  chats?: SeatParent[] | null,
): Promise<Caller> {
  const { origin, why } = await callerOrigin(a)
  let worker: WorkerRow | null = null
  let listed = false
  if (origin) {
    const rows = await api(
      `/api/corch/workers?session=${encodeURIComponent(origin.sessionId)}&all=1`,
    ).catch(() => null)
    listed = Array.isArray(rows)
    worker = Array.isArray(rows) ? ((rows[0] as WorkerRow | undefined) ?? null) : null
  } else {
    const id = process.env.AGENTHYDRA_CLIMAYTE_WORKER?.trim()
    if (id)
      worker = (await api(`/api/corch/workers/${encodeURIComponent(id)}`).catch(
        () => null,
      )) as WorkerRow | null
  }
  const own =
    worker?.desk?.chatId ??
    (origin ? chats?.find((c) => c.sessionId === origin.sessionId)?.id : undefined) ??
    null
  // As mcp-self callerRole: a session's list row carries its role (toView); the detail row may predate roles.
  // A traced session that no CliMayte worker owns is the owner's chat, Desk or not: a Prime (ROLES.md).
  const role = worker
    ? origin
      ? worker.role
      : roleOf(worker)
    : own || listed
      ? ('prime' as const)
      : undefined
  return {
    role,
    worker,
    deskChat: own,
    why: role ? null : (why ?? "the daemon's worker list could not be read"),
  }
}

/** The words a caller AgentHydra could not tie to a chat gets back: how to call so the trace works. No role named. */
export function untracedRefusal(what: string, why: string | null): string {
  return `AgentHydra could not tell which chat is calling${why ? ` (${why})` : ''}, so this call cannot ${what}. Make the call from the chat's own Claude Code session, through the AgentHydra MCP server that session runs: a call from a script, curl or another process cannot be traced to a chat.`
}

/** The Desk chat `ref` names: an id or session id exactly, or a title fragment among chats that are no seat (a
 *  seat's title holds its Prime's, so a title would otherwise match both). Null when no Desk chat matches. */
export function deskChatOf(chats: SeatParent[], ref: string): SeatParent | null {
  const r = ref.trim()
  if (!r) return null
  const pool = chats.filter((c) => !c.parentId || c.id === r || c.sessionId === r)
  try {
    return pickDeskChat(pool, r) as SeatParent
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('no Desk chat matches')) return null
    throw err
  }
}

export interface ChatOfCaller {
  /** The chat key seats and picks are kept under: the Desk chat id when there is one, else the key passed. */
  key: string
  /** The Desk chat a seat opens under; null when the chat has no Desk row. */
  desk: SeatParent | null
  /** Keys the same chat was filed under before (a title or session id the caller passed). */
  aliases: string[]
}

/** The chat a consult or hire is for, bound to the caller: a Prime opens seats only for its own chat. */
export function chatOfCaller(
  caller: Caller,
  chats: SeatParent[] | null,
  raw: string,
): ChatOfCaller {
  const named = chats && raw ? deskChatOf(chats, raw) : null
  const own = caller.deskChat
    ? (chats?.find((c) => c.id === caller.deskChat) ?? { id: caller.deskChat })
    : null
  if (own && named && named.id !== own.id)
    throw new Error(
      `core_use works only for the calling chat: "${raw}" is Desk chat ${named.id}, and this chat is ${own.id}. Leave chat out, or pass this chat's id.`,
    )
  const desk = own ?? named
  const key = desk?.id ?? raw
  if (!key) throw new Error('no chat: pass chat, or run inside a Desk chat (HYDRA_DESK_CHAT_ID)')
  const aliases = [raw, desk?.sessionId ?? ''].filter(
    (k, i, all) => k && k !== key && chatKeyOk(k) && all.indexOf(k) === i,
  ) as string[]
  return { key, desk, aliases }
}

/** The caller's chat and role for core_use consult / hire: Desk chats read once, the caller traced once. */
export async function callerAndChat(
  a: Record<string, unknown>,
  raw: string,
): Promise<{ caller: Caller; chat: ChatOfCaller }> {
  const chats = (await deskChats().catch(() => null)) as SeatParent[] | null
  const caller = await traceCaller(a, chats)
  // A caller that is refused anyway is not bound to a chat first (use() refuses it).
  if (caller.role === 'drone' || caller.role === 'seat')
    return { caller, chat: { key: raw, desk: null, aliases: [] } }
  return { caller, chat: chatOfCaller(caller, chats, raw) }
}

/** A refused call, journaled on the caller's worker (CliMayte journal `refused`) and in the Hydra Core log, then
 *  thrown. The words the caller reads never name its role (ROLES.md: a drone is never told it is one). */
export function refuse(
  caller: Caller,
  notice: string,
  log?: { dir: string; chat: string; mode: string; id?: string },
): never {
  const w = caller.worker
  if (w?.id)
    appendJournal(JOURNAL_PATH, {
      ts: new Date().toISOString(),
      id: w.id,
      group: w.group ?? '',
      title: w.title ?? '',
      event: 'refused',
      ...(caller.role ? { role: caller.role } : {}),
      notice,
    })
  if (log)
    appendLog(log.dir, {
      chat: log.chat,
      event: 'refused',
      mode: log.mode,
      ...(log.id ? { id: log.id } : {}),
      caller: caller.role ?? 'untraced',
      ...(w?.id ? { worker: w.id } : {}),
    })
  throw new Error(notice)
}
