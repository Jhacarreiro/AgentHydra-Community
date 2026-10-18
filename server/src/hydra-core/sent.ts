import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type CatalogEntry, loadText } from './catalog'

export type Sent = Record<string, string[]>

/** Not a session: the chat's lead brief it still owes its next go, as the lead's catalog id. */
const OWED = '(lead owed)'

export function readSent(file: string): Sent {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Sent
  } catch {
    return {}
  }
}

const WEEK = 7 * 24 * 60 * 60 * 1000

/** When each session was last seen, beside sent.json; a session not seen for a week is dropped. */
function seenFile(file: string): string {
  return join(dirname(file), 'sent-seen.json')
}

function readSeen(file: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(seenFile(file), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

/** Writes sent.json; `session` is the one this message came from (seen now), null when none is. */
export function writeSent(
  file: string,
  sent: Sent,
  session: string | null,
  now = new Date(),
): void {
  mkdirSync(dirname(file), { recursive: true })
  const seen = readSeen(file)
  const at = now.toISOString()
  const kept: Sent = {}
  const keptSeen: Record<string, string> = {}
  for (const [key, ids] of Object.entries(sent)) {
    if (key === OWED) {
      kept[key] = ids
      continue
    }
    const last = key === session || !seen[key] ? at : seen[key]
    if (now.getTime() - Date.parse(last) > WEEK) continue
    kept[key] = ids
    keptSeen[key] = last
  }
  writeFileSync(file, JSON.stringify(kept, null, 2))
  writeFileSync(seenFile(file), JSON.stringify(keptSeen, null, 2))
}

export function setLeadOwed(sent: Sent, id: string): void {
  sent[OWED] = [id]
}

export function clearLeadOwed(sent: Sent): void {
  delete sent[OWED]
}

/** The lead brief a chat still owes, taken once: it is cleared from sent.json as it is read. */
export function takeLeadOwed(
  file: string,
  cat: Map<string, CatalogEntry>,
): { id: string; name: string; text: string } | null {
  const sent = readSent(file)
  const id = sent[OWED]?.[0]
  if (!id) return null
  clearLeadOwed(sent)
  writeSent(file, sent, null)
  const e = cat.get(id)
  return e ? { id: e.id, name: e.name, text: loadText(e) } : null
}
