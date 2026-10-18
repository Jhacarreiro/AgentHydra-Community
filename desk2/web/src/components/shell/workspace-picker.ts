import type { ChatPatch, ChatStatus, ProjectEntry } from '@shared/protocol'
import { sameFolder } from '@/components/composer/folders'
import { isExternalChatId } from '@/components/external/logic'
import { folderLabel, projectOfGroup } from '@/components/sidebar/logic'

/** The project a chat works in: the deepest one whose folder holds the chat's folder (the sidebar's rule), else null. */
export function workspaceOf(cwd: string, projects: readonly ProjectEntry[]): ProjectEntry | null {
  return projectOfGroup({ key: cwd, cwd, label: folderLabel(cwd) }, projects.filter((p) => !p.hidden))
}

/** The pill's words: the project's name, else the folder's last name. */
export function workspaceLabel(cwd: string, projects: readonly ProjectEntry[]): string {
  return workspaceOf(cwd, projects)?.name ?? folderLabel(cwd)
}

export interface PickerRow {
  project: ProjectEntry
  current: boolean
}

/** The projects the picker lists, in the order given (the server puts open chats first), filtered by name or path. */
export function pickerRows(projects: readonly ProjectEntry[], query: string, current: ProjectEntry | null): PickerRow[] {
  const q = query.trim().toLowerCase()
  return projects
    .filter((p) => !p.hidden)
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    .map((project) => ({ project, current: !!current && sameFolder(project.path, current.path) }))
}

/** The highlighted row after an arrow key; -1 when there is nothing to highlight. */
export function stepIndex(index: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1
  if (index < 0) return delta > 0 ? 0 : count - 1
  return (index + delta + count) % count
}

/** The body of the move: the chat's own folder, as Desk's PATCH /api/chats/:id takes it. */
export function folderMove(path: string): ChatPatch {
  return { cwd: path }
}

/** Only Desk's own chats can change folder here; an outside session's chat runs where it is. */
export function canMoveChat(chatId: string): boolean {
  return !isExternalChatId(chatId)
}

const RUNNING: ChatStatus[] = ['starting', 'working', 'needs_you']

/** The footer line: a running chat finishes its turn in the old folder, so the change waits for the next message. */
export function moveNote(status: ChatStatus): string | null {
  return RUNNING.includes(status) ? 'Applies from the next message' : null
}
