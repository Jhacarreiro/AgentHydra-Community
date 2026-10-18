import { describe, expect, it } from 'bun:test'
import type { FourmanBoard, FourmanNote, FourmanTask } from '@shared/fourman'
import { fourmanBoardPath } from '@shared/fourman'
import { TIER_CAP, claimInitials, folderName, forYou, fourmanOn, projectChoices, projectKeysOf, sortTasks, tierSections, timeAgo } from '@/components/fourman/logic'

const task = (over: Partial<FourmanTask> = {}): FourmanTask => ({
  id: 't-1',
  title: 'Sample task',
  body: 'Invented body',
  project: 'atlas',
  status: 'ready',
  tier: 'A',
  quadrant: 'urgent-important',
  type: 'bug',
  size: 'S',
  impact: 3,
  live: false,
  risky: false,
  needsHuman: false,
  claimedBy: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  tierWhy: 'Invented reason',
  ...over,
})

const note = (over: Partial<FourmanNote> = {}): FourmanNote => ({ id: 'n-1', title: 'Invented note', done: false, ...over })

const board = (over: Partial<FourmanBoard> = {}): FourmanBoard => ({
  available: true,
  project: 'atlas',
  readyCount: 0,
  ready: [],
  human: [],
  claimed: [],
  pending: [],
  notes: [],
  fetchedAt: Date.parse('2026-10-12T12:00:00Z'),
  ...over,
})

describe('fourmanOn', () => {
  it('shows only when the daemon says available', () => {
    expect(fourmanOn({ available: true, notes: { available: false } })).toBe(true)
    expect(fourmanOn({ available: false, why: 'not installed', notes: { available: false } })).toBe(false)
    expect(fourmanOn(null)).toBe(false)
    expect(fourmanOn(undefined)).toBe(false)
  })
})

describe('For you', () => {
  it('lists human tasks by impact, then the open notes; done notes are left out', () => {
    const rows = forYou(
      board({
        human: [task({ id: 'h-1', title: 'Low', impact: 2 }), task({ id: 'h-2', title: 'High', impact: 5 })],
        notes: [note({ id: 'n-1', title: 'Open' }), note({ id: 'n-2', title: 'Finished', done: true })],
      })
    )
    expect(rows.map((r) => (r.kind === 'task' ? r.task.title : r.note.title))).toEqual(['High', 'Low', 'Open'])
  })
})

describe('tierSections', () => {
  it('groups ready tasks into A-D and keeps a human task out of the tiers', () => {
    const b = board({
      ready: [task({ id: 'a', tier: 'A' }), task({ id: 'b', tier: 'B' }), task({ id: 'h', tier: 'A' })],
      human: [task({ id: 'h', tier: 'A' })],
    })
    const sections = tierSections(b)
    expect(sections.map((s) => s.tier)).toEqual(['A', 'B', 'C', 'D'])
    expect(sections[0]?.shown.map((t) => t.id)).toEqual(['a'])
    expect(sections[1]?.total).toBe(1)
    expect(sections[2]?.total).toBe(0)
  })

  it('orders each tier by impact, highest first', () => {
    const sections = tierSections(
      board({
        ready: [task({ id: 'low', title: 'B', impact: 1 }), task({ id: 'high', title: 'A', impact: 5 }), task({ id: 'mid', title: 'C', impact: 3 })],
      })
    )
    expect(sections[0]?.shown.map((t) => t.id)).toEqual(['high', 'mid', 'low'])
  })

  it('shows the first 50 per tier and says how many are more', () => {
    const many = Array.from({ length: TIER_CAP + 7 }, (_, i) => task({ id: `t${i}`, impact: 1 + (i % 5) }))
    const [a] = tierSections(board({ ready: many }))
    expect(a?.total).toBe(TIER_CAP + 7)
    expect(a?.shown.length).toBe(TIER_CAP)
    expect(a?.more).toBe(7)
  })

  it('shows every task of a tier once it is opened', () => {
    const many = Array.from({ length: TIER_CAP + 3 }, (_, i) => task({ id: `t${i}` }))
    const [a] = tierSections(board({ ready: many }), new Set(['A']))
    expect(a?.shown.length).toBe(TIER_CAP + 3)
    expect(a?.more).toBe(0)
  })
})

describe('sortTasks', () => {
  it('breaks an impact tie by title, then id', () => {
    const list = sortTasks([task({ id: 'z', title: 'Same' }), task({ id: 'y', title: 'Same' }), task({ id: 'x', title: 'Alpha' })])
    expect(list.map((t) => t.id)).toEqual(['x', 'y', 'z'])
  })
})

describe('claimInitials', () => {
  it('reads a name as its letters and trailing number', () => {
    expect(claimInitials('Claude 2')).toBe('C2')
    expect(claimInitials('ci-bot')).toBe('C')
    expect(claimInitials('  ')).toBe('?')
  })
})

describe('timeAgo', () => {
  const now = Date.parse('2026-10-12T12:00:00Z')
  it('reads a refresh in minutes, hours and days, and under a minute as just now', () => {
    expect(timeAgo(now - 20_000, now)).toBe('just now')
    expect(timeAgo(now - 2 * 60_000, now)).toBe('2m ago')
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d ago')
  })
  it('treats a time in the future as just now', () => {
    expect(timeAgo(now + 5 * 60_000, now)).toBe('just now')
  })
})

describe('project switcher', () => {
  it('lists this folder first, the other projects A-Z, then All projects', () => {
    const choices = projectChoices('C:/Users/me/Projects/atlas', 'atlas', ['core', 'atlas', 'api', 'core'])
    expect(choices.map((c) => c.label)).toEqual(['atlas', 'api', 'core', 'All projects'])
    expect(choices[0]?.scope).toEqual({ kind: 'folder', cwd: 'C:/Users/me/Projects/atlas' })
    expect(choices[1]?.scope).toEqual({ kind: 'project', key: 'api' })
    expect(choices[choices.length - 1]?.scope).toEqual({ kind: 'all' })
  })

  it('names this folder by its last segment when it has no project', () => {
    expect(projectChoices('C:\\Users\\me\\Projects\\loose\\', null, [])[0]?.label).toBe('loose')
    expect(folderName('C:/Users/me/Projects/atlas')).toBe('atlas')
  })

  it('collects every project key the board names', () => {
    const keys = projectKeysOf(board({ ready: [task({ project: 'core' })], claimed: [task({ project: 'api' })] }))
    expect(keys.sort()).toEqual(['api', 'core'])
  })
})

describe('board read paths', () => {
  it('asks for a folder, a project, or all projects', () => {
    expect(fourmanBoardPath({ kind: 'folder', cwd: 'C:/Users/me/Projects/atlas' })).toBe('/ah/api/fourman/board?cwd=C%3A%2FUsers%2Fme%2FProjects%2Fatlas')
    expect(fourmanBoardPath({ kind: 'project', key: 'core' })).toBe('/ah/api/fourman/board?project=core')
    expect(fourmanBoardPath({ kind: 'all' })).toBe('/ah/api/fourman/board?all=1')
  })
})
