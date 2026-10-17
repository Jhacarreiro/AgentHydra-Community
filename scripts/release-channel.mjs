// scripts/release-channel.mjs - release-channel.json for the node release scripts (release-notes.mjs,
// consolidate-releases.mjs). They run under plain node, which cannot import server/src/release-channel.ts, so they
// read the same file here, held to the same rule for "repo". tests/release-channel-drift.test.ts checks that this
// reader and the TypeScript one return the same channel.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'release-channel.json')

// GitHub's own limits on an owner and a repository name (server/src/release-channel.ts says why).
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/
const POLICIES = ['off', 'notify', 'auto']

/** `{ repo, updates }` from release-channel.json, or an Error naming what is wrong with it. */
export function readReleaseChannel(file = FILE) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const repo = raw?.repo
  const updates = raw?.updates
  if (typeof repo !== 'string' || !SLUG.test(repo) || repo.split('/')[1].replace(/\.+/g, '') === '')
    throw new Error(`${file}: "repo" must be a GitHub owner/name, not ${JSON.stringify(repo)}`)
  if (!POLICIES.includes(updates))
    throw new Error(`${file}: "updates" must be one of ${POLICIES.join(', ')}, not ${JSON.stringify(updates)}`)
  return { repo, updates }
}

/** True when two `owner/name` slugs are the same GitHub repository (GitHub ignores case in both). */
export function sameRepo(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}
