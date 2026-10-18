// The Claude Code sessions of CliMayte workers, each mapped to the session that dispatched the worker, so a page a
// worker opens belongs to its parent chat's ecosystem. Read from the bridge at most every few seconds and shared by
// every browser plugin (one cache per bridge). The full list (every worker AgentHydra ever ran: 27 MB on a busy PC,
// and building it held AgentHydra's thread) is read once; after that the recent list, which holds every active
// worker and the newest finished ones, adds the sessions that appear. A session stays its worker's, so what the map
// learned stays true.

import type { Bridge } from '../bridge'

const TTL_MS = 5000

export type WorkerOrigins = ReadonlyMap<string, string>

const readers = new WeakMap<Bridge, () => Promise<WorkerOrigins>>()

export function workerOrigins(b: Bridge): () => Promise<WorkerOrigins> {
  let read = readers.get(b)
  if (!read) {
    const map = new Map<string, string>()
    let seeded = false
    let readAt = 0
    read = async () => {
      if (readAt && Date.now() - readAt < TTL_MS) return map
      const list = await (seeded ? b.workers() : b.workers({ all: true })).catch(() => null)
      if (list) {
        seeded = true
        for (const w of list) {
          if (!w.originSessionId) continue
          for (const s of w.sessions ?? []) map.set(s, w.originSessionId)
        }
      }
      readAt = Date.now()
      return map
    }
    readers.set(b, read)
  }
  return read
}

/** The sessions plus every worker session dispatched, directly or through other workers, by one of them. */
export function withWorkerSessions(sessions: readonly string[], origins: WorkerOrigins): string[] {
  const out = new Set(sessions)
  for (let grew = true; grew; ) {
    grew = false
    for (const [worker, origin] of origins) {
      if (out.has(origin) && !out.has(worker)) {
        out.add(worker)
        grew = true
      }
    }
  }
  return [...out]
}
