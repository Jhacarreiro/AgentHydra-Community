// server/src/core/account-holders.ts — which ACCOUNT each CLI instance was signed in to, and since
// when, so a transcript message is credited to the account that wrote it (owner, 2026-10-03: tokens
// are tracked on the account logged in, not on the instance). The kit's Claude ingest
// (kit/ingest-claude.ts) notes the holders on every sweep and reads them per message.
//
// A CLI instance keeps no record of past logins, so each sweep notes who holds it now
// (`account-holders.json`, uuids only) and the message's own timestamp picks the holder in force
// then. MESSAGES FROM BEFORE ANY RECORDED LOGIN go to the first account ever recorded for the
// instance (the first entry starts at 0): on the day this was added that is the account the
// instance holds, and an instance's transcripts were nearly all written under its one login. If the
// first thing recorded is "signed out", older messages are credited to nobody. A switch is noticed
// at the next sweep (at most a minute while the app is open), so a message written between the real
// switch and that sweep still goes to the old holder: the known error. A signed-out gap that ends
// in the SAME account (an unreadable file, a login veto that cleared) is dropped, not recorded.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { accountHoldersFile, appDataDir } from './paths'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface Holder {
  uuid: string | null
  since: number
}
export type Holders = Record<string, Holder[]>

export function readHolders(): Holders {
  try {
    const file = accountHoldersFile()
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function writeHolders(holders: Holders): void {
  try {
    const dir = appDataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = accountHoldersFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(holders, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // Best effort: the change is noticed again at the next sweep.
  }
}

/** The account a CLI config folder is signed in as (its `.claude.json` oauthAccount), null when
 *  signed out or unreadable. Identity only, never a token. */
export function cliAccountUuid(configDir: string, loggedIn: boolean): string | null {
  if (!loggedIn) return null // logging out removes the credentials but leaves oauthAccount behind
  try {
    return accountUuidOfClaudeJson(readFileSync(join(configDir, '.claude.json'), 'utf8'))
  } catch {
    return null
  }
}

/** The account uuid a `.claude.json` names (its oauthAccount), null when absent or unreadable. */
export function accountUuidOfClaudeJson(text: string): string | null {
  try {
    const uuid = JSON.parse(text)?.oauthAccount?.accountUuid
    return typeof uuid === 'string' && UUID.test(uuid) ? uuid.toLowerCase() : null
  } catch {
    return null
  }
}

/** Apply "this instance holds `uuid` at `now`" to its history; true when the history changed. */
export function noteHolder(history: Holder[], uuid: string | null, now: number): boolean {
  const last = history[history.length - 1]
  if (!last) {
    history.push({ uuid, since: 0 }) // from before any recorded login: see the header
    return true
  }
  if (last.uuid === uuid) return false
  const before = history[history.length - 2]
  if (last.uuid === null && before && before.uuid === uuid) {
    history.pop() // a signed-out blink that ended in the same account
    return true
  }
  history.push({ uuid, since: now })
  return true
}

/** The account holding the instance at `ts`: the last entry that began at or before it. */
export function holderAt(history: Holder[], ts: number): string | null {
  let who: string | null = null
  for (const h of history) {
    if (h.since > ts) break
    who = h.uuid
  }
  return who
}
