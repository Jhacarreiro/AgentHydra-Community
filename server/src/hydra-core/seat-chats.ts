// server/src/hydra-core/seat-chats.ts - every Desk chat core_use opened as a seat, by its Desk chat id: the persona
// it is and the Prime chat it sits under. seats.ts writes it before the seat's first message; the daemon reads it
// when that message dispatches the seat's worker, which then runs as a seat (climayte.ts seatTask).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatKeyOk, chatPaths } from './paths'

export type SeatChats = Record<string, { persona: string; parent: string }>

export const seatChatsPath = (dir: string): string => join(dir, 'seat-chats.json')

export function readSeatChats(dir: string): SeatChats {
  try {
    const file = seatChatsPath(dir)
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SeatChats) : {}
  } catch {
    return {}
  }
}

/** The seat a Desk chat is, or undefined when it is none. */
export function seatChatOf(dir: string, deskChat: string): SeatChats[string] | undefined {
  return readSeatChats(dir)[deskChat]
}

export function addSeatChat(dir: string, deskChat: string, persona: string, parent: string): void {
  mkdirSync(dir, { recursive: true })
  const all = { ...readSeatChats(dir), [deskChat]: { persona, parent } }
  writeFileSync(seatChatsPath(dir), `${JSON.stringify(all, null, 2)}\n`)
}

/** A Desk chat that was deleted: its core folder goes, and when it was a seat, its seat-chats.json entry and its
 *  place in its Prime's roster go too. */
export function forgetChat(dir: string, deskChat: string): void {
  if (!chatKeyOk(deskChat)) return
  const all = readSeatChats(dir)
  const seat = all[deskChat]
  if (seat) {
    delete all[deskChat]
    writeFileSync(seatChatsPath(dir), `${JSON.stringify(all, null, 2)}\n`)
    const roster = chatKeyOk(seat.parent) ? chatPaths(dir, seat.parent).seats : null
    if (roster && existsSync(roster)) {
      try {
        const seats = JSON.parse(readFileSync(roster, 'utf8')) as Record<string, { chat?: string }>
        for (const [persona, s] of Object.entries(seats))
          if (s.chat === deskChat) delete seats[persona]
        writeFileSync(roster, `${JSON.stringify(seats, null, 2)}\n`)
      } catch {
        // floor-ok: an unreadable roster is left as it is; the seat it names no longer opens
      }
    }
  }
  rmSync(chatPaths(dir, deskChat).root, { recursive: true, force: true })
}
