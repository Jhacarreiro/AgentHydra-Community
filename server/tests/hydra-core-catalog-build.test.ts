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

test('a rebuild removes the catalog files of sources the builder no longer has', () => {
  const core = '.agenthydra/core'
  const owner = {
    id: 'person:creator-owner',
    kind: 'person',
    name: 'Owner',
    when: 'Asks the owner',
    how: 'core_use',
    source: 'old build',
    tags: [],
    cost: 'free',
    tier: 'owner',
    family: 'creator',
    modes: ['consult'],
    load: { type: 'none' },
  }
  for (const name of ['dredd', 'crainium', 'pinned', 'boardroom', 'owners'])
    put(`${core}/catalog/generated-${name}.json`, name === 'owners' ? [owner] : [])
  put(`${core}/catalog/hand-extra.json`, [])
  put(
    `${core}/knowledge/pinned/old-ruling.md`,
    '# Old ruling\n\nSource: C:/lane/brief-a.json (Connections pinned prompt, split by build.mjs)\n\nBody\n',
  )
  put(`${core}/knowledge/pinned/mine.md`, '# My own note\n\nKept.\n')
  expect(loadCatalog(join(home, core)).entries.has('person:creator-owner')).toBe(true)
  const built = run()
  expect(built.status).toBe(0)
  expect(built.stdout).toContain('generated-owners.json: removed')
  const dir = join(home, core, 'catalog')
  expect(
    readdirSync(dir)
      .filter((f) => /^(generated|hand)-/.test(f))
      .sort(),
  ).toEqual([
    'generated-agents.json',
    'generated-managers.json',
    'generated-people.json',
    'generated-repos.json',
    'generated-skills.json',
    'hand-extra.json',
  ])
  expect(loadCatalog(join(home, core)).entries.has('person:creator-owner')).toBe(false)
  expect(readdirSync(join(home, core, 'knowledge', 'pinned'))).toEqual(['mine.md'])
})

test('a rebuild removes the pinned folder once only builder-written rulings were in it', () => {
  const core = '.agenthydra/core'
  put(`${core}/catalog/generated-pinned.json`, [])
  put(
    `${core}/knowledge/pinned/old-ruling.md`,
    '# Old ruling\n\nSource: /lane/brief-a.json (Connections pinned prompt, split by build.mjs)\n\nBody\n',
  )
  expect(run().status).toBe(0)
  expect(readdirSync(join(home, core, 'knowledge'))).toEqual([])
})
