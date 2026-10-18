// A Codex chat's rollout file, and how full its context window is, read-only. Codex writes every thread to
// <codex home>/sessions/<yyyy>/<mm>/<dd>/rollout-<started>-<thread id>.jsonl, and after each turn a `token_count` event
// whose `info` holds the last turn's `last_token_usage` and the model's `model_context_window`: unlike Claude Code's file,
// enough for a share. Desk reaches an outside Codex chat's transcript through AgentHydra's tail, which carries neither.

import { statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readTail, TAIL_BYTES } from './session-jsonl'

/** A thread id that can only name a rollout: no dots, no separators. */
const THREAD_ID = /^[A-Za-z0-9-]{8,80}$/

const newestFirst = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [] as string[])).sort().reverse()

/** The thread's rollout under any of the homes, or null: its day folder (the newest first), or archived_sessions/, where Codex
 *  moves an archived thread's file, flat (an Unassigned chat is archived on its account). */
export async function findCodexRollout(threadId: string, homes: readonly string[]): Promise<string | null> {
  if (!THREAD_ID.test(threadId)) return null
  const tail = `-${threadId}.jsonl`
  const inDir = async (dir: string) => {
    const hit = (await readdir(dir).catch(() => [] as string[])).find((f) => f.startsWith('rollout-') && f.endsWith(tail))
    return hit ? join(dir, hit) : null
  }
  for (const home of homes) {
    const root = join(home, 'sessions')
    for (const y of await newestFirst(root))
      for (const m of await newestFirst(join(root, y)))
        for (const d of await newestFirst(join(root, y, m))) {
          const hit = await inDir(join(root, y, m, d))
          if (hit) return hit
        }
    const archived = await inDir(join(home, 'archived_sessions'))
    if (archived) return archived
  }
  return null
}

/** The tokens in context after the thread's last turn and the model's window (null when its event names none), from the newest
 *  `token_count` event with a last turn's usage; null when the file's end has none. */
export function lastCodexContext(path: string): { tokens: number; window: number | null } | null {
  const size = statSync(path).size
  for (const max of [256 * 1024, TAIL_BYTES]) {
    const lines = readTail(path, max).split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!
      if (!line.includes('"token_count"')) continue
      try {
        const rec = JSON.parse(line) as { payload?: { type?: unknown; info?: { last_token_usage?: { total_tokens?: unknown }; model_context_window?: unknown } | null } }
        const info = rec.payload?.type === 'token_count' ? rec.payload.info : null
        const tokens = info?.last_token_usage?.total_tokens
        if (typeof tokens !== 'number' || !(tokens > 0)) continue
        const window = info?.model_context_window
        return { tokens, window: typeof window === 'number' && window > 0 ? window : null }
      } catch {
        // the tail's first line may be cut
      }
    }
    if (size <= max) break
  }
  return null
}

/** The event_msg types that open and close a Codex turn: every turn starts with `task_started` and ends with `task_complete`, or
 *  `turn_aborted` when it was stopped (read 2026-10-14 over the 40 newest rollouts: 176 started, 174 complete, 1 aborted, 1 open). */
const TURN_MARK = /"type":"(task_started|task_complete|turn_aborted)"/
export const TURN_TAIL_BYTES = 256 * 1024

/** Whether the thread's last turn is still open: its newest turn mark is `task_started`. A tail holding no mark at all, from a
 *  file longer than the tail, is a turn whose own output has filled the tail since it started, so open too. */
export function codexTurnOpen(path: string): boolean {
  const size = statSync(path).size
  const lines = readTail(path, TURN_TAIL_BYTES).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"event_msg"')) continue
    const mark = TURN_MARK.exec(line)?.[1]
    if (!mark) continue
    try {
      if ((JSON.parse(line) as { payload?: { type?: unknown } }).payload?.type !== mark) continue
    } catch {
      continue // the tail's first line may be cut
    }
    return mark === 'task_started'
  }
  return size > TURN_TAIL_BYTES
}
