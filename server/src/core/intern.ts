// server/src/core/intern.ts - one copy of a string that several long-lived maps hold.
//
// ⛔ WHY (2026-10-12). Several sweeps kept every transcript path they walk, each its own copy: the
// transcript index's stat cache (transcript.ts), the kit sweep's folder tree and its cursors
// (kit/ingest-claude.ts) and the account-token cache (since deleted: nothing read it). A replay of the
// daemon's boot held 300,127 path strings for 64,927 subagent transcripts (51.6 MB of the heap) and
// 93,923 session ids for 20,855. Each of them now stores the string intern() hands back, so they
// share one.
//
// Bounded: the table rotates every ROTATE_MS and keeps only what was interned in the last two
// windows, so a path gone from disk leaves it; a map that still holds an older copy keeps it.

const ROTATE_MS = 24 * 3_600_000

let current = new Map<string, string>()
let previous = new Map<string, string>()
let rotatedAt = Date.now()

/** The table's copy of `s`, which becomes the copy when there is none. */
export function intern(s: string): string {
  const hit = current.get(s)
  if (hit !== undefined) return hit
  const now = Date.now()
  if (now - rotatedAt >= ROTATE_MS) {
    previous = current
    current = new Map()
    rotatedAt = now
  }
  const kept = previous.get(s) ?? s
  current.set(kept, kept)
  return kept
}
