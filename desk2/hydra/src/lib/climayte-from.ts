// Who dispatched a CliMayte task, for the list's From cell and the detail's From line. The server gives the
// ids, a chat's title and a process's label (server climayte-origin.ts, climayte-trace.ts); a worker's title
// comes from the tasks already loaded.
import type { CliMayteWorkerView } from './api'

export type CliMayteFrom =
  /** A chat: its title, or its short session id while the title is unknown. */
  | { kind: 'chat'; sessionId: string; label: string }
  /** A CliMayte worker that dispatched it, labelled with that worker's title (its id while the title is not loaded). */
  | { kind: 'worker'; workerId: string; label: string }
  /** A process that is no chat: its script (folder/file) or what the dispatcher declared. */
  | { kind: 'process'; label: string }
  /** Recorded before traces existed: the task's group is the only fact there is. */
  | { kind: 'group'; group: string }

type FromFields = Pick<
  CliMayteWorkerView,
  'group' | 'originSessionId' | 'originWorkerId' | 'originTitle' | 'originLabel'
>

export function climayteFrom(
  w: FromFields,
  tasks: ReadonlyArray<Pick<CliMayteWorkerView, 'id' | 'title'>>,
): CliMayteFrom {
  if (w.originWorkerId) {
    const title = tasks.find((x) => x.id === w.originWorkerId)?.title?.trim()
    return { kind: 'worker', workerId: w.originWorkerId, label: title || w.originWorkerId }
  }
  if (w.originSessionId) {
    return {
      kind: 'chat',
      sessionId: w.originSessionId,
      label: w.originTitle?.trim() || w.originSessionId.slice(0, 8),
    }
  }
  if (w.originLabel?.trim()) return { kind: 'process', label: w.originLabel.trim() }
  return { kind: 'group', group: w.group }
}

/** The words a From shows: the label (a group's, muted, is the fallback for a task recorded before traces). */
export function climayteFromText(
  f: CliMayteFrom,
  t: (key: string, named?: Record<string, string>) => string,
): { text: string; muted: boolean; hint: string } {
  if (f.kind === 'group') return { text: f.group, muted: true, hint: t('climayte.fromHint', { label: f.group }) }
  return { text: f.label, muted: false, hint: t('climayte.fromHint', { label: f.label }) }
}
