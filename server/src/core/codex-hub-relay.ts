// server/src/core/codex-hub-relay.ts — the hub's half of continuing another PC's Codex chat.
//
// A pushed chat (codex-hub.ts) is a copy: writing to it means a turn on the PC that has it, by that PC's own
// Codex. The PC cannot be reached from here (behind its router, often asleep), so it reaches out: its pusher
// (codex-hub-relay-pc.ts) keeps one WebSocket open to the hub while it runs. When Desk continues one of its chats,
// Desk opens an app-server "on" that PC through the daemon (routes/codex-hub.ts), and the hub asks the PC to start
// `codex app-server` and carries its JSON-RPC lines both ways, unread. So everything Desk does with a local
// app-server (resume, turns, streamed items, approvals and questions answered in the window) works unchanged.
//
// The wire between hub and PC is JSON messages, several app-servers on one socket told apart by `sid`:
//   hub -> PC  { t: 'open', sid }        start an app-server for this session
//              { t: 'line', sid, line }  one JSON-RPC line for its stdin
//              { t: 'close', sid }       end it (Desk let go)
//   PC -> hub  { t: 'line', sid, line }  one line from its stdout
//              { t: 'exit', sid, why }   it ended, or never started
// The PC decides what its app-server may be asked (codex-hub-relay-pc.ts): the hub is not trusted with more.

import { randomUUID } from 'node:crypto'

export type RelayToPc =
  | { t: 'open'; sid: string }
  | { t: 'line'; sid: string; line: string }
  | { t: 'close'; sid: string }
export type RelayFromPc =
  | { t: 'line'; sid: string; line: string }
  | { t: 'exit'; sid: string; why: string }

/** A PC's live socket, as the route hands it over. */
export interface PcLink {
  send(msg: RelayToPc): void
  close(why: string): void
}

/** Desk's end of one app-server session. */
export interface DeskEnd {
  line(line: string): void
  closed(why: string): void
}

/** What Desk holds: write a line, or end the session. */
export interface RelaySession {
  write(line: string): void
  close(): void
}

interface Session {
  pc: string
  /** The socket its app-server runs behind: it dies with that socket, not with the PC's next one. */
  link: PcLink
  desk: DeskEnd
}

const pcs = new Map<string, PcLink>()
const sessions = new Map<string, Session>()

/** PC keys with a live relay socket. */
export function relayPcs(): Set<string> {
  return new Set(pcs.keys())
}

function endSession(sid: string, why: string): void {
  const s = sessions.get(sid)
  if (!s) return
  sessions.delete(sid)
  s.desk.closed(why)
}

/** A PC connected. A second socket from the same PC replaces the first (a reconnect the hub has not noticed yet). */
export function relayPcConnected(key: string, link: PcLink): void {
  const old = pcs.get(key)
  pcs.set(key, link)
  if (old && old !== link) relayPcGone(key, old, 'The PC connected again.')
}

/** A PC's socket closed: every session on it ends. `link` guards against a replaced socket's late close. */
export function relayPcGone(key: string, link: PcLink, why = 'The PC went offline.'): void {
  if (pcs.get(key) === link) pcs.delete(key)
  for (const [sid, s] of [...sessions]) if (s.link === link) endSession(sid, why)
  try {
    link.close(why)
  } catch {
    // already closed
  }
}

/** One message from a PC's socket. Anything malformed or for a session it does not carry is dropped. */
export function relayFromPc(link: PcLink, raw: string): void {
  let msg: Partial<RelayFromPc>
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  const s = typeof msg.sid === 'string' ? sessions.get(msg.sid) : undefined
  if (!s || s.link !== link) return
  if (msg.t === 'line' && typeof msg.line === 'string') s.desk.line(msg.line)
  else if (msg.t === 'exit')
    endSession(msg.sid!, typeof msg.why === 'string' ? msg.why : 'Codex stopped on the PC.')
}

/** Starts an app-server on PC `key` for Desk; null when that PC is not connected. */
export function openRelaySession(key: string, desk: DeskEnd): RelaySession | null {
  const link = pcs.get(key)
  if (!link) return null
  const sid = randomUUID()
  sessions.set(sid, { pc: key, link, desk })
  link.send({ t: 'open', sid })
  return {
    write: (line) => {
      if (sessions.has(sid)) link.send({ t: 'line', sid, line })
    },
    close: () => {
      if (sessions.delete(sid)) link.send({ t: 'close', sid })
    },
  }
}
