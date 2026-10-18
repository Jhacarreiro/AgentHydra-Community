import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { ServerContext } from '../../src/context'
import { currentManager } from '../../src/engine/managers'
import avatars, { MAX_AVATAR_BYTES } from '../../src/plugins/37-manager-avatars'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

const oldManagersDir = process.env.AGENTHYDRA_MANAGERS_DIR
let personas: string | null = null
let changed: string[] = []

afterEach(() => {
  if (personas) rmSync(personas, { recursive: true, force: true })
  personas = null
  if (oldManagersDir === undefined) delete process.env.AGENTHYDRA_MANAGERS_DIR
  else process.env.AGENTHYDRA_MANAGERS_DIR = oldManagersDir
})

function setup(): Hono {
  personas = mkdtempSync(join(tmpdir(), 'avatar-personas-'))
  process.env.AGENTHYDRA_MANAGERS_DIR = personas
  mkdirSync(join(personas, 'example-manager'))
  writeFileSync(
    join(personas, 'example-manager', 'persona.json'),
    JSON.stringify({ name: 'Example Manager', title: 'Invented title', oneLiner: 'An invented line.' }),
  )
  changed = []
  const hono = new Hono()
  avatars(hono, { home: personas, deps: { managerChanged: (slug: string) => changed.push(slug) } } as unknown as ServerContext)
  return hono
}

function put(hono: Hono, slug: string, body: BodyInit, type: string, headers: Record<string, string> = {}): Response | Promise<Response> {
  return hono.request(`/api/managers/${slug}/avatar`, { method: 'PUT', headers: { 'content-type': type, ...headers }, body })
}

function get(hono: Hono, slug: string): Response | Promise<Response> {
  return hono.request(`/api/managers/${slug}/avatar`)
}

test('a slug that is not a manager is refused on both routes', async () => {
  const hono = setup()
  expect((await put(hono, 'Bad_Slug', PNG, 'image/png')).status).toBe(400)
  expect(await (await put(hono, 'Bad_Slug', PNG, 'image/png')).json()).toEqual({ error: 'Not a manager: Bad_Slug' })
  const badRead = await get(hono, 'Bad_Slug')
  expect(badRead.status).toBe(400)
  expect(await badRead.json()).toEqual({ error: 'Not a manager: Bad_Slug' })
  const missing = await put(hono, 'no-such-manager', PNG, 'image/png')
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({ error: 'Not a manager: no-such-manager' })
  const read = await get(hono, 'no-such-manager')
  expect(read.status).toBe(404)
  expect(await read.json()).toEqual({ error: 'Not a manager: no-such-manager' })
})

test('a body that is not a PNG, JPG, WebP or GIF is refused with 415', async () => {
  const hono = setup()
  const wrongType = await put(hono, 'example-manager', 'hello', 'text/plain')
  expect(wrongType.status).toBe(415)
  expect(await wrongType.json()).toEqual({ error: 'A manager photo must be a PNG, JPG, WebP or GIF.' })
  const wrongBytes = await put(hono, 'example-manager', JPG, 'image/png')
  expect(wrongBytes.status).toBe(415)
  expect(await wrongBytes.json()).toEqual({ error: 'A manager photo must be a PNG, JPG, WebP or GIF.' })
})

test('a photo over 2 MB is refused with 413, by its body and by its declared length', async () => {
  const hono = setup()
  const big = new Uint8Array(MAX_AVATAR_BYTES + 1)
  big.set(PNG)
  const body = await put(hono, 'example-manager', big, 'image/png')
  expect(body.status).toBe(413)
  expect(await body.json()).toEqual({ error: 'That photo is over 2 MB.' })
  const declared = await put(hono, 'example-manager', PNG, 'image/png', { 'content-length': String(MAX_AVATAR_BYTES + 1) })
  expect(declared.status).toBe(413)
  expect(await declared.json()).toEqual({ error: 'That photo is over 2 MB.' })
})

test('an empty photo is refused with 400', async () => {
  const hono = setup()
  const res = await put(hono, 'example-manager', new Uint8Array(0), 'image/png')
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'That photo is empty.' })
})

test('a PNG is saved, served with its headers, and reaches the manager label', async () => {
  const hono = setup()
  // Read once first, so the label is held: the save must drop it.
  expect(currentManager('example-manager', null)?.photo).toBeNull()
  const saved = await put(hono, 'example-manager', PNG, 'image/png')
  expect(saved.status).toBe(200)
  const { ok, photo } = (await saved.json()) as { ok: boolean; photo: number }
  expect(ok).toBe(true)
  expect(photo).toEqual(expect.any(Number))
  expect(changed).toEqual(['example-manager'])

  const read = await get(hono, 'example-manager')
  expect(read.status).toBe(200)
  expect(read.headers.get('content-type')).toBe('image/png')
  expect(read.headers.get('x-content-type-options')).toBe('nosniff')
  expect(read.headers.get('content-security-policy')).toBe("default-src 'none'")
  expect(read.headers.get('cache-control')).toBe('no-cache')
  expect(Array.from(new Uint8Array(await read.arrayBuffer()))).toEqual(Array.from(PNG))

  expect(currentManager('example-manager', null)).toEqual({
    slug: 'example-manager',
    name: 'Example Manager',
    title: 'Invented title',
    oneLiner: 'An invented line.',
    photo,
    statsLine: null,
  })
})

test('a new photo replaces the old one and leaves no temporary file', async () => {
  const hono = setup()
  await put(hono, 'example-manager', PNG, 'image/png')
  const replaced = await put(hono, 'example-manager', JPG, 'image/jpeg')
  expect(replaced.status).toBe(200)
  const files = readdirSync(join(personas!, 'example-manager'))
  expect(files.filter((f) => f.startsWith('avatar.'))).toEqual(['avatar.jpg'])
  expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
  const read = await get(hono, 'example-manager')
  expect(read.headers.get('content-type')).toBe('image/jpeg')
  expect(Array.from(new Uint8Array(await read.arrayBuffer()))).toEqual(Array.from(JPG))
})

test('a manager with no photo gets a 404 with a message', async () => {
  const hono = setup()
  const res = await get(hono, 'example-manager')
  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ error: 'Example Manager has no photo.' })
})
