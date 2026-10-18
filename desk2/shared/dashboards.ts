// A project's dashboard: a small static website its AIs write (any HTML, CSS, JavaScript or data) through the agenthydra
// MCP. The daemon hosts it at its own origin (url); the window reads it through Desk's /ah/api/dashboards routes.

export interface DashboardSummary {
  id: string
  /** The project's checkout, forward slashes. */
  workspace: string
  name: string
  /** The site's own address, on the daemon's loopback origin for this project. */
  url: string
  files: number
  bytes: number
  /** The newest file change, or null when nothing is written. */
  updatedAt: string | null
  updatedBy: string | null
}

export interface DashboardEntry {
  path: string
  bytes: number
  updatedAt: string
}

export type Dashboard = DashboardSummary & {
  folder: string
  entries: DashboardEntry[]
}

export interface DashboardList {
  dashboards: DashboardSummary[]
}
