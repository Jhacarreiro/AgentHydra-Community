import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyDoc, renderHydra } from '../src/hydra-core/hydra-md'
import { packFor } from '../src/hydra-core/pack'
import { chatPaths } from '../src/hydra-core/paths'
import { answer, scope } from '../src/hydra-core/tree'
import { type Daemon, use } from '../src/hydra-core/use'
import { scratch, startChat } from './hydra-core-fixture'

const CWD = 'C:/Users/me/project'
const CHAT = 'chat-example-lead'
const SESSION = 'session-example-1'
const now = new Date('2026-10-14T10:00:00.000Z')
const daemon: Daemon = {
  dispatch: async () => 'job-example',
  report: async () => null,
  send: async () => {},
}
let dir = ''
let leadPath = ''

beforeEach(() => {
  dir = scratch()
  leadPath = join(dir, 'lead-brief.md')
  writeFileSync(join(dir, 'folder-8k.md'), `FOLDER 8K\n${'f'.repeat(8 * 1024)}\n`)
  writeFileSync(
    join(dir, 'catalog', 'hand-lead.json'),
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
        load: { type: 'file', path: leadPath },
      },
    ]),
  )
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function withLead(leadBytes: number): void {
  writeFileSync(leadPath, `LEAD BRIEF START\n${'l'.repeat(leadBytes)}\n`)
  const doc = emptyDoc(now)
  doc.lead = `Quinn Lead - Leads the budget work. Full text: ${leadPath}`
  startChat(dir, CHAT, 'Plan the budget')
  writeFileSync(chatPaths(dir, CHAT).hydraMd, renderHydra(doc))
}

function firstPack(session: string) {
  return packFor(dir, { chat: CHAT, session, cwd: CWD, prompt: 'plan the budget' }, now)
}

function goOf(message: string) {
  startChat(dir, CHAT, message)
  scope(dir, CHAT, now)
  return answer(dir, CHAT, { answer: 'no' }, now)
}

test('a pack that holds only the lead pointer names the lead by its catalog id', () => {
  withLead(8 * 1024)
  const pack = firstPack(SESSION)
  expect(pack.text).toContain(
    'Load the brief with core_use { chat: "chat-example-lead", id: "person:quinn-lead", mode: "become" }.',
  )
  expect(pack.text).not.toContain('lead:Quinn Lead')
  expect(pack.ids).toContain('person:quinn-lead')
})

test('core_use become accepts the lead:<Name> key and resolves it to the same entry', async () => {
  withLead(1024)
  const byName = await use(dir, { chat: CHAT, id: 'lead:Quinn Lead', mode: 'become' }, daemon, now)
  const byId = await use(dir, { chat: CHAT, id: 'person:quinn-lead', mode: 'become' }, daemon, now)
  expect(byName).toEqual(byId)
  expect(byName).toMatchObject({
    lead: `Quinn Lead - Leads the budget work. Full text: ${leadPath}`,
  })
})

test('the first go of a session whose pack held only the pointer carries the lead brief once', () => {
  withLead(8 * 1024)
  firstPack(SESSION)
  expect(goOf('Plan the budget')).toMatchObject({
    verdict: 'go',
    lead: { id: 'person:quinn-lead', name: 'Quinn Lead' },
  })
  const second = firstPack(SESSION)
  expect(second.text).not.toContain('Lead for this message')
  expect(goOf('Plan the budget again')).not.toHaveProperty('lead')
})

test('a session whose pack carried the full lead brief gets no lead on its go', () => {
  withLead(256)
  const pack = firstPack(SESSION)
  expect(pack.text).toContain('LEAD BRIEF START')
  expect(goOf('Plan the budget')).not.toHaveProperty('lead')
})

test('a new session after a pointer-only pack gets the brief on its first go', () => {
  withLead(8 * 1024)
  firstPack(SESSION)
  expect(goOf('Plan the budget')).toHaveProperty('lead')
  firstPack('session-example-2')
  expect(goOf('Plan the budget')).toHaveProperty('lead')
  expect(goOf('Plan the budget')).not.toHaveProperty('lead')
})
