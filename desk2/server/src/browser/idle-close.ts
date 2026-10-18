// Closes a saved browser's headless Chrome once no tool call has touched its profile for browserIdleMinutes. A call in
// flight, a login not yet verified, a sign-in window, a live view in the Browser pane or a visible window keeps it open;
// the next browser call relaunches it, with its logins kept in the profile folder.

import { resolve } from 'node:path'
import { clearClosing, markClosing, readActivity, type DirActivity } from './agent/activity'
import { scopedKey } from './agent/handoff'
import { launchedHeadless } from './agent/session'
import { readSignInWindow } from './agent/sign-in-window'
import { anyLiveSession, closeBrowser, liveBrowser } from './cdp'
import { readRegistry } from './profiles-write'
import { profileFolders } from './tab-sweep'
import { storeRoot } from './store'

export const IDLE_CHECK_MS = 60_000

export interface IdleCloseDeps {
  liveBrowser(dir: string): Promise<{ port: number } | null>
  headless(dir: string): boolean
  liveView(port: number): boolean
  signInHeld(dir: string): boolean
  loginPending(dir: string): boolean
  activity(): Map<string, DirActivity>
  markClosing(dir: string): void
  clearClosing(dir: string): void
  close(dir: string): Promise<boolean>
  log(msg: string): void
}

/** Returns sweep(dirs, idleMs): closes the idle headless profiles among dirs and answers the folders closed. A folder's idle time starts when it first looks idle or at its last call, whichever is later. */
export function makeIdleCloser(
  deps: IdleCloseDeps,
  now: () => number = Date.now,
): (dirs: readonly string[], idleMs: number) => Promise<string[]> {
  const eligibleSince = new Map<string, number>()

  const eligible = async (dir: string): Promise<boolean> => {
    const live = await deps.liveBrowser(dir)
    return live !== null && deps.headless(dir) && !deps.liveView(live.port) && !deps.signInHeld(dir) && !deps.loginPending(dir)
  }

  return async (dirs, idleMs) => {
    const started = now()
    const activity = deps.activity()
    const closed: string[] = []
    for (const dir of dirs) {
      const key = resolve(dir)
      if ((activity.get(key)?.busy ?? 0) > 0 || !(await eligible(dir))) {
        eligibleSince.delete(key)
        continue
      }
      const since = eligibleSince.get(key) ?? started
      eligibleSince.set(key, since)
      if (started - Math.max(since, activity.get(key)?.last ?? 0) < idleMs) continue
      deps.markClosing(dir)
      try {
        const fresh = deps.activity().get(key)
        if ((fresh?.busy ?? 0) > 0 || (fresh?.last ?? 0) >= started) {
          eligibleSince.delete(key)
          continue
        }
        if (await deps.close(dir)) {
          deps.log(`[desk] closed the idle headless browser in ${dir}: no tool call for ${idleMs / 60_000} minutes`)
          closed.push(dir)
        }
        eligibleSince.delete(key)
      } finally {
        deps.clearClosing(dir)
      }
    }
    return closed
  }
}

function loginPending(root: string, dir: string): boolean {
  const profiles = readRegistry().profiles
  const entry = profiles && typeof profiles === 'object' ? (profiles as Record<string, Record<string, unknown>>)[scopedKey(root, dir)] : undefined
  if (!entry || typeof entry.loginOpenedAt !== 'string') return false
  if (typeof entry.loginVerifiedAt !== 'string') return true
  return Date.parse(entry.loginVerifiedAt) < Date.parse(entry.loginOpenedAt)
}

function profileDeps(home: string): IdleCloseDeps {
  return {
    liveBrowser,
    headless: launchedHeadless,
    liveView: anyLiveSession,
    signInHeld: (dir) => readSignInWindow(dir) !== null,
    loginPending: (dir) => loginPending(storeRoot(), dir),
    activity: () => readActivity(home),
    markClosing: (dir) => markClosing(home, dir),
    clearClosing: (dir) => clearClosing(home, dir),
    close: closeBrowser,
    log: (msg) => console.log(msg),
  }
}

/** One pass over the saved profiles of this Desk home. The closer, and with it each folder's idle clock, lives across passes. */
export function makeIdleTick(o: {
  home: string
  idleMinutes: () => number
  root?: string
  deps?: (home: string) => IdleCloseDeps
  now?: () => number
}): () => Promise<string[]> {
  const sweep = makeIdleCloser((o.deps ?? profileDeps)(o.home), o.now)
  return async () => sweep(profileFolders(o.root ?? storeRoot()), o.idleMinutes() * 60_000)
}

/** Runs the idle close over the saved profiles every IDLE_CHECK_MS (unref'd). Returns the stop. */
export function startIdleBrowserClose(o: {
  home: string
  idleMinutes: () => number
  root?: string
  everyMs?: number
}): () => void {
  const pass = makeIdleTick(o)
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await pass()
    } catch (err) {
      console.error('[desk] the idle browser close failed:', err)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), o.everyMs ?? IDLE_CHECK_MS)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
