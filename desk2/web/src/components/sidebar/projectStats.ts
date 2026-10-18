// The project group header's menu, on the window: the server's stats and auto-categorize routes, and the words the
// stats section shows. A failed call says nothing (the menu shows no stats; the dialog shows its one line of error).

import { ref } from 'vue'
import type { PlacementMove, PlacementProposal, ProjectStats } from '@shared/protocol'

const BASE_URL = '/api'

/** The scratch folder whose auto-categorize dialog is open, or null. One dialog serves the whole sidebar. */
export const categorizing = ref<string | null>(null)

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE_URL + path, init)
  if (!res.ok) {
    const error = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error
    throw new Error(typeof error === 'string' ? error : `Request failed (${res.status})`)
  }
  return (await res.json()) as T
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** The folder's stats, or null when they cannot be read (the menu shows nothing then). */
export function fetchStats(folder: string): Promise<ProjectStats | null> {
  return call<ProjectStats>(`/projects/stats?folder=${encodeURIComponent(folder)}`).catch(() => null)
}

/** Each chat of a scratch folder with the project it would move to (nothing is moved yet). */
export function proposeCategorize(folder: string): Promise<{ folder: string; items: PlacementProposal[] }> {
  return call('/projects/categorize', json({ folder }))
}

/** Puts chats under their groups (a null group puts one back in its folder's). */
export function applyPlacements(moves: PlacementMove[]): Promise<{ moved: number; failed: { id: string; error: string }[] }> {
  return call('/projects/placements', json({ moves }))
}

/** A scratch folder is one the owner named scratch-<date>-...; its chats are the ones to categorize. */
export function isScratch(label: string): boolean {
  return /^scratch-/i.test(label)
}

/** How long ago an ISO time was, in words: "today", "1 day ago", "3 weeks ago". */
export function ageLabel(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  const days = Math.floor((now - at) / 86_400_000)
  if (days < 1) return 'today'
  if (days < 14) return days === 1 ? '1 day ago' : `${days} days ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  if (days < 730) return `${Math.floor(days / 30)} months ago`
  return `${Math.floor(days / 365)} years ago`
}

/** The stats section's lines: the git state, the uncommitted count, the last commit's age and the Architect summary. */
export function statsLines(stats: ProjectStats, now: number = Date.now()): string[] {
  const lines: string[] = []
  const git = stats.git
  if (git) {
    const branch = git.branch ?? 'detached HEAD'
    const sync = git.upstream ? ` · ${git.ahead} ahead, ${git.behind} behind` : ''
    lines.push(`${branch}${sync}`)
    lines.push(git.dirty > 0 ? `${git.dirty} uncommitted ${git.dirty === 1 ? 'file' : 'files'}` : 'clean')
    const age = ageLabel(git.lastCommitAt, now)
    if (age) lines.push(`last commit ${age}`)
  }
  const arch = stats.architect
  if (arch) {
    // Not measured says so: an unscanned project is not one with no errors.
    const parts: string[] = [arch.errors === null ? 'not measured' : `${arch.errors} ${arch.errors === 1 ? 'error' : 'errors'}`]
    if (arch.warnings !== null) parts.push(`${arch.warnings} ${arch.warnings === 1 ? 'warning' : 'warnings'}`)
    const ran = ageLabel(arch.lastRunAt, now)
    if (ran) parts.push(`ran ${ran}`)
    lines.push(`Architect: ${parts.join(' · ')}`)
    const health: string[] = []
    if (arch.risk !== null) health.push(`risk ${arch.risk}`)
    if (arch.production) health.push(`production ${arch.production}`)
    if (health.length) lines.push(`Project Hydra: ${health.join(' · ')}`)
  }
  return lines
}

/** Why a chat stays where it is, in the dialog's words. */
export function stayReason(item: PlacementProposal): string {
  if (item.reason === 'tie') return 'two projects tied'
  if (item.reason === 'no references') return 'no project in its transcript'
  return 'nothing to read'
}
