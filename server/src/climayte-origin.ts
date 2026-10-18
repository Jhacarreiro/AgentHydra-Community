// Who dispatched a CliMayte worker, as ids and a title, for the shared queue (core/climayte-queue-sync)
// and the CliMayte list and detail the Desk and AgentHydra windows read. Only the ids and the title
// leave the server: a chat origin also holds its Claude home and transcript path, never sent here.
// The From column reads the origin when there is one (the ping target), else the trace (climayte-trace.ts).
import type { CliMayteOrigin } from './climayte-ping'
import type { CliMayteTrace } from './climayte-trace'

export interface CliMayteOriginFields {
  /** The chat that dispatched it, or the session of the worker that did. */
  originSessionId: string | null
  /** The worker that dispatched it, when a worker did. */
  originWorkerId: string | null
  /** The chat's title (a chat's session only); null when unknown. */
  originTitle: string | null
  /** A readable name for a dispatcher that is no chat: a process's script or a declared label. */
  originLabel: string | null
}

export interface OriginLookup {
  /** The session of a worker that dispatched another worker. */
  sessionOf(workerId: string): string | null
  /** The title of a chat that dispatched a worker. */
  titleOf(sessionId: string): string | null
}

/** Ids only: with no lookups, a chat origin keeps its session id and a worker origin its worker id. */
export const NO_ORIGIN_LOOKUP: OriginLookup = { sessionOf: () => null, titleOf: () => null }

/** The From fields of a worker. With a ping origin, its ids; without one, the trace's (a worker recorded
 *  before traces has neither, and its From is its group, shown by the window). */
export function originFields(
  origin: CliMayteOrigin | undefined,
  lookup: OriginLookup = NO_ORIGIN_LOOKUP,
  trace?: CliMayteTrace,
): CliMayteOriginFields {
  const workerId = origin
    ? origin.kind === 'worker'
      ? origin.workerId
      : null
    : (trace?.workerId ?? null)
  const chatId = origin
    ? origin.kind === 'chat'
      ? origin.sessionId
      : null
    : (trace?.sessionId ?? null)
  return {
    originSessionId: chatId ?? (workerId ? lookup.sessionOf(workerId) : null),
    originWorkerId: workerId,
    originTitle: chatId ? lookup.titleOf(chatId) : null,
    originLabel: trace?.label ?? null,
  }
}
