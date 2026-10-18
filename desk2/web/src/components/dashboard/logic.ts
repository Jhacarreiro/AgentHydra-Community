import type { DashboardSummary } from '@shared/dashboards'

/** A folder as the dashboards list keys it: forward slashes, no trailing slash, lower case on a Windows drive path. */
export function workspaceKey(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(slashed) ? slashed.toLowerCase() : slashed
}

export function findDashboard(list: DashboardSummary[] | null, path: string): DashboardSummary | undefined {
  if (!list) return undefined
  const key = workspaceKey(path)
  return list.find((d) => workspaceKey(d.workspace) === key)
}

/** A project has a site once a chat has written at least one file to its dashboard. */
export function hasSite(list: DashboardSummary[] | null, path: string): boolean {
  return (findDashboard(list, path)?.files ?? 0) > 0
}

/** The dashboard page is open on this folder: its group head's button then closes the page instead of opening it. */
export function showingDashboard(open: boolean, openCwd: string | null, path: string): boolean {
  return open && openCwd !== null && workspaceKey(openCwd) === workspaceKey(path)
}

/** "just now", "3m ago", "2h ago", "5d ago"; empty for a time that does not parse. */
export function timeAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const mins = Math.floor((now - then) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export const EXAMPLE_PROMPT = "Build this project's dashboard: a page that shows me where it stands."
