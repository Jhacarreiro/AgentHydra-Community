// The project group header's menu: which project a chat really worked in (categorize.ts), and the proposal and placement
// that move it (menu.ts). Fixtures are invented folders; the transcripts live in a temp folder.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decide, pathsIn, type KnownProject } from '../../src/projects/categorize'
import { architectOf, ProjectMenu, type MenuChat } from '../../src/projects/menu'

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'menu-test-'))
  temps.push(d)
  return d
}

const PROJECTS: KnownProject[] = [
  { name: 'Alpha', path: 'C:/Users/me/Projects/alpha' },
  { name: 'Beta', path: 'C:/Users/me/Projects/beta' },
  { name: 'Beta Tools', path: 'C:/Users/me/Projects/beta/tools' },
]
const SCRATCH = 'C:/Users/me/scratch-2026-10-06-notes'

/** One transcript line of a tool call whose input holds the given strings. */
const call = (...strings: string[]) =>
  JSON.stringify({ cwd: SCRATCH, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: strings[0], command: strings.slice(1).join(' && ') } }] } })

test('a chat goes to the project its tool calls referenced most; the deepest folder holds the path', () => {
  const paths = pathsIn([call('C:/Users/me/Projects/alpha/src/a.ts'), call('C:/Users/me/Projects/alpha/README.md'), call('C:/Users/me/Projects/beta/tools/run.ts')].join('\n'))
  const d = decide(paths, PROJECTS, SCRATCH)
  expect(d.reason).toBe('winner')
  expect(d.project?.name).toBe('Alpha')
  expect(d.refs).toBe(2)
  expect(d.counts.map((c) => [c.name, c.refs])).toEqual([
    ['Alpha', 2],
    ['Beta Tools', 1],
  ])
})

test('no clear winner keeps the chat in scratch and says why', () => {
  const tie = decide(pathsIn([call('C:/Users/me/Projects/alpha/a.ts'), call('C:/Users/me/Projects/beta/b.ts')].join('\n')), PROJECTS, SCRATCH)
  expect(tie.project).toBeNull()
  expect(tie.reason).toBe('tie')
  const none = decide(pathsIn(call('C:/Users/me/elsewhere/c.ts')), PROJECTS, SCRATCH)
  expect(none.project).toBeNull()
  expect(none.reason).toBe('no references')
})

test('references to the scratch folder itself do not count', () => {
  const paths = pathsIn([call(`${SCRATCH}/a.md`), call(`${SCRATCH}/b.md`), call('C:/Users/me/Projects/beta/c.ts')].join('\n'))
  const d = decide(paths, PROJECTS, SCRATCH)
  expect(d.project?.name).toBe('Beta')
})

test('pathsIn reads tool inputs and the line cwd, and skips plain prose', () => {
  const text = [
    JSON.stringify({ message: { content: [{ type: 'text', text: 'I looked at C:/Users/me/Projects/alpha/x.ts' }] } }),
    call('C:/Users/me/Projects/alpha/y.ts'),
    'not json at all',
  ].join('\n')
  expect(pathsIn(text)).toEqual([SCRATCH, 'C:/Users/me/Projects/alpha/y.ts'])
})

test('architectOf reads `ph show --json`: the row\'s Architect counts, risk and production; unmeasured stays null', () => {
  // The shape `ph show <key> --json` answers (2026-10-10), trimmed to the fields read and a neighbour of each.
  const shown = {
    row: { key: 'alpha', arkitect_total_errors: 3, arkitect_warnings: null, arkitect_last_run_at: '2026-10-10T11:53:47+00:00', arkitect_infos: 121 },
    risk: 56,
    production: { score: 7, of: 10, cell: '7/10' },
  }
  expect(architectOf(shown)).toEqual({ errors: 3, warnings: null, lastRunAt: '2026-10-10T11:53:47+00:00', risk: 56, production: '7/10' })
  expect(architectOf({ row: {} })).toEqual({ errors: null, warnings: null, lastRunAt: null, risk: null, production: null })
  expect(architectOf({ other: true })).toBeNull()
})

test('stats missing a part are read again after 30 s; complete ones are kept 5 minutes', async () => {
  let clock = 0
  let reads = 0
  const facts = { git: { branch: 'main', upstream: null, ahead: 0, behind: 0, dirty: 0, fetchedAt: null }, lastCommitAt: null }
  const menu = new ProjectMenu({
    findHydra: () => null,
    readHydra: async () => ({ projects: [], problem: null }),
    // The first read runs out of time (a busy server), the later ones answer.
    git: async () => (reads++ === 0 ? null : facts),
    chats: () => [],
    transcript: () => null,
    projects: () => [],
    setGroup: () => {},
    now: () => clock,
  })
  expect((await menu.stats('C:/Users/me/Projects/alpha')).git).toBeNull()
  clock = 29_000
  expect((await menu.stats('C:/Users/me/Projects/alpha')).git).toBeNull()
  clock = 31_000
  expect((await menu.stats('C:/Users/me/Projects/alpha')).git?.branch).toBe('main')
  clock = 31_000 + 4 * 60_000
  await menu.stats('C:/Users/me/Projects/alpha')
  expect(reads).toBe(2)
})

test('propose names the project of a chat whose transcript points into one, and leaves the rest in scratch', async () => {
  const dir = temp()
  const withProject = join(dir, 'one.jsonl')
  writeFileSync(withProject, [call('C:/Users/me/Projects/alpha/a.ts'), call('C:/Users/me/Projects/alpha/b.ts')].join('\n'))
  const chats: MenuChat[] = [
    { kind: 'desk', id: 'c1', sessionId: 'session-one', cwd: SCRATCH, title: 'Fix the parser', group: null, archived: false },
    { kind: 'desk', id: 'c2', sessionId: null, cwd: SCRATCH, title: 'Untitled idea', group: null, archived: false },
    { kind: 'desk', id: 'c3', sessionId: 'session-one', cwd: SCRATCH, title: 'Already moved', group: 'Beta', archived: false },
  ]
  const menu = new ProjectMenu({
    findHydra: () => null,
    readHydra: async () => ({ projects: [], problem: null }),
    chats: () => chats,
    transcript: (sessionId) => (sessionId === 'session-one' ? withProject : null),
    projects: () => PROJECTS,
    setGroup: () => {},
  })
  const items = await menu.propose(SCRATCH)
  expect(items.map((i) => [i.id, i.group, i.reason])).toEqual([
    ['c1', 'alpha', 'winner'],
    ['c2', null, 'no transcript'],
  ])
  expect(items[0]!.project).toEqual({ name: 'Alpha', path: 'C:/Users/me/Projects/alpha' })
})

test('place applies each move and reports the ones that failed', async () => {
  const applied: string[] = []
  const menu = new ProjectMenu({
    findHydra: () => null,
    readHydra: async () => ({ projects: [], problem: null }),
    chats: () => [],
    transcript: () => null,
    projects: () => [],
    setGroup: (chat, group) => {
      if (chat.id === 'bad') throw new Error('no such chat')
      applied.push(`${chat.id}=${group}`)
    },
  })
  const out = await menu.place([
    { kind: 'desk', id: 'c1', group: 'alpha' },
    { kind: 'desk', id: 'c1', group: null },
    { kind: 'outside', id: 'bad', group: 'beta' },
  ])
  expect(applied).toEqual(['c1=alpha', 'c1=null'])
  expect(out).toEqual({ moved: 2, failed: [{ id: 'bad', error: 'no such chat' }] })
})
