// The To-do pane's decisions, kept apart from the page so they are testable: what is For you, how the tiers group and cap,
// which projects the switcher offers, and how old a refresh is.
import type { FourmanBoard, FourmanNote, FourmanScope, FourmanStatus, FourmanTask, FourmanTier } from '@shared/fourman'

export const TIER_CAP = 50

export const TIERS: readonly { tier: FourmanTier; label: string }[] = [
  { tier: 'A', label: 'Do first' },
  { tier: 'B', label: 'Schedule' },
  { tier: 'C', label: 'Delegate' },
  { tier: 'D', label: 'Later' },
]

/** The pane exists only while 4MAN is installed: no status, or available false, means no pane anywhere. */
export const fourmanOn = (status: FourmanStatus | null | undefined): boolean => status?.available === true

export type ForYouRow = { kind: 'task'; task: FourmanTask } | { kind: 'note'; note: FourmanNote }

/** The owner's own to-dos: the human tasks by impact, then the open notes in the order the board gives them. */
export function forYou(board: Pick<FourmanBoard, 'human' | 'notes'>): ForYouRow[] {
  const tasks = sortTasks(board.human).map((task): ForYouRow => ({ kind: 'task', task }))
  const notes = board.notes.filter((n) => !n.done).map((note): ForYouRow => ({ kind: 'note', note }))
  return [...tasks, ...notes]
}

/** Highest impact first, then title, so a tier reads the same on every refresh. */
export function sortTasks(list: readonly FourmanTask[]): FourmanTask[] {
  return [...list].sort((a, b) => b.impact - a.impact || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
}

export interface TierSection {
  tier: FourmanTier
  label: string
  /** Every task in the tier, before the cap. */
  total: number
  shown: FourmanTask[]
  /** How many are hidden behind "show N more"; 0 once the tier is open or short. */
  more: number
}

/**
 * The four tiers from the board's ready tasks. A human task is For you, never a tier row, even when it is also ready.
 * `open` names the tiers the owner expanded; those show every task.
 */
export function tierSections(board: Pick<FourmanBoard, 'ready' | 'human'>, open: ReadonlySet<FourmanTier> = new Set()): TierSection[] {
  const human = new Set(board.human.map((t) => t.id))
  const ready = board.ready.filter((t) => !human.has(t.id))
  return TIERS.map(({ tier, label }) => {
    const all = sortTasks(ready.filter((t) => t.tier === tier))
    const cap = open.has(tier) ? all.length : TIER_CAP
    return { tier, label, total: all.length, shown: all.slice(0, cap), more: Math.max(0, all.length - cap) }
  })
}

/** Initials for a claimed chip: "Claude 2" → "C2", "ci-bot" → "CI". */
export function claimInitials(name: string): string {
  const cleaned = name.trim()
  if (!cleaned) return '?'
  const digits = cleaned.match(/\d+$/)?.[0] ?? ''
  const letters = cleaned.replace(/\d+$/, '').replace(/[^A-Za-z]/g, '')
  return ((letters.slice(0, 1) || cleaned.slice(0, 1)) + digits).toUpperCase().slice(0, 3)
}

/** The short "2m ago" a refresh shows; a future or missing time reads as just now. */
export function timeAgo(then: number, now: number): string {
  const s = Math.floor((now - then) / 1000)
  if (!Number.isFinite(s) || s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export type ScopeChoice = { scope: FourmanScope; label: string }

/**
 * The switcher's list: this folder's project first, then the other projects A-Z, then "All projects". `folderProject`
 * is the board's project for the folder (null when the folder has none); `folderCwd` names that choice when it has none.
 */
export function projectChoices(folderCwd: string, folderProject: string | null, projectKeys: readonly string[]): ScopeChoice[] {
  const first: ScopeChoice = { scope: { kind: 'folder', cwd: folderCwd }, label: folderProject ?? folderName(folderCwd) }
  const others = [...new Set(projectKeys)]
    .filter((k) => k && k !== folderProject)
    .sort((a, b) => a.localeCompare(b))
    .map((key): ScopeChoice => ({ scope: { kind: 'project', key }, label: key }))
  return [first, ...others, { scope: { kind: 'all' }, label: 'All projects' }]
}

/** Every project key the tasks name, for the switcher. */
export function projectKeysOf(board: Pick<FourmanBoard, 'ready' | 'human' | 'claimed' | 'pending'>): string[] {
  return [...board.ready, ...board.human, ...board.claimed, ...board.pending].map((t) => t.project).filter(Boolean)
}

/** The last segment of a folder path, either slash style, for a header with no project name. */
export function folderName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

/** The To-do entry points (a group head's button, the header's) exist only while 4MAN is installed and a folder is known. */
export const todoEntryShown = (on: boolean, folder: string | null | undefined): boolean => on && !!folder

/** A group head's button reads pressed while the open pane shows that group's folder. */
export const todoPressed = (showing: string | null, folder: string | null | undefined): boolean => !!folder && showing === folder
