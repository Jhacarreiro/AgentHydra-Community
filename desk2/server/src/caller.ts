// Who asked the server to restart or stop. The window marks its own requests with X-Desk-Caller: window, and the
// launcher's stop.ps1 (which restart.ps1 runs) marks its with launcher. Anything else is an agent or a script: it may
// restart the server onto new code on disk (the owner, 2026-10-12: Menu > Restart to update is an agent's to run, the
// chats running on), but never stop it. Every ask is written to logs/restart.log with what the request said about itself.

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type CallerKind = 'window' | 'launcher' | 'other'

export function callerKind(headers: Headers): CallerKind {
  const kind = headers.get('x-desk-caller')
  return kind === 'window' || kind === 'launcher' ? kind : 'other'
}

export function describeCaller(headers: Headers): string {
  const chat = headers.get('x-desk-chat') ?? 'none'
  const agent = headers.get('user-agent') ?? 'none'
  return `caller=${callerKind(headers)} chat=${chat} user-agent="${agent}"`
}

/** A log line never fails the ask it describes: a locked or unwritable file is reported on the server log and dropped. */
export function logRestartAsk(home: string, line: string): void {
  try {
    mkdirSync(join(home, 'logs'), { recursive: true })
    appendFileSync(join(home, 'logs', 'restart.log'), `${new Date().toISOString()} ${line}\n`)
  } catch (err) {
    console.error(`[restart] could not write restart.log (${(err as Error).message}): ${line}`)
  }
}

export const OWNER_ONLY_STOP =
  "Stopping this server is the owner's: an agent must not stop it. To put new server code live, ask POST /api/server/restart (Menu > Restart to update): the chats run on."

export const NOTHING_TO_UPDATE =
  'This server already runs the code on disk, so there is nothing to restart onto. An agent restarts it only to put new server code live.'

export const RESTART_UNDER_WAY = 'A restart of this server is already under way: wait for it to come back, then look again.'
