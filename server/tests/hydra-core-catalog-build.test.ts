import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCatalog } from '../src/hydra-core/catalog'

const BUILDER = join(import.meta.dir, '..', '..', 'hydra-core', 'catalog', 'build.mjs')

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'catalog-build-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const run = (...args: string[]) =>
  spawnSync('node', [BUILDER, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, AGENTHYDRA_CORE_DIR: '' },
    encoding: 'utf8',
  })

const put = (rel: string, body: unknown) => {
  const file = join(home, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
}

test('an empty home builds a valid empty catalog with no home path in the output', () => {
  const built = run()
  expect(built.status).toBe(0)
  expect(built.stderr).toBe('')
  const checked = run('--check')
  expect(checked.status).toBe(0)
  expect(checked.stdout).toContain('CHECK OK')
  const out = built.stdout + checked.stdout
  expect(out).not.toContain(home.split('\\').join('/'))
})

test('people folders and legacy manager folders become person entries', () => {
  put('.agenthydra/people/manager/ada/persona.json', {
    name: 'Ada',
    oneLiner: 'Plans releases',
    keywords: ['release'],
  })
  put('.agenthydra/people/expert/grace/persona.json', {
    name: 'Grace',
    title: 'Compiler expert',
    oneLiner: 'Answers compiler questions',
  })
  put('.agenthydra/managers/lin/persona.json', { name: 'Lin', oneLiner: 'Keeps the books' })
  expect(run().status).toBe(0)
  const ids = (f: string) =>
    (
      JSON.parse(readFileSync(join(home, '.agenthydra/core/catalog', f), 'utf8')) as {
        id: string
      }[]
    ).map((e) => e.id)
  expect(ids('generated-people.json').sort()).toEqual(['person:ada', 'person:expert-grace'])
  expect(ids('generated-managers.json')).toEqual(['person:lin'])
  const loaded = loadCatalog(join(home, '.agenthydra/core'))
  expect(loaded.entries.has('person:expert-grace')).toBe(true)
  expect(loaded.skipped).toEqual([])
})

test('sources.json adds project rules and extra skill and agent folders, and nothing else', () => {
  put('projects/atlas/AGENTS.md', '# Atlas rules\n')
  put(
    'more-skills/lint-fix/SKILL.md',
    '---\nname: lint-fix\ndescription: Fixes lint errors.\n---\n',
  )
  put('more-agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews a diff.\n---\n')
  put('.agenthydra/core/catalog/sources.json', {
    projectsDir: '~/projects',
    extraSkillDirs: ['~/more-skills'],
    extraAgentDirs: ['~/more-agents'],
    // Keys of sources this builder no longer has are ignored.
    ownerName: 'Example Owner',
    seats: [{ slug: 'owner-seat', name: 'Example Owner', personaId: 'p1' }],
  })
  expect(run().status).toBe(0)
  const dir = join(home, '.agenthydra/core/catalog')
  const ids = (f: string) =>
    (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { id: string }[]).map((e) => e.id)
  expect(ids('generated-repos.json')).toEqual(['knowledge:repo-atlas'])
  expect(ids('generated-skills.json')).toEqual(['skill:lint-fix'])
  expect(ids('generated-agents.json')).toEqual(['worker:reviewer'])
  expect(
    readdirSync(dir)
      .filter((f) => f.startsWith('generated-'))
      .sort(),
  ).toEqual([
    'generated-agents.json',
    'generated-managers.json',
    'generated-people.json',
    'generated-repos.json',
    'generated-skills.json',
  ])
})
