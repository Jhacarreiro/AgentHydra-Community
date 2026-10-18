// server/src/core/append-in-order.ts - appends to a record file, off the daemon's thread.
//
// A record the daemon only appends to (the ping journal, the ETA ledger) was written with
// appendFileSync on the daemon's one thread, and on a busy disk one append held every route for
// about 3 s (21 s in 7 blocks in 24 h, 2026-10-11). Here the write goes through node:fs/promises,
// and the appends to one file are chained, so its lines land in the order they were asked for.

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const tails = new Map<string, Promise<void>>()

/** Appends `text` to `path` (its folder made when missing) after every earlier append to it. Settles
 *  once the text is written, or once the write failed: a record loses that text, never its caller. */
export function appendInOrder(path: string, text: string): Promise<void> {
  const next = (tails.get(path) ?? Promise.resolve())
    .then(() => mkdir(dirname(path), { recursive: true }))
    .then(() => appendFile(path, text))
    .catch(() => undefined)
  tails.set(path, next)
  void next.then(() => {
    if (tails.get(path) === next) tails.delete(path)
  })
  return next
}
