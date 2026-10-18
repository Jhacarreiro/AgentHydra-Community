// server/src/core/fs-slots.ts - one process-wide ceiling on async filesystem calls in flight.
//
// ⛔ WHY (2026-10-12, Bun 1.4.3 on Windows). Bun runs each async fs call (stat, readdir, readFile,
// Bun.file reads) on a thread of its I/O pool, starts a new thread whenever every one is busy, and
// never gives one back. Each holds ~6.6 MB committed. stat of 37,290 files grew the pool by 5 threads
// with 4 calls in flight, 10 with 8, 19 with 16 and 31 with 32 (+205 MB committed, still held 70 s
// after going idle); an unbounded Promise.all readdir walk of 8,702 folders added 31 threads and
// +246 MB. The daemon's sweeps each ran their own pool (32 here, 16 there, unbounded walks), and
// when they overlapped the pool reached 56 threads. A pool width bounds one fan-out; only a shared
// ceiling bounds them all. Throughput barely moves: 37k stats took 1,058 ms with 8 in flight against
// 843 ms with 32.
//
// Wrap the fs call itself, never a function that takes a slot of its own (a walker that recurses
// inside its slot would wait on itself once every slot is held).

const SLOTS = 8

let busy = 0
const waiting: (() => void)[] = []

/** Run `call` once fewer than SLOTS filesystem calls are in flight in this process. */
export async function fsSlot<T>(call: () => Promise<T>): Promise<T> {
  if (busy < SLOTS) busy++
  else await new Promise<void>((resolve) => waiting.push(resolve))
  try {
    return await call()
  } finally {
    // The slot passes straight to the next waiter, so `busy` only falls when nobody waits.
    const next = waiting.shift()
    if (next) next()
    else busy--
  }
}
