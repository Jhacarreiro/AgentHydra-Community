import { describe, expect, it } from 'bun:test'
import type { DashboardSummary } from '@shared/dashboards'
import { findDashboard, hasSite, showingDashboard, timeAgo, workspaceKey } from '@/components/dashboard/logic'

const NOW = Date.parse('2026-10-11T12:00:00Z')

const site = (over: Partial<DashboardSummary> = {}): DashboardSummary => ({
  id: 'd-1',
  workspace: 'C:/Users/me/Projects/atlas',
  name: 'Atlas',
  url: 'http://d-1.localhost:7799/',
  files: 2,
  bytes: 1200,
  updatedAt: null,
  updatedBy: null,
  ...over,
})

describe('workspaceKey and findDashboard', () => {
  it('matches a folder across slashes, a trailing slash and a drive letter case', () => {
    const list = [site({ workspace: 'C:/Users/me/Projects/atlas/' })]
    expect(findDashboard(list, 'c:\\Users\\me\\Projects\\atlas')?.name).toBe('Atlas')
    expect(findDashboard(list, 'C:/Users/me/Projects/other')).toBeUndefined()
    expect(findDashboard(null, 'C:/Users/me/Projects/atlas')).toBeUndefined()
  })

  it('keeps the case of a path that is not a drive path', () => {
    expect(workspaceKey('/Home/Me/Atlas/')).toBe('/Home/Me/Atlas')
  })
})

describe('hasSite', () => {
  it('is true once a dashboard holds at least one file', () => {
    expect(hasSite([site({ files: 1 })], 'C:/Users/me/Projects/atlas')).toBe(true)
  })

  it('is false for an empty dashboard, a missing one and no list yet', () => {
    expect(hasSite([site({ files: 0 })], 'C:/Users/me/Projects/atlas')).toBe(false)
    expect(hasSite([site()], 'C:/Users/me/Projects/other')).toBe(false)
    expect(hasSite(null, 'C:/Users/me/Projects/atlas')).toBe(false)
  })
})

describe('timeAgo', () => {
  it('reads a recent time in minutes, hours and days', () => {
    expect(timeAgo(new Date(NOW - 20_000).toISOString(), NOW)).toBe('just now')
    expect(timeAgo(new Date(NOW - 3 * 60_000).toISOString(), NOW)).toBe('3m ago')
    expect(timeAgo(new Date(NOW - 2 * 3_600_000).toISOString(), NOW)).toBe('2h ago')
    expect(timeAgo(new Date(NOW - 5 * 86_400_000).toISOString(), NOW)).toBe('5d ago')
  })

  it('is empty for no time or one that does not parse', () => {
    expect(timeAgo(null, NOW)).toBe('')
    expect(timeAgo('not a time', NOW)).toBe('')
  })
})

describe('showingDashboard', () => {
  it('is true only while the page is open on that folder, so a second click on its button closes it', () => {
    expect(showingDashboard(true, 'C:/Users/me/Projects/atlas', 'c:\\Users\\me\\Projects\\atlas\\')).toBe(true)
    expect(showingDashboard(false, 'C:/Users/me/Projects/atlas', 'C:/Users/me/Projects/atlas')).toBe(false)
    expect(showingDashboard(true, 'C:/Users/me/Projects/other', 'C:/Users/me/Projects/atlas')).toBe(false)
    expect(showingDashboard(true, null, 'C:/Users/me/Projects/atlas')).toBe(false)
  })
})
