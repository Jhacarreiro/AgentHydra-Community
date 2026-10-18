import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function managersDir(): string {
  return process.env.AGENTHYDRA_MANAGERS_DIR || join(homedir(), '.agenthydra', 'managers')
}

export function analyticsDir(): string {
  return join(managersDir(), 'analytics')
}

export const ROUTES_FILE = 'routes.jsonl'
export const TURNS_FILE = 'turns.jsonl'
export const STATE_FILE = 'state.json'
export const SUMMARY_FILE = 'summary.json'

export function analyticsPath(name: string): string {
  return join(analyticsDir(), name)
}

export function appendJsonl(name: string, rows: object[]): void {
  if (rows.length === 0) return
  mkdirSync(analyticsDir(), { recursive: true })
  appendFileSync(analyticsPath(name), rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
}

export function readJsonl<T = Record<string, unknown>>(name: string): T[] {
  const file = analyticsPath(name)
  if (!existsSync(file)) return []
  const out: T[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      // A torn final line from an interrupted append is skipped; the next pass rewrites nothing.
    }
  }
  return out
}

export interface OpenTurn {
  turn: string
  session: string
  deskChat: string | null
  manager: string
  /** Start of the turn: its prompt's time. */
  since: number
  lastTs: number
  /** The Desk chat's live state at the last check; null when no check ran. */
  working: boolean | null
}

export interface CollectState {
  v: 1
  lastPassAt: number | null
  transcripts: Record<
    string,
    {
      path: string
      /** Byte offset of the first line of the still-open turn; everything before it is final. */
      cursor: number
      /** Id of the last final turn whose next-message signal is still to be written. */
      prevTurn: string | null
      /** Byte offset of the last real prompt read, so the next pass can classify against its text. */
      lastPrompt?: number | null
      open?: OpenTurn | null
      /** When the path was last searched for (ms), so a missing or quiet one is re-looked only every few minutes. */
      pathLookedAt?: number
    }
  >
}

export function emptyState(): CollectState {
  return { v: 1, lastPassAt: null, transcripts: {} }
}

export function readState(): CollectState {
  const file = analyticsPath(STATE_FILE)
  if (!existsSync(file)) return emptyState()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CollectState
    return parsed?.v === 1 && parsed.transcripts ? parsed : emptyState()
  } catch {
    return emptyState()
  }
}

export function writeJsonAtomic(name: string, value: unknown): void {
  mkdirSync(analyticsDir(), { recursive: true })
  const file = analyticsPath(name)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, file)
}
