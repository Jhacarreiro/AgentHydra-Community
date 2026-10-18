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
// Each socket is held under the credential it was let in with: a PC token's id, or 'legacy' for the shared token of
// before (codex-hub-pcs.ts). The route refuses everything else before the upgrade; once a socket is open, a change
// of that PC's credential (paired again, revoked, retired, moved, forgotten) closes it with RELAY_REFUSED
// (closeRelayUnless), and every Desk session on it ends with the reason.

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
  /** Closes the socket with `why`, and `code` (1000 unless said). */
  close(why: string, code?: number): void
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

/**
 * The close code a socket refused because another install held its PC's name was sent. The hub refuses that before
 * the upgrade now; pushers from before still know the code, so it stays.
 */
export const RELAY_NAME_TAKEN = 4409
/** The close code for a live socket whose credential changed: the PC waits its longest before it dials again. */
export const RELAY_REFUSED = 4403

interface Pc {
  link: PcLink
  /** The install id its pusher sent, or null for one from before install ids. */
  install: string | null
  /** The credential it was let in with: a PC token's id, or 'legacy' (codex-hub-pcs.ts). */
  tokenId: string
}

const pcs = new Map<string, Pc>()
const sessions = new Map<string, Session>()

/** PC keys with a live relay socket. */
export function relayPcs(): Set<string> {
  return new Set(pcs.keys())
}

/** The install id behind PC `key`'s live socket: null for a pusher that sent none, undefined with no socket. */
export function relayPcInstall(key: string): string | null | undefined {
  return pcs.get(key)?.install
}

/** The credential behind PC `key`'s live socket (a token id, or 'legacy'); undefined with no socket. */
export function relayPcToken(key: string): string | undefined {
  return pcs.get(key)?.tokenId
}

function endSession(sid: string, why: string): void {
  const s = sessions.get(sid)
  if (!s) return
  sessions.delete(sid)
  s.desk.closed(why)
}

/**
 * A PC connected with credential `tokenId`. A second socket from the same PC replaces the first (a reconnect the hub
 * has not noticed yet); one that may not act for this PC was refused before it got here (routes/codex-hub.ts).
 */
export function relayPcConnected(
  key: string,
  link: PcLink,
  install: string | null,
  tokenId: string,
): void {
  const old = pcs.get(key)?.link
  pcs.set(key, { link, install, tokenId })
  if (old && old !== link) relayPcGone(key, old, 'The PC connected again.')
}

/**
 * A PC's socket closed, or is closed here with `code`: every session on it ends with `why`. `link` guards against a
 * replaced socket's late close.
 */
export function relayPcGone(
  key: string,
  link: PcLink,
  why = 'The PC went offline.',
  code = 1000,
): void {
  if (pcs.get(key)?.link === link) pcs.delete(key)
  for (const [sid, s] of [...sessions]) if (s.link === link) endSession(sid, why)
  try {
    link.close(why, code)
  } catch {
    // already closed
  }
}

/**
 * Closes PC `key`'s live socket with RELAY_REFUSED and `why`, unless it holds credential `keep` (null keeps none).
 * Answers whether one was closed.
 */
export function closeRelayUnless(key: string, keep: string | null, why: string): boolean {
  const pc = pcs.get(key)
  if (!pc || (keep !== null && pc.tokenId === keep)) return false
  relayPcGone(key, pc.link, why, RELAY_REFUSED)
  return true
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
  const link = pcs.get(key)?.link
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
