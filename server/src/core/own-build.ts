// server/src/core/own-build.ts — which AgentHydra build this daemon is, as the queue snapshot shares it.
// Read once and kept: the commit comes from the release stamp or the checkout's HEAD (`git rev-parse`),
// its date from one `git show` (a release binary has no checkout, so its build time stands in). Both git
// runs go off the daemon's thread: on it they held every route for about 2 s at each boot's first queue
// sync (24.5 s in 24 h of restarts, 2026-10-11).

import { buildInfo, headSha } from '../build-info'
import type { QueueBuild } from '../climayte-remote'
import { spawnCaptured } from './process'

let cached: QueueBuild | null | undefined
let reading: Promise<QueueBuild | null> | null = null

/** This daemon's build once readOwnBuild has answered; null before that, and when it cannot be read. */
export function ownBuild(): QueueBuild | null {
  return cached ?? null
}

/** Reads this daemon's build the first time it is asked, and keeps it. */
export function readOwnBuild(): Promise<QueueBuild | null> {
  if (cached !== undefined) return Promise.resolve(cached)
  reading ??= read().then((build) => {
    cached = build
    return build
  })
  return reading
}

async function read(): Promise<QueueBuild | null> {
  try {
    const info = buildInfo({ git: false })
    const git = (args: string[]) =>
      spawnCaptured(['git', ...args], { cwd: import.meta.dir, wantStderr: false })
    let commit = info.commit
    if (!commit && !info.release) {
      const head = await git(['rev-parse', 'HEAD'])
      commit = head.code === 0 ? headSha(head.stdout) : null
    }
    let date: string | null = info.builtAt
    if (commit && !info.release) {
      const show = await git(['show', '-s', '--format=%cI', commit])
      const out = show.code === 0 ? show.stdout.trim() : ''
      if (out && !Number.isNaN(Date.parse(out))) date = new Date(out).toISOString()
    }
    return { version: info.version, commit: commit?.slice(0, 7) ?? null, date }
  } catch {
    return null
  }
}
