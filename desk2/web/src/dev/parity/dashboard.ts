import type { Dashboard } from '@shared/dashboards'
import { PARITY_NOW } from './clock'
import { CWD } from './fixtures'

const at = (minutesAgo: number) => new Date(PARITY_NOW - minutesAgo * 60_000).toISOString()

export const dashboardFixture = (): Dashboard => ({
  id: 'atlas',
  workspace: CWD,
  folder: CWD,
  name: 'Atlas',
  url: '/parity/atlas-dashboard.html',
  files: 3,
  bytes: 4096,
  updatedAt: at(4),
  updatedBy: 'Ada',
  entries: [
    { path: 'index.html', bytes: 2048, updatedAt: at(4) },
    { path: 'style.css', bytes: 1024, updatedAt: at(190) },
    { path: 'data.json', bytes: 1024, updatedAt: at(40) }
  ]
})

export const emptyDashboardFixture = (): Dashboard => ({
  id: 'atlas',
  workspace: CWD,
  folder: CWD,
  name: 'Atlas',
  url: '/parity/atlas-dashboard.html',
  files: 0,
  bytes: 0,
  updatedAt: null,
  updatedBy: null,
  entries: []
})
