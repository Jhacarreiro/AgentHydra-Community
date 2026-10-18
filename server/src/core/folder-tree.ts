// server/src/core/folder-tree.ts - one listing of a folder tree, kept and shared by every sweep that
// walks it, re-listing only the folders whose mtime moved.
//
// ⛔ WHY (2026-10-12). The transcript index (transcript.ts) and the kit's Claude ingest
// (kit/ingest-claude.ts) both walk the same Claude projects roots, each its own way: the index read
// every folder again on every build (each web-UI poll past its 10 s TTL, and the five-minute title
// sweep), the kit kept its own per-store tree and listed again only folders whose mtime moved. Measured
// on a 68,078-transcript store in 12,159 folders: a full re-list took 361-391 ms and 1.37-1.47 CPU-s, a
// pass that stats each folder and lists none took 196-226 ms and 0.83-0.89 CPU-s. One tree per root now
// serves both.
//
// A folder's mtime moves when an entry is created, removed or renamed in it, so a new transcript is
// seen at the next walk; a file that only grows does not move it, and nothing here needs it to (the
// callers stat files themselves). The exact mtime is kept, not a whole millisecond, so a file created
// just after a listing still moves it. Every folder is listed again at least every FULL_RELIST_MS, and
// whenever a caller asks (`relist`), in case a filesystem misses an update. A folder listed while its mtime
// was still recent is listed again until that mtime is safely old (RACY_MS), since a change in the same
// mtime tick as the listing does not move it.

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fsSlot } from './fs-slots'
import { intern } from './intern'
import { mapPool } from './map-pool'

export interface Folder {
  mtimeMs: number
  /** When this folder was listed (before its stat), for the racy-mtime check in `listed`. */
  listedAt: number
  /** This folder under the tree's root, `/`-separated; '' for the root itself. */
  rel: string
  /** Absolute paths of the subfolders. */
  dirs: string[]
  /** Names of the files in it (not their paths). */
  files: string[]
}

interface Tree {
  folders: Map<string, Folder>
  fullAt: number
  running: Promise<ReadonlyMap<string, Folder>> | null
}

const FULL_RELIST_MS = 10 * 60_000
/**
 * A folder whose mtime is not at least this much older than its listing may have changed within the same
 * mtime tick as that listing without moving the mtime (NTFS directory times can lag too), so it is listed
 * again on the next walk until its mtime is safely in the past (the racy-git rule).
 */
const RACY_MS = 2_000
/** Folders listed at once; each call also takes an fsSlot. */
const WIDTH = 4

const trees = new Map<string, Tree>()

/**
 * Every folder under `root` (keyed by absolute path, the root included) as of now: each folder is stat'd
 * and listed again only when its mtime moved since the last walk, or when `relist` is set. A caller
 * that asks while a walk of the same root runs joins it. A missing root is an empty tree.
 */
export function walkFolderTree(
  root: string,
  opts: { relist?: boolean } = {},
): Promise<ReadonlyMap<string, Folder>> {
  let tree = trees.get(root)
  if (!tree) {
    tree = { folders: new Map(), fullAt: 0, running: null }
    trees.set(root, tree)
  }
  if (tree.running) return tree.running
  const t = tree
  t.running = walk(root, t, opts.relist === true).finally(() => {
    t.running = null
  })
  return t.running
}

async function walk(root: string, tree: Tree, relist: boolean): Promise<Map<string, Folder>> {
  const startedAt = Date.now()
  const full = relist || startedAt - tree.fullAt >= FULL_RELIST_MS
  const known = tree.folders
  const folders = new Map<string, Folder>()
  for (let level: [string, string][] = [[root, '']]; level.length > 0; ) {
    const below: [string, string][] = []
    await mapPool(level, WIDTH, async ([dir, rel]) => {
      const folder = await listed(dir, rel, full ? undefined : known.get(dir))
      if (!folder) return
      folders.set(dir, folder)
      for (const sub of folder.dirs)
        below.push([sub, rel ? `${rel}/${basename(sub)}` : basename(sub)])
    })
    level = below
  }
  tree.folders = folders
  if (full) tree.fullAt = startedAt
  return folders
}

/** The folder as it is now: `known` while its mtime holds, else listed again; null when it is gone. */
async function listed(dir: string, rel: string, known: Folder | undefined): Promise<Folder | null> {
  const listedAt = Date.now()
  const st = await fsSlot(() => stat(dir)).catch(() => null)
  if (!st?.isDirectory()) return null
  if (known && known.mtimeMs === st.mtimeMs && known.listedAt - known.mtimeMs >= RACY_MS)
    return known
  let entries: Dirent[]
  try {
    entries = await fsSlot(() => readdir(dir, { withFileTypes: true }))
  } catch {
    return null
  }
  const folder: Folder = { mtimeMs: st.mtimeMs, listedAt, rel, dirs: [], files: [] }
  for (const e of entries) {
    if (e.isDirectory()) folder.dirs.push(intern(join(dir, e.name)))
    else if (e.isFile()) folder.files.push(e.name)
  }
  return folder
}
