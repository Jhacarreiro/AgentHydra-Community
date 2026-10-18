// The index of a whole transcript, built from the same items the transcript route answers, so a window that holds only
// the newest page still knows every message, the live checklist and the background tasks (shared/protocol.ts TranscriptIndex).
import type { ToolTally, TranscriptIndex, TranscriptItem } from '@shared/protocol'

/** The window's Finished list keeps this many finished tasks (web tasks/logic.ts FINISHED_CAP is its own, larger, cap). */
export const RECENT_TASKS = 20

type TaskItem = Extract<TranscriptItem, { kind: 'task' }>
const TASK_STATUSES = new Set<string>(['running', 'completed', 'failed', 'stopped'])

const firstLine = (s: string): string =>
  s
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) ?? ''

/** How often each tool was called and how many of those calls failed, the most called first (then by name). */
export function tallyTools(items: readonly TranscriptItem[]): ToolTally[] {
  const by = new Map<string, ToolTally>()
  for (const item of items) {
    if (item.kind !== 'tool_use') continue
    const t = by.get(item.name) ?? { name: item.name, calls: 0, errors: 0 }
    t.calls++
    if (item.status === 'error') t.errors++
    by.set(item.name, t)
  }
  return [...by.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
}

/** What the whole items hold: user messages (kind 'user', as the transcript draws them), the newest `todos` item, the
 *  running background tasks and the last RECENT_TASKS finished ones (kind 'task' with a settled status, as panelLists reads them),
 *  and how often each tool was called. */
export function buildTranscriptIndex(items: readonly TranscriptItem[]): TranscriptIndex {
  const userMessages: TranscriptIndex['userMessages'] = []
  const runningTasks: TaskItem[] = []
  const finished: TaskItem[] = []
  let latestTodos: TranscriptItem | null = null
  let lastUserText = ''
  items.forEach((item, position) => {
    if (item.kind === 'user') {
      userMessages.push({ id: item.id, position, firstLine: firstLine(item.text), images: item.images?.length ?? 0 })
      lastUserText = item.text
    } else if (item.kind === 'todos') {
      latestTodos = item
    } else if (item.kind === 'task' && TASK_STATUSES.has(item.status ?? '')) {
      if (item.status === 'running') runningTasks.push(item)
      else finished.push(item)
    }
  })
  return { total: items.length, userMessages, latestTodos, runningTasks, recentTasks: finished.slice(-RECENT_TASKS), lastUserText, tools: tallyTools(items) }
}
