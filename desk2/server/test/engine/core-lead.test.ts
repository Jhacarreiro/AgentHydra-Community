// The face a chat's row shows for Hydra Core (A2-F7, A4-F7): its lead (a hydra.md `## Lead` line, which wins, else the
// lead its placement.json keeps) or, for a seat, the persona its Prime's seats.json opened it for; with the persona's
// photo wherever it lives (a manager's folder, a portraits folder beside the persona files), else none. A pinned
// manager still wins, and a chat with no lead has no face.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { ServerContext } from '../../src/context'
import { ChatManager } from '../../src/engine/chat-manager'
import { chatFace, forgetCoreFaces } from '../../src/engine/core-lead'
import { DEFAULT_SETTINGS } from '../../src/settings'
import avatars from '../../src/plugins/37-manager-avatars'
import { type CoreFixture, coreFixture, PNG, writeChatFile } from '../fixtures/hydra-core'
import { fakeBridge, fakeQueries } from './manager/fakes'

const PRIME = '7f0c1d2e-0000-4000-8000-00000000000a'
const SEAT = '7f0c1d2e-0000-4000-8000-00000000000b'

const savedManagers = process.env.AGENTHYDRA_MANAGERS_DIR
let core: CoreFixture | null = null
let managers: string | null = null

afterEach(() => {
  core?.done()
  core = null
  if (managers) rmSync(managers, { recursive: true, force: true })
  managers = null
  if (savedManagers === undefined) delete process.env.AGENTHYDRA_MANAGERS_DIR
  else process.env.AGENTHYDRA_MANAGERS_DIR = savedManagers
  forgetCoreFaces()
})

function setup(): CoreFixture {
  core = coreFixture({ on: true, placement: 'slot' })
  managers = mkdtempSync(join(tmpdir(), 'desk-core-managers-'))
  process.env.AGENTHYDRA_MANAGERS_DIR = managers
  forgetCoreFaces()
  return core
}

const placement = (lead: string | null) => JSON.stringify({ placement: 'slot', hash: 'h', ids: [], chars: 1, started: [], lead, prompt: 'p' })
const hydraMd = (lead: string) => `# hydra.md\nUpdated: 2026-10-14T09:00:00.000Z  Tier: 2  Team: -\n## Lead (become)\n${lead}\n## Under you\n## Tools\n## Knowledge\n## Plan\n## Scope log\n`

test('a chat shows the lead its placement.json keeps, with the photo from the portraits beside the persona files', () => {
  const c = setup()
  writeChatFile(c.dir, PRIME, 'placement.json', placement('person:ada-layout'))
  expect(chatFace({ id: PRIME })).toMatchObject({ slug: 'ada-layout', name: 'Ada Example', title: 'Layout designer', role: 'lead', persona: true })
  expect(chatFace({ id: PRIME })?.photo).toEqual(expect.any(Number))
})

test("a hydra.md lead (the chat became someone) wins over placement.json's, and one not in the catalog shows its name", () => {
  const c = setup()
  writeChatFile(c.dir, PRIME, 'placement.json', placement('person:ada-layout'))
  writeChatFile(c.dir, PRIME, 'hydra.md', hydraMd(`Bo Example - Copy editor. Full text: ${join(c.seats, 'bo-copy.md')}`))
  expect(chatFace({ id: PRIME })).toMatchObject({ slug: 'bo-copy', name: 'Bo Example', role: 'lead', photo: null })
  forgetCoreFaces()
  writeChatFile(c.dir, PRIME, 'hydra.md', hydraMd('Cy Example - Invented outsider. Full text: C:/Users/me/cy.md'))
  expect(chatFace({ id: PRIME })).toMatchObject({ name: 'Cy Example', role: 'lead', photo: null, persona: true })
})

test('no lead, no face; and a pinned manager still wins over the lead', () => {
  const c = setup()
  expect(chatFace({ id: PRIME })).toBeNull()
  writeChatFile(c.dir, PRIME, 'placement.json', placement(null))
  expect(chatFace({ id: PRIME })).toBeNull()
  mkdirSync(join(managers!, 'example-manager'))
  writeFileSync(join(managers!, 'example-manager', 'persona.json'), JSON.stringify({ name: 'Example Manager', title: 'Invented title' }))
  writeChatFile(c.dir, PRIME, 'placement.json', placement('person:ada-layout'))
  forgetCoreFaces()
  expect(chatFace({ id: PRIME, managerSlug: 'example-manager' })).toMatchObject({ slug: 'example-manager', name: 'Example Manager' })
  expect(chatFace({ id: PRIME, managerSlug: 'example-manager' })?.role).toBeUndefined()
})

