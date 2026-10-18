// server/src/climayte-store-writer.ts - CliMayte's store files, written off the daemon's thread.
//
// save() wrote done/<id>.json, workers.json (200 KB) and the removals synchronously on the thread
// that serves every route: 31.4 s in 24 h of the live log (2026-10-11), in ~0.5 s blocks, almost all
// under the tick's changed() -> save(). A save takes 2 ms on an idle disk; the blocks were the disk
// stalling, and the rename retry spinning while Defender or the indexer held workers.json.
//
// Now the callers make the text on the thread and queue it here. Each round runs in order on one
// chain: its files, then the store, then its removals (climayte-core save: a finished worker is filed
// before it leaves workers.json and unfiled after it is back there). Saves asked for while a round
// runs merge into the next round, the newest text per file winning. A round the disk refuses is kept
// under anything newer and tried again by the next save or after RETRY_MS: save() has already marked
// its workers filed, so a dropped round could leave a finished worker in neither file. Every graceful
// exit awaits flushCliMayteStore (index.ts).

import { rm } from 'node:fs/promises'
import { fsSlot } from './core/fs-slots'
import { writeJsonTextAtomic } from './core/json-store'
import { mapPool } from './core/map-pool'

/** done/ files written at once; only a burst of finished workers makes many. */
const WIDTH = 16
const RETRY_MS = 5_000

interface Round {
  /** Each file's new text, or null to remove it once the store is written. */
  files: Map<string, string | null>
  store: { path: string; text: string } | null
}

interface Chain {
  queue: (round: Round) => void
  /** Wait for every queued round; a refused one is tried once more now rather than at its retry. */
  settle: () => Promise<void>
}

function chain(): Chain {
  let next: Round | null = null
  let running: Promise<void> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null

  const mergeIntoNext = (round: Round): void => {
    if (!next) {
      next = { files: new Map(round.files), store: round.store }
      return
    }
    for (const [path, text] of round.files) next.files.set(path, text)
    if (round.store) next.store = round.store
  }
  const kick = (): void => {
    if (running || !next) return
    running = drain().finally(() => {
      running = null
    })
  }
  const drain = async (): Promise<void> => {
    while (next) {
      const round = next
      next = null
      try {
        await write(round)
      } catch (err) {
        console.error('[climayte] could not write the store; trying again:', err)
        const newer = next
        next = round
        if (newer) mergeIntoNext(newer)
        retry ??= setTimeout(() => {
          retry = null
          kick()
        }, RETRY_MS)
        retry.unref?.()
        return
      }
    }
  }
  return {
    queue: (round) => {
      mergeIntoNext(round)
      kick()
    },
    settle: async () => {
      if (retry) clearTimeout(retry)
      retry = null
      kick()
      while (running) await running
    },
  }
}

/** workers.json with done/ in its order; walls.json and live.json on their own, so a file held
 *  there never holds the store back. */
const storeChain = chain()
const sideChain = chain()

/** Queue `files` to be written before `store`, and removed (null) after it. */
export function queueStoreWrite(
  files: Map<string, string | null>,
  store: Round['store'] = null,
): void {
  storeChain.queue({ files, store })
}

/** Queue one file kept beside the store, in no order with it. */
export function queueSideWrite(path: string, text: string): void {
  sideChain.queue({ files: new Map([[path, text]]), store: null })
}

/** Wait, at most `ms`, for every queued write to reach the disk. */
export async function flushCliMayteStore(ms = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const out = new Promise<void>((r) => {
    timer = setTimeout(r, ms)
  })
  await Promise.race([Promise.all([storeChain.settle(), sideChain.settle()]), out])
  clearTimeout(timer)
}

async function write({ files, store }: Round): Promise<void> {
  const writes: [string, string][] = []
  const removes: string[] = []
  for (const [path, text] of files) {
    if (text === null) removes.push(path)
    else writes.push([path, text])
  }
  await settleAll(writes, ([path, text]) => writeJsonTextAtomic(path, text))
  if (store) await writeJsonTextAtomic(store.path, store.text)
  await settleAll(removes, (path) => rm(path, { force: true }))
}

/** Every one settled before the first failure is thrown: a write still running from a refused round
 *  could otherwise land after the retry's newer text for the same file. */
async function settleAll<T>(items: T[], fn: (item: T) => Promise<unknown>): Promise<void> {
  const failures = await mapPool(items, WIDTH, (item) =>
    fsSlot(() => fn(item)).then(
      () => null,
      (err: unknown) => ({ err }),
    ),
  )
  const failed = failures.find((f) => f !== null)
  if (failed) throw failed.err
}
