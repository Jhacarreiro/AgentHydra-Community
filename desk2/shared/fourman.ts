// 4MAN, the board of AI work, read through Desk 2's /ah/api to the one AgentHydra daemon (server/src/routes/fourman.ts).
// Read only: the To-do pane shows it and never changes a task. It exists only where 4MAN is installed.

export const FOURMAN_BASE = '/ah/api/fourman'

export type FourmanTier = 'A' | 'B' | 'C' | 'D'

export interface FourmanTask {
  id: string
  title: string
  body: string
  project: string
  status: string
  tier: FourmanTier
  quadrant: string
  type: string
  size: string
  impact: number
  live: boolean
  risky: boolean
  needsHuman: boolean
  claimedBy?: string | null
  createdAt: string
  updatedAt: string
  tierWhy: string
}

export interface FourmanNote {
  id: string
  title: string
  due?: string
  done: boolean
  labels?: string[]
}

export interface FourmanStatus {
  available: boolean
  why?: string
  engine?: string
  notes: { available: boolean; why?: string }
}

export interface FourmanBoard {
  available: boolean
  project: string | null
  readyCount: number
  ready: FourmanTask[]
  human: FourmanTask[]
  claimed: FourmanTask[]
  pending: FourmanTask[]
  notes: FourmanNote[]
  fetchedAt: number
}

/** Which tasks a board read asks for: this folder's project, one project by key, or every project. */
export type FourmanScope = { kind: 'folder'; cwd: string } | { kind: 'project'; key: string } | { kind: 'all' }

export const fourmanBoardPath = (scope: FourmanScope): string => {
  if (scope.kind === 'folder') return `${FOURMAN_BASE}/board?cwd=${encodeURIComponent(scope.cwd)}`
  if (scope.kind === 'project') return `${FOURMAN_BASE}/board?project=${encodeURIComponent(scope.key)}`
  return `${FOURMAN_BASE}/board?all=1`
}