test('a lead who is a manager shows as that manager, with the photo in its folder', () => {
  const c = setup()
  mkdirSync(join(managers!, 'ada-layout'))
  writeFileSync(join(managers!, 'ada-layout', 'persona.json'), JSON.stringify({ name: 'Ada Manager', title: 'Head of layout' }))
  writeFileSync(join(managers!, 'ada-layout', 'avatar.png'), PNG)
  writeChatFile(c.dir, PRIME, 'placement.json', placement('person:ada-layout'))
  const face = chatFace({ id: PRIME })
  expect(face).toMatchObject({ slug: 'ada-layout', name: 'Ada Manager', title: 'Head of layout', role: 'lead' })
  expect(face?.persona).toBeUndefined()
  expect(face?.photo).toEqual(expect.any(Number))
})

test('every seat shows its persona: with its photo when one exists, else none (the initial)', () => {
  const c = setup()
  const other = '7f0c1d2e-0000-4000-8000-00000000000c'
  writeChatFile(c.dir, PRIME, 'seats.json', JSON.stringify({ 'person:bo-copy': { chat: SEAT, title: 'Bo Example · invented' }, 'person:ada-layout': { chat: other, title: 'Ada Example · invented' } }))
  expect(chatFace({ id: SEAT, parentId: PRIME })).toMatchObject({ slug: 'bo-copy', name: 'Bo Example', role: 'seat', photo: null, persona: true })
  expect(chatFace({ id: other, parentId: PRIME })).toMatchObject({ slug: 'ada-layout', role: 'seat', photo: expect.any(Number) })
})

test("a seat shows its own persona even when its hydra.md or placement.json names another lead (C4-F7), never that lead's photo", () => {
  const c = setup()
  writeChatFile(c.dir, PRIME, 'seats.json', JSON.stringify({ 'person:bo-copy': { chat: SEAT, title: 'Bo Example · invented' } }))
  // The hook moved the seat's lead to Ada, who has a photo; Bo has none.
  writeChatFile(c.dir, SEAT, 'hydra.md', hydraMd(`Ada Example - Layout designer. Full text: ${join(c.seats, 'ada-layout.md')}`))
  writeChatFile(c.dir, SEAT, 'placement.json', placement('person:ada-layout'))
  expect(chatFace({ id: SEAT, parentId: PRIME })).toMatchObject({ slug: 'bo-copy', name: 'Bo Example', role: 'seat', photo: null, persona: true })
  // The Prime itself still shows the lead it took.
  writeChatFile(c.dir, PRIME, 'hydra.md', hydraMd(`Ada Example - Layout designer. Full text: ${join(c.seats, 'ada-layout.md')}`))
  forgetCoreFaces()
  expect(chatFace({ id: PRIME })).toMatchObject({ slug: 'ada-layout', role: 'lead' })
})

test("GET /api/personas/:slug/avatar serves a persona's portrait, and 404s one with none", async () => {
  setup()
  const hono = new Hono()
  avatars(hono, { home: managers, deps: {} } as unknown as ServerContext)
  const ok = await hono.request('/api/personas/ada-layout/avatar')
  expect(ok.status).toBe(200)
  expect(ok.headers.get('content-type')).toBe('image/png')
  expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PNG)
  expect((await hono.request('/api/personas/bo-copy/avatar')).status).toBe(404)
  expect((await hono.request('/api/personas/no-such-one/avatar')).status).toBe(404)
  expect((await hono.request('/api/personas/Bad_Slug/avatar')).status).toBe(400)
})

test("a Desk chat's summary carries its lead from its own chat folder, and loses it with none", async () => {
  const c = setup()
  const home = mkdtempSync(join(tmpdir(), 'desk-core-lead-home-'))
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge: fakeBridge().bridge, queryImpl: fakeQueries().queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk' })
  try {
    const chat = await m.create({ cwd: home, delegateToCliMayte: false })
    expect(m.get(chat.id).manager).toBeNull()
    writeChatFile(c.dir, chat.id, 'placement.json', placement('person:ada-layout'))
    forgetCoreFaces()
    expect(m.get(chat.id).manager).toMatchObject({ slug: 'ada-layout', name: 'Ada Example', role: 'lead', persona: true })
  } finally {
    await m.closeAll()
    rmSync(home, { recursive: true, force: true })
  }
})
