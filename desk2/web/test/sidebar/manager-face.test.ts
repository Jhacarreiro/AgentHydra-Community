import { afterEach, expect, test } from 'bun:test'
import { managerFace, photoProblem, uploadPhoto, type ChatManager } from '../../src/components/sidebar/manager-face'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const manager = (extra: Partial<ChatManager> = {}): ChatManager => ({ slug: 'ada-design', name: 'Ada', title: 'Head of Design', oneLiner: 'Owns how every screen looks.', photo: null, ...extra })

test('a manager with a photo draws it, versioned by the photo so a new one is fetched', () => {
  const face = managerFace(manager({ photo: 1760000000123 }))
  expect(face.src).toBe('/api/managers/ada-design/avatar?v=1760000000123')
  expect(face.label).toBe('Manager: Ada, Head of Design')
})

test('a manager without a photo draws its initial on its slug\'s own tone', () => {
  const face = managerFace(manager())
  expect(face.src).toBeNull()
  expect(face.initial).toBe('A')
  expect(managerFace(manager({ name: 'ada' })).initial).toBe('A')
  // The same slug keeps its tone on every row; the tone is the slug's, not the name's.
  expect(managerFace(manager({ name: 'Other' })).tone).toEqual(face.tone)
  const tones = new Set(['ada-design', 'bo-backend', 'cy-copy', 'di-floor', 'ed-plans', 'fa-ops'].map((slug) => managerFace(manager({ slug })).tone.bg))
  expect(tones.size).toBeGreaterThan(1)
})

test('the hover label leaves the title out when the persona has none', () => {
  expect(managerFace(manager({ title: null })).label).toBe('Manager: Ada')
})

test("a chat's Hydra Core lead and a seat's persona say so, and a persona who is no manager is read from the personas route", () => {
  const lead = managerFace(manager({ slug: 'cy-layout', name: 'Cy', title: 'Layout designer', photo: 1760000000999, role: 'lead', persona: true }))
  expect(lead.label).toBe('Lead: Cy, Layout designer')
  expect(lead.src).toBe('/api/personas/cy-layout/avatar?v=1760000000999')
  expect(lead.canChangePhoto).toBe(false)
  const seat = managerFace(manager({ slug: 'bo-copy', name: 'Bo', title: null, role: 'seat', persona: true }))
  expect(seat.label).toBe('Seat: Bo')
  expect(seat.src).toBeNull()
  expect(seat.initial).toBe('B')
  // A lead who is a manager keeps the manager's photo, which Desk can change.
  const managerLead = managerFace(manager({ photo: 1760000000123, role: 'lead' }))
  expect(managerLead.label).toBe('Lead: Ada, Head of Design')
  expect(managerLead.src).toBe('/api/managers/ada-design/avatar?v=1760000000123')
  expect(managerLead.canChangePhoto).toBe(true)
  expect(managerFace(manager()).canChangePhoto).toBe(true)
})

test('a photo must be a PNG, JPG, WebP or GIF of at most 2 MB', () => {
  expect(photoProblem({ type: 'image/png', size: 1000 })).toBeNull()
  expect(photoProblem({ type: 'image/gif', size: 2 * 1024 * 1024 })).toBeNull()
  expect(photoProblem({ type: 'image/svg+xml', size: 1000 })).toBe('A manager photo must be a PNG, JPG, WebP or GIF.')
  expect(photoProblem({ type: 'image/jpeg', size: 2 * 1024 * 1024 + 1 })).toBe('That photo is over 2 MB.')
  expect(photoProblem({ type: 'image/webp', size: 0 })).toBe('That file is empty.')
})

test('an upload shows the new photo on every row of that manager, and a refusal is the server\'s sentence', async () => {
  let sent: { url: string; type: string | null } | null = null
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = { url, type: new Headers(init.headers).get('content-type') }
    return new Response(JSON.stringify({ ok: true, photo: 1760000009999 }), { status: 200 })
  }) as typeof fetch
  await uploadPhoto('cy-copy', new File([new Uint8Array([1, 2, 3])], 'me.png', { type: 'image/png' }))
  expect(sent!).toEqual({ url: '/api/managers/cy-copy/avatar', type: 'image/png' })
  expect(managerFace(manager({ slug: 'cy-copy', photo: null })).src).toBe('/api/managers/cy-copy/avatar?v=1760000009999')
  expect(managerFace(manager({ slug: 'cy-copy', photo: 5 })).src).toBe('/api/managers/cy-copy/avatar?v=1760000009999')
  // A photo another window put there later is the one shown.
  expect(managerFace(manager({ slug: 'cy-copy', photo: 1760000020000 })).src).toBe('/api/managers/cy-copy/avatar?v=1760000020000')

  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'That photo is over 2 MB.' }), { status: 413 })) as unknown as typeof fetch
  await expect(uploadPhoto('cy-copy', new File([new Uint8Array([1])], 'me.png', { type: 'image/png' }))).rejects.toThrow('That photo is over 2 MB.')
  // A file the picker should not have let through never reaches the server.
  globalThis.fetch = (async () => {
    throw new Error('no request expected')
  }) as unknown as typeof fetch
  await expect(uploadPhoto('cy-copy', new File(['<svg/>'], 'me.svg', { type: 'image/svg+xml' }))).rejects.toThrow('A manager photo must be a PNG, JPG, WebP or GIF.')
})
