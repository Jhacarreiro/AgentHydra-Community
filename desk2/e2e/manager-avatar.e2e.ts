// The manager avatar on sidebar rows, end to end (bun e2e/manager-avatar.e2e.ts; Windows, Edge; run `bun run build` first): the built
// Desk 2 on a free port with a throwaway HYDRA_DESK_HOME and its own AGENTHYDRA_MANAGERS_DIR, where the invented manager Ada has a photo,
// draws the parity scene 'manager-avatar' (web/src/dev/parity/fixtures.ts managerChats). Checks: Ada's rows show her photo, served by
// GET /api/managers/ada-design/avatar; Bo's rows show his initial; each avatar sits left of its title, after the status dot, in a 26px
// row whose long title still fades; a click on an avatar opens the manager's card (name, title, one-line description, Change photo)
// just below it and leaves the row unselected; Change photo with a PNG replaces the file and every row of Ada shows the new version; a
// file the server refuses shows its sentence in the card. Prints PASS/FAIL per check, exits 1 on any FAIL, and saves a screenshot of
// the open card over the rows to %TEMP%\manager-avatar\card.png. A chat's Hydra Core lead who is no manager (Cy, from a scratch
// AGENTHYDRA_CORE_DIR whose catalog's persona has a photo in a portraits folder beside its file) shows 'Lead: …' with that photo,
// served by GET /api/personas/cy-layout/avatar, and its card offers no Change photo; its row is saved to
// %TEMP%\manager-avatar\lead-face.jpg (and to E2E_LEAD_SHOT when set). Prints aria-labels only, never a row's text.

import { deflateSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { portFrom } from './lib/free-port'
import { QUIET_EDGE } from './lib/edge-flags'

const DESK = resolve(import.meta.dir, '..')
const PORT = portFrom(process.env.E2E_PORT)
const CDP = portFrom(process.env.E2E_CDP_PORT)
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
/** A w x h RGB PNG painted by `paint`. */
function png(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(w, 0)
  header.writeUInt32BE(h, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set(paint(x, y), y * (w * 3 + 1) + 1 + x * 3)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
// A face-like disc on a warm ground, then a cool one: two photos a person tells apart in the screenshot.
const face = (ground: [number, number, number], skin: [number, number, number]) =>
  png(96, 96, (x, y) => ((x - 48) ** 2 + (y - 40) ** 2 < 22 ** 2 || ((x - 48) ** 2) / 40 ** 2 + ((y - 100) ** 2) / 36 ** 2 < 1 ? skin : ground))

const SCRATCH = mkdtempSync(join(tmpdir(), 'desk2-manager-avatar-'))
const home = join(SCRATCH, 'home')
const managers = join(SCRATCH, 'managers')
const profile = join(SCRATCH, 'edge')
const files = join(SCRATCH, 'files')
for (const dir of [home, profile, files, join(managers, 'ada-design'), join(managers, 'bo-backend')]) mkdirSync(dir, { recursive: true })
writeFileSync(join(managers, 'ada-design', 'persona.json'), JSON.stringify({ slug: 'ada-design', name: 'Ada', title: 'Head of Design' }))
writeFileSync(join(managers, 'bo-backend', 'persona.json'), JSON.stringify({ slug: 'bo-backend', name: 'Bo', title: 'Backend Engineer' }))
writeFileSync(join(managers, 'ada-design', 'avatar.png'), face([196, 120, 72], [244, 214, 182]))
const NEW_PHOTO = join(files, 'new-photo.png')
writeFileSync(NEW_PHOTO, face([64, 120, 132], [236, 220, 200]))
// Named .png and picked as one, but not a PNG inside: the server's magic-number check refuses it.
const NOT_PNG = join(files, 'not-really.png')
writeFileSync(NOT_PNG, 'this is text, not a picture')
// Hydra Core's scratch folder: one catalog persona, Cy, whose portrait sits in the portraits folder beside her persona file.
const core = join(SCRATCH, 'core')
for (const dir of [join(core, 'catalog'), join(core, 'personas', 'seats'), join(core, 'personas', 'portraits')]) mkdirSync(dir, { recursive: true })
writeFileSync(join(core, 'personas', 'seats', 'cy-layout.md'), 'Cy: an invented layout designer.\n')
writeFileSync(join(core, 'personas', 'portraits', 'cy-layout.png'), face([92, 74, 140], [238, 206, 178]))
writeFileSync(join(core, 'catalog', 'hand-e2e.json'), JSON.stringify([{ id: 'person:cy-layout', kind: 'person', name: 'Cy', title: 'Layout designer', tier: 'employee', family: 'expert', modes: ['consult', 'become'],
  when: 'Designs dashboard layouts and styling', tags: ['layout'], cost: 'low', how: 'ask her', load: { type: 'file', path: join(core, 'personas', 'seats', 'cy-layout.md') } }]))

const server = Bun.spawn([process.execPath, 'server/src/index.ts'], {
  cwd: DESK, env: { ...process.env, HYDRA_DESK_PORT: String(PORT), HYDRA_DESK_HOME: home, AGENTHYDRA_MANAGERS_DIR: managers, AGENTHYDRA_CORE_DIR: core },
  stdout: 'ignore', stderr: 'ignore', windowsHide: true,
})
const shotDir = join(tmpdir(), 'manager-avatar')
mkdirSync(shotDir, { recursive: true })
let edge: ReturnType<typeof Bun.spawn> | null = null
const sockets: WebSocket[] = []
let failed = 0
let total = 0
function check(what: string, pass: boolean, diag: unknown = '') {
  total++
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'} ${what}${pass ? '' : ` :: ${JSON.stringify(diag)}`}`)
}

// Each avatar on screen: its label, whether it draws a loaded photo (and that photo's address) or an initial, whether its row is selected,
// and where it sits: after the row's 24px status-dot slot and before the title, whose right-hand fade (its mask) stays.
const AVATARS = `[...document.querySelectorAll('[data-testid="manager-avatar"]')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => {
  const img = b.querySelector('img'); const r = b.getBoundingClientRect(); const row = b.closest('[role="button"]'); const title = row && row.querySelector('.row-title')
  return { label: b.getAttribute('aria-label'), src: img ? img.getAttribute('src') : null, loaded: !!img && img.complete && img.naturalWidth > 0,
    initial: img ? null : b.textContent.trim(), x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, l: r.left, r: r.right, rowSelected: row ? row.getAttribute('aria-current') === 'page' : null,
    rowH: row ? row.getBoundingClientRect().height : null, dotR: row ? row.firstElementChild.getBoundingClientRect().right : null,
    titleL: title ? title.getBoundingClientRect().left : null, titleMask: title ? getComputedStyle(title).maskImage : null, titleCut: title ? title.scrollWidth > title.clientWidth : null }
})`
const CARD = `(() => { const c = document.querySelector('[data-testid="manager-card"]'); if (!c) return null; const r = c.getBoundingClientRect()
  const button = [...c.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Change photo' || b.textContent.trim().startsWith('Saving'))
  return { text: c.textContent, img: !!c.querySelector('img'), button: !!button, error: c.querySelector('[role="alert"]')?.textContent ?? null, l: r.left, t: r.top, r: r.right, b: r.bottom } })()`

try {
  let up = false
  for (let t = 0; t < 60 && !up; t++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok } catch {}
    if (!up) await sleep(500)
  }
  if (!up) throw new Error(`server did not come up on ${PORT}`)
  edge = Bun.spawn([EDGE, '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    '--no-first-run', ...QUIET_EDGE, '--window-size=1300,800', 'about:blank'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
  let list: { type: string; webSocketDebuggerUrl: string }[] = []
  for (let t = 0; t < 50 && !list.length; t++) {
    try { list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() } catch {}
    if (!list.length) await sleep(200)
  }
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error(`no Edge page on CDP port ${CDP}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  sockets.push(ws)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map<number, (v: any) => void>()
  const send = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data))
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m); pending.delete(m.id) }
  }
  const ev = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
  const until = async (expression: string, tries = 60) => {
    for (let t = 0; t < tries; t++) {
      const v = await ev(expression)
      if (v) return v
      await sleep(100)
    }
    return null
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('DOM.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 800, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/parity/manager-avatar` })
  const ready = await until(`!!(window.__parity && window.__parity.ready) && document.querySelectorAll('[data-testid="manager-avatar"]').length > 0`, 400)
  if (!ready) throw new Error(`no avatars on the parity page: ${JSON.stringify(await ev('window.__parity'))}`)
  // The parity page freezes Date.now; Vue drops a click stamped no later than its listener was attached.
  await ev(`(() => { const t = Date.now(); let n = 1; Date.now = () => t + 1000 * n++; return true })()`)
  await until(`${AVATARS}.filter((a) => a.src).every((a) => a.loaded)`, 50)

  const avatars = (await ev(AVATARS)) as { label: string; src: string | null; loaded: boolean; initial: string | null; x: number; y: number; w: number; l: number; r: number; rowSelected: boolean
    rowH: number; dotR: number; titleL: number; titleMask: string; titleCut: boolean }[]
  const ada = avatars.filter((a) => a.label === 'Manager: Ada, Head of Design')
  const bo = avatars.filter((a) => a.label === 'Manager: Bo, Backend Engineer')
  const cy = avatars.filter((a) => a.label === 'Lead: Cy, Layout designer')
  check('every managed or led row draws an avatar, and the others none', avatars.length === 5 && ada.length === 2 && bo.length === 2 && cy.length === 1, avatars.map((a) => a.label))
  check("the Hydra Core lead's row shows her photo, served by the personas route", cy.every((a) => a.loaded && a.src === '/api/personas/cy-layout/avatar?v=1760000000500'), cy)
  const portrait = await fetch(`http://127.0.0.1:${PORT}/api/personas/cy-layout/avatar`)
  check('GET /api/personas/:slug/avatar answers the portrait beside the persona', portrait.ok && portrait.headers.get('content-type') === 'image/png', portrait.status)
  if (cy[0]) {
    const lead = cy[0]
    const clip = { x: 0, y: Math.max(0, lead.y - 40), width: Math.min(1300, lead.l + 300), height: 80, scale: 3 }
    const shot = Buffer.from((await send('Page.captureScreenshot', { format: 'jpeg', quality: 92, clip })).data, 'base64')
    for (const file of [join(shotDir, 'lead-face.jpg'), ...(process.env.E2E_LEAD_SHOT ? [process.env.E2E_LEAD_SHOT] : [])]) {
      writeFileSync(file, shot)
      console.log(`     screenshot ${file}`)
    }
  }
  check('Ada\'s rows show her photo, served by the managers route', ada.every((a) => a.loaded && a.src === '/api/managers/ada-design/avatar?v=1760000000000'), ada)
  check('Bo\'s rows show his initial', bo.every((a) => a.src === null && a.initial === 'B'), bo)
  check('the avatar is a 16px circle between the status dot and the title, in a 26px row',
    avatars.every((a) => Math.round(a.w) === 16 && a.l >= a.dotR - 0.5 && a.r <= a.titleL + 0.5 && Math.round(a.rowH) === 26), avatars.map((a) => [a.w, a.dotR, a.l, a.r, a.titleL, a.rowH]))
  check('a long title still fades out on the right', avatars.some((a) => a.titleCut) && avatars.every((a) => a.titleMask.includes('linear-gradient')), avatars.map((a) => [a.titleCut, a.titleMask]))
  const served = await fetch(`http://127.0.0.1:${PORT}/api/managers/ada-design/avatar`)
  check('GET /api/managers/:slug/avatar answers the photo', served.ok && served.headers.get('content-type') === 'image/png', served.status)

  // The click: move there first (the row's menus mount on its first hover and redraw the avatar), then press on it as it is now.
  const target = ada[0]!
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await sleep(300)
  const at = ((await ev(AVATARS)) as typeof avatars).find((a) => a.label === target.label)!
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  const card = (await until(CARD, 30)) as { text: string; img: boolean; button: boolean; error: string | null; l: number; t: number; r: number; b: number } | null
  check('a click on the avatar opens the manager\'s card', !!card)
  check('the card shows the photo, name, title, description and Change photo',
    !!card && card.img && card.text.includes('Ada') && card.text.includes('Head of Design') && card.text.includes('Owns how every screen') && card.button, card)
  check('the card shows the manager\'s stats line', !!(await ev(`document.querySelector('[data-testid="manager-stats"]')?.textContent.includes('41 turns')`)))
  check('the card opens just below the avatar it came from', !!card && card.t > at.y && card.t - at.y < 30 && Math.abs(card.l - (at.x - 14)) <= 10, { card, at: [at.x, at.y] })
  const after = ((await ev(AVATARS)) as typeof avatars).find((a) => a.label === target.label)
  check('the click opens the card, not the chat', after?.rowSelected === false, after)
  check('the row\'s own tooltip stays away while the card is open', !(await ev(`!!document.querySelector('[data-slot="tooltip-content"]')`)))

  if (card) {
    const rows = (await ev(`(() => { const r = document.querySelector('[data-testid="manager-avatar"]').closest('nav, aside, [data-sidebar]') ?? document.body; const b = r.getBoundingClientRect(); return { l: b.left, t: b.top } })()`)) as { l: number; t: number }
    const clip = { x: Math.max(0, rows.l), y: Math.max(0, Math.min(card.t, at.y) - 140), width: Math.min(1300, card.r + 24) - Math.max(0, rows.l), height: Math.min(800, card.b + 160) - Math.max(0, Math.min(card.t, at.y) - 140), scale: 2 }
    const img = await send('Page.captureScreenshot', { format: 'png', clip })
    const file = join(shotDir, 'card.png')
    writeFileSync(file, Buffer.from(img.data, 'base64'))
    console.log(`     screenshot ${file}`)
  }

  // Change photo: the picker gets a new PNG; the file on disk is replaced and both of Ada's rows move to its version.
  const input = await send('Runtime.evaluate', { expression: `document.querySelector('[data-testid="manager-card"] input[type="file"]')` })
  const objectId = input.result?.objectId
  check('the card has a file picker for the photo', !!objectId)
  if (objectId) {
    await send('DOM.setFileInputFiles', { files: [NEW_PHOTO], objectId })
    const moved = await until(`${AVATARS}.filter((a) => a.label === 'Manager: Ada, Head of Design').every((a) => a.src && a.src !== '/api/managers/ada-design/avatar?v=1760000000000' && a.loaded)`, 80)
    check('Change photo replaces the photo on every row of that manager', !!moved, await ev(AVATARS))
    check('the new photo is the one on disk', readdirSync(join(managers, 'ada-design')).filter((f) => f.startsWith('avatar.')).join(',') === 'avatar.png')
    const now = await fetch(`http://127.0.0.1:${PORT}/api/managers/ada-design/avatar`)
    check('the route serves the new photo', now.ok && Buffer.from(await now.arrayBuffer()).equals(await Bun.file(NEW_PHOTO).bytes().then(Buffer.from)))

    const input2 = await send('Runtime.evaluate', { expression: `document.querySelector('[data-testid="manager-card"] input[type="file"]')` })
    await send('DOM.setFileInputFiles', { files: [NOT_PNG], objectId: input2.result?.objectId })
    const refused = (await until(`document.querySelector('[data-testid="manager-card"] [role="alert"]')?.textContent`, 50)) as string | null
    check('a file the server refuses shows its sentence in the card', refused === 'A manager photo must be a PNG, JPG, WebP or GIF.', refused)
  }

  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  check('Escape closes the card', !!(await until(`!document.querySelector('[data-testid="manager-card"]')`, 30)))

  // The lead's card: her name and title, and no Change photo, since her photo is not Desk's to change.
  const leadAt = ((await ev(AVATARS)) as typeof avatars).find((a) => a.label === 'Lead: Cy, Layout designer')
  if (leadAt) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: leadAt.x, y: leadAt.y })
    await sleep(300)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: leadAt.x, y: leadAt.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: leadAt.x, y: leadAt.y, button: 'left', clickCount: 1 })
  }
  const leadCard = (await until(CARD, 30)) as { text: string; img: boolean; button: boolean } | null
  check("the lead's card names her and offers no Change photo", !!leadCard && leadCard.img && leadCard.text.includes('Cy') && leadCard.text.includes('Layout designer') && !leadCard.button, leadCard)
} catch (e) {
  failed++
  console.log(`FAIL ${(e as Error).message}`)
} finally {
  for (const s of sockets) try { s.close() } catch {}
  edge?.kill()
  server.kill()
  await Promise.all([edge?.exited, server.exited])
  try { rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {}
}
console.log(`${total - failed}/${total} passed`)
process.exit(failed || !total ? 1 : 0)
