// Live `.devwebui` reloading (ported from DevWebUI's project-watch.ts): an edit shows up without restarting anything.
//
// What a naive `watch(file)` gets wrong, and so what this does:
// 1. Watch the DIRECTORY. Editors, `git checkout` and any write-temp-then-rename save atomically, replacing the
//    inode; a file watch goes deaf after the first such save.
// 2. Debounce (200 ms): one save emits several events.
// 3. Never trust a partial read: a half-written file is invalid JSON and a rename leaves a window with no file. A
//    failed read is skipped for the next event; an invalid file keeps the last good state (one log line).
// 4. Ignore no-op writes: the raw text is compared with the last one applied.
// 5. The event's file name is advisory (Linux and macOS report the temp file), so any event in a watched folder
//    re-checks that folder's watched files; the byte compare makes a spurious check free.
// 6. fs.watch is a hint, not the source of truth. A folder watch can go quiet (macOS CI on Bun 1.4.3 never reported
//    the second atomic save in a row, DevWebUI 2026-10-10) or lose its folder (a branch switch that removes and
//    restores it). So each file's stat (inode, mtime, size) is also polled every POLL_MS, and a changed stat reloads
//    at once rather than through the debounce, which a stream of events could hold off forever (rule 7). Rule 4
//    makes an unchanged-content poll free. Each tick also re-arms a watch whose folder has come back.
// 7. A watch on a deleted folder does not die on Windows: it reports the folder gone hundreds of times a second under
//    Bun 1.4.3 and over 100,000 times a second under Node 25 (measured 2026-10-10), which kept the debounce from ever
//    firing and burned a core. The first event that finds its folder gone closes that watch.
// One watcher per folder holding a loaded file. The manager owns the reconcile (it is applied, never restarted).

import { existsSync, type FSWatcher, readFileSync, statSync, watch } from 'node:fs'
import path from 'node:path'

export interface WatchHost {
  /** The loaded .devwebui files. */
  files(): string[]
  /** Re-reads the file and reconciles it. Throws when it is invalid (the watcher logs it and keeps the last good state). */
  apply(file: string): void
  log(line: string): void
}

export interface ProjectWatch {
  /** Brings the watchers in step with the loaded files. */
  sync(): void
  stop(): void
  /** The files watched now. */
  watched(): string[]
}

const keyOf = (p: string): string => path.resolve(p).replace(/\\/g, '/').toLowerCase()

// The backstop's period (rule 6): one stat per loaded file per second, negligible next to the event path.
const POLL_MS = 1000

/** Inode + mtime + size: a rename changes the inode, a write changes mtime and size. */
const statStamp = (file: string): string | null => {
  try {
    const s = statSync(file)
    return `${s.ino}:${s.mtimeMs}:${s.size}`
  } catch {
    return null // mid-rename or gone: transient, as for a read
  }
}

export function createProjectWatch(host: WatchHost, debounceMs = 200): ProjectWatch {
  const dirWatchers = new Map<string, FSWatcher>()
  const lastText = new Map<string, string | null>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const realPath = new Map<string, string>()
  /** file key → the stat stamp the poll last saw. */
  const stamps = new Map<string, string | null>()
  let stopped = false

  const readRaw = (file: string): string | null => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return null // mid-rename or gone: transient by assumption
    }
  }

  /** Re-reads a file and applies it. False only when it could not be read, so the poll retries. */
  const reload = (fileKey: string): boolean => {
    if (stopped) return true
    const file = realPath.get(fileKey)
    if (!file) return true
    const raw = readRaw(file)
    // Unreadable or byte-identical to what is applied: nothing to do, and the last text stays so a retry still differs.
    if (raw == null) return false
    if (raw === lastText.get(fileKey)) return true
    lastText.set(fileKey, raw)
    try {
      host.apply(file)
    } catch (e) {
      host.log(`${file}: ${(e as Error).message} (keeping the last good version)`)
    }
    return true
  }

  const schedule = (fileKey: string): void => {
    if (stopped || !lastText.has(fileKey)) return
    const pending = timers.get(fileKey)
    if (pending) clearTimeout(pending)
    timers.set(
      fileKey,
      setTimeout(() => {
        timers.delete(fileKey)
        reload(fileKey)
      }, debounceMs)
    )
  }

  // Rule 6: any file whose stat moved since the last look is reloaded now. A file that is gone keeps its old stamp, so
  // its return reads as a change, and so does one that could not be read yet (mid-rename, a sharing violation): with a
  // dead watch no event would retry it. Then any folder that lost its watch (rule 7) and exists again gets one back.
  const poll = (): void => {
    if (stopped) return
    for (const [k, file] of realPath) {
      const stamp = statStamp(file)
      if (stamp === null || stamp === stamps.get(k)) continue
      if (reload(k)) stamps.set(k, stamp)
    }
    syncDirs()
  }

  const syncDirs = (): void => {
    const needed = new Set<string>()
    for (const file of realPath.values()) needed.add(keyOf(path.dirname(file)))
    for (const [dirKey, w] of dirWatchers) {
      if (needed.has(dirKey)) continue
      w.close()
      dirWatchers.delete(dirKey)
    }
    for (const file of realPath.values()) {
      const dir = path.dirname(file)
      const dirKey = keyOf(dir)
      if (dirWatchers.has(dirKey)) continue
      try {
        const w = watch(dir, { persistent: false }, () => {
          if (stopped) return // an event queued before stop() closed this watch
          // Rule 7: the folder itself is gone, so this watch only storms. The poll re-arms one when it is back.
          if (!existsSync(dir)) {
            w.close()
            if (dirWatchers.get(dirKey) === w) dirWatchers.delete(dirKey)
            return
          }
          for (const [k, f] of realPath) if (keyOf(path.dirname(f)) === dirKey) schedule(k)
        })
        // A watched folder renamed or removed surfaces here: drop the watcher rather than let the error end the service.
        w.on('error', () => {
          w.close()
          // Only if it is still the folder's watcher: a late error from one rule 7 closed must not drop a fresh one.
          if (dirWatchers.get(dirKey) === w) dirWatchers.delete(dirKey)
        })
        dirWatchers.set(dirKey, w)
      } catch {
        // Unwatchable (permissions, just gone): staleness is the cost; it must never stop the service.
      }
    }
  }

  const sync = (): void => {
    if (stopped) return
    const desired = new Map<string, string>()
    for (const f of host.files()) desired.set(keyOf(f), f)
    for (const [k, file] of desired) {
      if (lastText.has(k)) continue
      realPath.set(k, file)
      // Stamped BEFORE the read: a write landing between the two then shows to the poll instead of being lost.
      const stamp = statStamp(file)
      // Primed with the text just loaded, so the first sync reconciles nothing. An unreadable file primes null, and
      // no stamp, so the poll picks it up once it reads.
      const text = readRaw(file)
      stamps.set(k, text === null ? null : stamp)
      lastText.set(k, text)
    }
    for (const k of [...lastText.keys()]) {
      if (desired.has(k)) continue
      lastText.delete(k)
      realPath.delete(k)
      stamps.delete(k)
      const t = timers.get(k)
      if (t) {
        clearTimeout(t)
        timers.delete(k)
      }
    }
    syncDirs()
  }

  // Started once everything the poll calls exists.
  const pollTimer = setInterval(poll, POLL_MS)
  pollTimer.unref()

  return {
    sync,
    stop() {
      stopped = true
      clearInterval(pollTimer)
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      for (const w of dirWatchers.values()) w.close()
      dirWatchers.clear()
      lastText.clear()
      realPath.clear()
      stamps.clear()
    },
    watched: () => [...realPath.values()],
  }
}
