// The project header menu's stats lines (projectStats.ts statsLines): what a person reads about a folder's git state
// and Project Hydra's read of it. A count Project Hydra has not measured must read as not measured, never as zero.
import { expect, test } from 'bun:test'
import type { ProjectStats } from '@shared/protocol'
import { statsLines } from '../../src/components/sidebar/projectStats'

const NOW = Date.parse('2026-10-10T12:00:00Z')

test('git state, then the Architect run and Project Hydra health', () => {
  const stats: ProjectStats = {
    git: { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0, dirty: 1, lastCommitAt: '2026-10-07T12:00:00Z' },
    hydra: true,
    architect: { errors: 0, warnings: 85, lastRunAt: '2026-10-10T09:00:00Z', risk: 56, production: '7/10' },
  }
  expect(statsLines(stats, NOW)).toEqual([
    'main · 2 ahead, 0 behind',
    '1 uncommitted file',
    'last commit 3 days ago',
    'Architect: 0 errors · 85 warnings · ran today',
    'Project Hydra: risk 56 · production 7/10',
  ])
})

test('an unmeasured Architect reads "not measured", not "0 errors"; no git and no Hydra show nothing', () => {
  const unmeasured: ProjectStats = {
    git: null,
    hydra: true,
    architect: { errors: null, warnings: null, lastRunAt: null, risk: null, production: null },
  }
  expect(statsLines(unmeasured, NOW)).toEqual(['Architect: not measured'])
  expect(statsLines({ git: null, hydra: false, architect: null }, NOW)).toEqual([])
})
