// server/src/hydra-core/seats.ts - a seat: one persona's Desk sub-chat under a Prime chat, opened once and resumed.
// The roster is kept under the Prime's Desk chat id (caller.ts chatOfCaller), and every seat chat is listed in
// seat-chats.json, which the daemon reads to give the seat's worker the role `seat` (climayte.ts seatTask).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { deskPost, managerName, transcriptItems } from '../mcp-managers'
import type { ChatOfCaller } from './caller'
import { type CatalogEntry, loadText } from './catalog'
import { chatPaths } from './paths'
import { addSeatChat } from './seat-chats'

export interface Seat {
  chat: string
  title: string
}

type Seats = Record<string, Seat>

function readJson<T>(file: string): T | undefined {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined
  } catch {
    return undefined
  }
}

function writeJson(file: string, v: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`)
}

/** The chat's roster: under its key, merged with any found under a key it was filed by before (a title, a
 *  session id), the key's own seat winning. */
function readRoster(dir: string, chat: Pick<ChatOfCaller, 'key' | 'aliases'>): Seats {
  const old = chat.aliases.map((k) => readJson<Seats>(chatPaths(dir, k).seats) ?? {})
  return Object.assign({}, ...old, readJson<Seats>(chatPaths(dir, chat.key).seats) ?? {})
}

/** The manager whose slug is the persona's id after the colon, when its persona.json exists. */
function managerSlugOf(e: CatalogEntry): string | undefined {
  const slug = e.id.slice(e.id.indexOf(':') + 1)
  try {
    managerName(slug)
    return slug
  } catch {
    return undefined
  }
}

export function seatOf(
  dir: string,
  chat: Pick<ChatOfCaller, 'key' | 'aliases'>,
  e: CatalogEntry,
): Seat | undefined {
  return readRoster(dir, chat)[e.id]
}

/** The persona's seat under the Prime chat: opened with `text` as its first message, or `text` sent to the seat
 *  already open. The chat is made empty and listed as a seat before the first message, so the worker that message
 *  starts is a seat from its birth. */
export async function openOrSend(
  dir: string,
  chat: ChatOfCaller,
  e: CatalogEntry,
  text: string,
  cwd: string | undefined,
): Promise<{ seat: Seat; sentAfter: number | null; opened: boolean }> {
  const parent = chat.desk
  if (!parent) throw new Error(`no Desk chat is "${chat.key}": a seat opens only under a Desk chat`)
  const file = chatPaths(dir, chat.key).seats
  const seats = readRoster(dir, chat)
  const known = seats[e.id]
  if (known) {
    if (!existsSync(file)) writeJson(file, seats)
    const sentAfter = (await transcriptItems(known.chat)).length
    await deskPost(`/api/chats/${encodeURIComponent(known.chat)}/messages`, { text })
    return { seat: known, sentAfter, opened: false }
  }
  const folder = cwd || parent.cwd
  if (!folder) throw new Error('no folder: pass cwd, the calling chat has none')
  const slug = managerSlugOf(e)
  const topic = parent.title?.trim()
  const title = (topic ? `${e.name} · ${topic}` : e.name).slice(0, 200)
  const prompt = slug
    ? text
    : [`You are now a seat in this chat as ${e.name}: ${e.when}.`, loadText(e), text].join('\n\n')
  const created = await deskPost('/api/chats', {
    cwd: folder,
    title,
    parentId: parent.id,
    ...(slug ? { managerSlug: slug } : {}),
  })
  const seat = { chat: String(created.id), title: String(created.title ?? title) }
  addSeatChat(dir, seat.chat, e.id, parent.id)
  writeJson(file, { ...seats, [e.id]: seat })
  await deskPost(`/api/chats/${encodeURIComponent(seat.chat)}/messages`, { text: prompt })
  return { seat, sentAfter: 0, opened: true }
}
