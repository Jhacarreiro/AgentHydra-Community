import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('owner sources are read only from sources.json', () => {
  put('.agenthydra/core/catalog/sources.json', {
    ownerName: 'Example Owner',
    seats: [{ slug: 'owner-seat', name: 'Example Owner', personaId: 'p1' }],
    companyId: 'c1',
  })
  expect(run().status).toBe(0)
  const owners = JSON.parse(
    readFileSync(join(home, '.agenthydra/core/catalog/generated-owners.json'), 'utf8'),
  ) as { id: string }[]
  expect(owners.map((e) => e.id)).toContain('person:owner-seat')
})
