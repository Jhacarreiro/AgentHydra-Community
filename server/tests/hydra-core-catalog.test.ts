import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkEntry, loadCatalog, tierRank } from '../src/hydra-core/catalog'
import { scratch } from './hydra-core-fixture'

let dir = ''
beforeEach(() => {
  dir = scratch()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const base = {
  id: 'instrument:screen-capture',
  kind: 'instrument',
  name: 'Screen Capture',
  when: 'Takes headless screenshots of a page',
  tags: [],
  cost: 'free',
  how: 'run the capture tool',
  load: { type: 'none' },
}

test('a well-formed instrument entry is accepted', () => {
  expect(checkEntry(base)).toMatchObject({
    entry: { id: 'instrument:screen-capture', cost: 'free' },
  })
})

test('an id whose prefix does not match the kind is refused', () => {
  expect(checkEntry({ ...base, id: 'worker:screen-capture' })).toEqual({
    why: 'kind must match the id prefix',
  })
})

test('a person needs a tier, a family and modes from become, consult or hire', () => {
  const person = { ...base, id: 'person:oscar-ops', kind: 'person', tags: [] }
  expect(checkEntry(person)).toEqual({
    why: 'a person needs a tier: intern, employee, manager or owner',
  })
  expect(checkEntry({ ...person, tier: 'board' })).toEqual({
    why: 'a person needs a tier: intern, employee, manager or owner',
  })
  expect(checkEntry({ ...person, tier: 'manager', modes: ['become'] })).toMatchObject({
    why: expect.stringContaining('a person needs a family'),
  })
  const manager = { ...person, tier: 'manager', family: 'manager' }
  expect(checkEntry({ ...manager, modes: ['boss'] })).toEqual({
    why: 'a person needs modes from become, consult, hire',
  })
  expect(checkEntry({ ...manager, modes: ['become'] })).toMatchObject({
    entry: { tier: 'manager', family: 'manager', modes: ['become'] },
  })
})

test('a person may name who it reports to and its division', () => {
  const manager = {
    ...base,
    id: 'person:oscar-ops',
    kind: 'person',
    tier: 'manager',
    family: 'manager',
    modes: ['become'],
  }
  expect(checkEntry({ ...manager, reportsTo: 'oscar' })).toEqual({
    why: 'reportsTo must be a person id',
  })
  expect(
    checkEntry({ ...manager, reportsTo: 'person:paige', division: 'technical' }),
  ).toMatchObject({
    entry: { reportsTo: 'person:paige', division: 'technical' },
  })
})

test('tierRank orders the ladder from intern to owner', () => {
  expect(['intern', 'employee', 'manager', 'owner', 'board', undefined].map(tierRank)).toEqual([
    1, 2, 3, 4, 0, 0,
  ])
})

test('a when of 160 characters or more is refused', () => {
  expect(checkEntry({ ...base, when: 'x'.repeat(160) })).toEqual({
    why: 'when must be 1 to 159 characters',
  })
})

test('a load that is not file, skill, tool or none is refused', () => {
  expect(checkEntry({ ...base, load: { type: 'url' } })).toEqual({
    why: 'load must be file, skill, tool or none',
  })
})

test('a hand entry replaces the generated entry with the same id, and a bad entry is skipped and named', () => {
  const root = join(dir, 'catalog')
  mkdirSync(root, { recursive: true })
  const shot = { ...base, id: 'instrument:shot-check' }
  writeFileSync(
    join(root, 'generated-a.json'),
    JSON.stringify([{ ...shot, name: 'Generated Name' }]),
  )
  writeFileSync(
    join(root, 'hand-b.json'),
    JSON.stringify([{ ...shot, name: 'Hand Name' }, { id: 'worker:bad' }]),
  )
  writeFileSync(join(root, 'hand-c.json'), '{ not json')
  const cat = loadCatalog(dir)
  expect(cat.entries.get('instrument:shot-check')?.name).toBe('Hand Name')
  expect(cat.skipped.map((s) => s.file).sort()).toEqual(['hand-b.json', 'hand-c.json'])
})
