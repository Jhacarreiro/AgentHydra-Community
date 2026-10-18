import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { packFor, TOTAL_CAP } from '../src/hydra-core/pack'
import { chatPaths } from '../src/hydra-core/paths'
import { scratch } from './hydra-core-fixture'

const CWD = 'C:/Users/me/project'
let dir = ''

beforeEach(() => {
  dir = scratch()
  const rules = join(dir, 'project-rules.md')
  const side = join(dir, 'side-rules.md')
  writeFileSync(rules, 'PROJECT RULE TEXT\n')
  writeFileSync(side, 'SIDE RULE TEXT\n')
  const folder = [
    {
      id: 'knowledge:project-rules',
      kind: 'knowledge',
      name: 'Project Rules',
      when: 'Working rules for the project',
      tags: ['repo'],
      folders: [CWD],
      cost: 'free',
      how: 'read the project rules',
      load: { type: 'file', path: rules },
    },
    {
      id: 'knowledge:side-rules',
      kind: 'knowledge',
      name: 'Side Rules',
      when: 'Notes that only sometimes apply',
      tags: [],
      folders: [CWD],
      cost: 'free',
      how: 'read the side rules',
      load: { type: 'file', path: side },
    },
  ]
  writeFileSync(join(dir, 'catalog', 'hand-folder.json'), JSON.stringify(folder))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const req = (prompt: string, extra: { session?: string; full?: boolean } = {}) => ({
  chat: 'chat-1',
  session: extra.session ?? 'sess-1',
  cwd: CWD,
  prompt,
  ...(extra.full ? { full: true } : {}),
})

test('the first pack has the folder rules, a weak match as a pointer, and the closing line', () => {
  const pack = packFor(dir, req('redo the brand colours on the dashboard'))
  expect(pack.mode).toBe('first')
  expect(pack.text).toContain('PROJECT RULE TEXT')
  expect(pack.text).not.toContain('SIDE RULE TEXT')
  expect(pack.text).toContain('- knowledge:brand-notes - ')
  expect(pack.text).not.toContain('Brand notes: full text.')
  expect(pack.text).toContain('core_find { need: "<what you need>", chat: "chat-1" }')
  expect(pack.ids).toContain('knowledge:project-rules')
  expect(pack.ids).toContain('knowledge:brand-notes')
  expect(pack.bytes).toBe(Buffer.byteLength(pack.text, 'utf8'))
  expect(pack.ms).toBeGreaterThanOrEqual(0)
})

test('a strong match is pasted in full', () => {
  const pack = packFor(
    dir,
    req('brand notes: brand colours and type rules for the dashboard brand'),
  )
  expect(pack.text).toContain('Brand notes: full text.')
})

test("a folder entry that is not the main rules can still match, and another folder's entry never does", () => {
  writeFileSync(
    join(dir, 'catalog', 'hand-other.json'),
    JSON.stringify([
      {
        id: 'knowledge:other-side',
        kind: 'knowledge',
        name: 'Side Notes Elsewhere',
        when: 'Notes that only sometimes apply',
        tags: [],
        folders: ['C:/Users/me/elsewhere'],
        cost: 'free',
        how: 'read the side notes',
        load: { type: 'file', path: join(dir, 'side-rules.md') },
      },
    ]),
  )
  const pack = packFor(dir, req('side rules notes that sometimes apply'))
  expect(pack.ids).toContain('knowledge:side-rules')
  expect(pack.ids).not.toContain('knowledge:other-side')
})

test('a repeated message in the same session sends only what was not sent before', () => {
  packFor(dir, req('redo the brand colours on the dashboard'))
  const again = packFor(dir, req('brand colours again'))
  expect(again.mode).toBe('delta')
  expect(again.text).toBe('')
  expect(again.ids).toEqual([])
  expect(again.text).not.toContain('PROJECT RULE TEXT')
  expect(again.text).not.toContain('core_find')
})

test('a delta carries only the new matches, under the delta header, with no closing line', () => {
  packFor(dir, req('redo the brand colours on the dashboard'))
  const next = packFor(dir, req('take a screenshot of the page'))
  expect(next.mode).toBe('delta')
  expect(next.text.startsWith('Hydra Core, new for this message:')).toBe(true)
  expect(next.text).toContain('instrument:screen-capture')
  expect(next.text).not.toContain('PROJECT RULE TEXT')
  expect(next.text).not.toContain('More is one core_find')
  expect(next.ids).not.toContain('knowledge:project-rules')
})

test('a new session is a first pack again, and a full request resends the folder rules', () => {
  packFor(dir, req('brand colours'))
  expect(packFor(dir, req('brand colours', { session: 'sess-2' })).mode).toBe('first')
  const full = packFor(dir, req('brand colours', { full: true }))
  expect(full.mode).toBe('full')
  expect(full.text).toContain('PROJECT RULE TEXT')
  expect(full.text).toContain('core_find')
})

test('the folder rules and the lead are capped and the cut is named', () => {
  writeFileSync(join(dir, 'big-rules.md'), 'x'.repeat(40 * 1024))
  writeFileSync(
    join(dir, 'catalog', 'hand-big.json'),
    JSON.stringify([
      {
        id: 'knowledge:big-rules',
        kind: 'knowledge',
        name: 'Big Rules',
        when: 'Very long rules',
        tags: ['repo'],
        folders: [CWD],
        cost: 'free',
        how: 'read them',
        load: { type: 'file', path: join(dir, 'big-rules.md') },
      },
    ]),
  )
  const pack = packFor(dir, req('hello'))
  expect(pack.text).toContain('[cut at')
  expect(pack.text.length).toBeLessThanOrEqual(TOTAL_CAP)
})

test('a pack is logged with its mode, ids, bytes and time', () => {
  packFor(dir, req('redo the brand colours'))
  const line = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').at(-1) ?? ''
  const entry = JSON.parse(line)
  expect(entry).toMatchObject({ event: 'pack', chat: 'chat-1', session: 'sess-1', mode: 'first' })
  expect(entry.ids).toContain('knowledge:project-rules')
  expect(typeof entry.bytes).toBe('number')
  expect(typeof entry.ms).toBe('number')
})

test('the sent record lives beside the chat and lists each session', () => {
  packFor(dir, req('brand colours'))
  const sent = JSON.parse(readFileSync(chatPaths(dir, 'chat-1').sent, 'utf8'))
  expect(Object.keys(sent)).toEqual(['sess-1'])
  expect(sent['sess-1']).toContain('knowledge:project-rules')
  expect(existsSync(join(dir, 'chats', 'chat-1', 'sent.json'))).toBe(true)
})

test('a message with nothing matching and no folder rules sends the closing line only', () => {
  const pack = packFor(dir, { ...req('zzz qqq'), cwd: 'C:/Users/other' })
  expect(pack.mode).toBe('first')
  expect(pack.ids).toEqual([])
  expect(pack.text).toContain('core_find')
})

const knowledge = (id: string, name: string, when: string, path: string) => ({
  id,
  kind: 'knowledge',
  name,
  when,
  tags: [],
  cost: 'free',
  how: 'read it',
  load: { type: 'file', path },
})

test('a first pack with big folder rules, lead and matches stays within the cap', () => {
  writeFileSync(
    join(dir, 'folder-8k.md'),
    `FOLDER 8K START\n${'f'.repeat(8 * 1024)}\nFOLDER 8K END\n`,
  )
  writeFileSync(join(dir, 'lead-8k.md'), `LEAD 8K START\n${'l'.repeat(8 * 1024)}\n`)
  for (const n of ['alpha', 'beta', 'gamma'])
    writeFileSync(join(dir, `${n}.md`), `${n} body\n${'k'.repeat(2 * 1024)}\n`)
  writeFileSync(
    join(dir, 'catalog', 'hand-budget.json'),
    JSON.stringify([
      {
        id: 'knowledge:folder-8k',
        kind: 'knowledge',
        name: 'Folder Eight K',
        when: 'Long folder rules',
        tags: ['repo'],
        folders: [CWD],
        cost: 'free',
        how: 'read them',
        load: { type: 'file', path: join(dir, 'folder-8k.md') },
      },
      {
        id: 'person:quinn-lead',
        kind: 'person',
        name: 'Quinn Lead',
        tier: 'manager',
        family: 'manager',
        when: 'Leads the budget work',
        tags: ['budget'],
        modes: ['become'],
        cost: 'medium',
        how: 'hand her the budget',
        load: { type: 'file', path: join(dir, 'lead-8k.md') },
      },
      knowledge('knowledge:alpha', 'Alpha Spec', 'Alpha notes', join(dir, 'alpha.md')),
      knowledge('knowledge:beta', 'Beta Spec', 'Beta notes', join(dir, 'beta.md')),
      knowledge('knowledge:gamma', 'Gamma Spec', 'Gamma notes', join(dir, 'gamma.md')),
    ]),
  )
  const pack = packFor(dir, req('quinn lead: alpha spec beta spec gamma spec'))
  expect(pack.text.length).toBeLessThanOrEqual(TOTAL_CAP)
  expect(pack.text).toContain('FOLDER 8K START')
  expect(pack.text).toContain('FOLDER 8K END')
  expect(pack.text).not.toContain('[cut at')
  expect(pack.text).not.toContain('LEAD 8K START')
  expect(pack.text).toContain(
    'Lead for this message: Quinn Lead. Load the brief with core_use { chat: "chat-1", id: "person:quinn-lead", mode: "become" }.',
  )
  expect(pack.ids).toContain('person:quinn-lead')
})

test('folder rules over the budget are cut at the budget with the pointer', () => {
  writeFileSync(join(dir, 'big-rules.md'), 'x'.repeat(40 * 1024))
  writeFileSync(
    join(dir, 'catalog', 'hand-big.json'),
    JSON.stringify([
      {
        id: 'knowledge:big-rules',
        kind: 'knowledge',
        name: 'Big Rules',
        when: 'Very long rules',
        tags: ['repo'],
        folders: [CWD],
        cost: 'free',
        how: 'read them',
        load: { type: 'file', path: join(dir, 'big-rules.md') },
      },
    ]),
  )
  const pack = packFor(dir, req('hello'))
  expect(pack.text.length).toBeLessThanOrEqual(TOTAL_CAP)
  expect(pack.text).toContain(`[cut at`)
  expect(pack.text).toContain(`the rest is in ${join(dir, 'big-rules.md')}`)
  expect(pack.text).toContain('core_find')
  expect(pack.ids).not.toContain('knowledge:big-rules')
})

test('a delta with new big matches stays within the cap', () => {
  writeFileSync(join(dir, 'alpha.md'), `alpha body\n${'k'.repeat(4 * 1024)}\n`)
  writeFileSync(join(dir, 'beta.md'), `beta body\n${'k'.repeat(4 * 1024)}\n`)
  writeFileSync(join(dir, 'gamma.md'), `gamma body\n${'k'.repeat(4 * 1024)}\n`)
  writeFileSync(
    join(dir, 'catalog', 'hand-delta.json'),
    JSON.stringify([
      knowledge('knowledge:alpha', 'Alpha Spec', 'Alpha notes', join(dir, 'alpha.md')),
      knowledge('knowledge:beta', 'Beta Spec', 'Beta notes', join(dir, 'beta.md')),
      knowledge('knowledge:gamma', 'Gamma Spec', 'Gamma notes', join(dir, 'gamma.md')),
    ]),
  )
  packFor(dir, req('zzz qqq'))
  const next = packFor(
    dir,
    req(
      'alpha spec alpha notes: alpha spec alpha notes, beta spec beta notes, gamma spec gamma notes',
    ),
  )
  expect(next.mode).toBe('delta')
  expect(next.text.length).toBeLessThanOrEqual(TOTAL_CAP)
  expect(next.text).toContain('- knowledge:alpha - ')
  expect(next.ids).toContain('knowledge:alpha')
})

test('ids left out of the text are not recorded as sent and a later delta can send them', () => {
  const specs = Array.from({ length: 60 }, (_, i) => {
    const n = i + 1
    writeFileSync(join(dir, `spec-${n}.md`), `spec ${n} body\n`)
    return knowledge(
      `knowledge:spec-note-${n}`,
      `Spec Note ${n}`,
      `Spec note number ${n} with a long description of what it covers for the team`,
      join(dir, `spec-${n}.md`),
    )
  })
  writeFileSync(join(dir, 'catalog', 'hand-specs.json'), JSON.stringify(specs))
  const pack = packFor(dir, req('spec note'))
  const sent = JSON.parse(readFileSync(chatPaths(dir, 'chat-1').sent, 'utf8'))
  expect(pack.text.length).toBeLessThanOrEqual(TOTAL_CAP)
  const dropped = specs.map((e) => e.id).filter((id) => !pack.text.includes(id))
  expect(dropped.length).toBeGreaterThan(0)
  expect(sent['sess-1']).toEqual(pack.ids)
  for (const id of dropped) expect(sent['sess-1']).not.toContain(id)
  const later = packFor(dir, req('spec note'))
  expect(later.mode).toBe('delta')
  expect(later.ids.some((id) => dropped.includes(id))).toBe(true)
})
