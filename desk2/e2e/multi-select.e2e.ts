// Picking several sidebar rows end to end (bun run e2e:multi-select; Windows, Edge): Ctrl, Shift and Ctrl+Shift with a
// click pick rows in the desk list, two or more picked share one right-click menu under "N selected", a bulk Pin lands
// every picked row in Pinned, and a right-click on a row not picked, Escape or a plain click leaves the picks (README
// "Several rows at once"). The unit tests hold the picking rules and the menu (web/test/sidebar/picked.test.ts); this
// holds the wiring: the rows' click carrying its modifier keys, the picked look, the shared menu and the bulk action.
// Starts the built Desk 2 (web/dist: run `bun run build` first) as a hidden process on E2E_PORT (default a free port)
// with a throwaway HYDRA_DESK_HOME, removed when the run ends; /ah/api goes on to the live AgentHydra daemon for reads
// only: every other method under /ah is answered here, as are /dw and the pane's shared preferences, so no account or
// owner setting is touched. The Pin is Desk's own mark, kept in the throwaway home. Needs at least four outside-session
// rows on screen (this PC's sessions). Prints PASS/FAIL per check and the bulk menu's labels, never a row's text; exits
// 1 on any FAIL. The rows are held by their keyed wrappers (window.__rows), never by place: the list is live, and a
// row that left it above them shifted every place (2026-10-14: one run of two read [0,1] for a pick of [1,2]).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { portFrom } from './lib/free-port'
import { QUIET_EDGE } from './lib/edge-flags'

const DESK = resolve(import.meta.dir, '..')
const PORT = portFrom(process.env.E2E_PORT)
const CDP = portFrom(process.env.E2E_CDP_PORT)
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

if (await fetch(`http://127.0.0.1:${PORT}/api/health`).then(() => true, () => false)) throw new Error(`port ${PORT} is already in use`)
const home = mkdtempSync(join(tmpdir(), 'desk2-pick-home-'))
const profile = mkdtempSync(join(tmpdir(), 'desk2-pick-edge-'))
const server = Bun.spawn([process.execPath, 'server/src/index.ts'], {
  cwd: DESK, env: { ...process.env, HYDRA_DESK_PORT: String(PORT), HYDRA_DESK_HOME: home },
  stdout: 'ignore', stderr: 'ignore', windowsHide: true,
})
let edge: ReturnType<typeof Bun.spawn> | null = null
let ws: WebSocket | null = null
const results: boolean[] = []
const check = (ok: boolean, what: string) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
}

try {
  let up = false
  for (let t = 0; t < 60 && !up; t++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok } catch {}
    if (!up) await sleep(500)
  }
  if (!up) throw new Error(`server did not come up on ${PORT}`)
  edge = Bun.spawn([EDGE, '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    '--no-first-run', ...QUIET_EDGE, '--window-size=1500,950', 'about:blank'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
  let list: { type: string; webSocketDebuggerUrl: string }[] = []
  for (let t = 0; t < 50 && !list.length; t++) {
    try { list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() } catch {}
    if (!list.length) await sleep(200)
  }
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error(`no Edge page on CDP port ${CDP}`)
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  ws = socket
  await new Promise((r) => (socket.onopen = r))
  let id = 0
  const pending = new Map<number, (v: any) => void>()
  const send = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); socket.send(JSON.stringify({ id: i, method, params })) })
  socket.onmessage = (e) => {
    const m = JSON.parse(String(e.data))
    if (m.method === 'Fetch.requestPaused') {
      const { requestId, request } = m.params
      const path = new URL(request.url).pathname
      const answered = path.startsWith('/dw/') || path === '/ah/api/ui-prefs' || (path.startsWith('/ah/') && request.method !== 'GET')
      if (!answered) void send('Fetch.continueRequest', { requestId })
      else void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: btoa(JSON.stringify(path === '/ah/api/ui-prefs' ? { prefs: {} } : {})) })
      return
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m); pending.delete(m.id) }
  }
  const ev = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
  const until = async (expression: string, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await ev(expression)) return true
    return false
  }
  await send('Page.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: `http://127.0.0.1:${PORT}/dw/*` }, { urlPattern: `http://127.0.0.1:${PORT}/ah/*` }] })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })

  // The desk list's outside-session rows on screen, outside Pinned, top to bottom.
  const ROWS = `[...document.querySelectorAll('section:not([aria-label="Pinned"]) [role="button"][aria-description^="Runs in"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.height > 10 && r.top > 0 && r.bottom < innerHeight })`
  const PINNED = `document.querySelectorAll('section[aria-label="Pinned"] [role="button"][aria-description^="Runs in"]').length`
  const MENU_OPEN = `document.querySelectorAll('[role="menu"]').length > 0`
  if (!(await until(`${ROWS}.length >= 4`, 30_000))) throw new Error('fewer than 4 outside-session rows on screen')
  // Rows are replaced as the lists arrive after mount; let them settle, then hold the rows on screen by their keyed
  // wrappers (the row inside is swapped as its menu mounts on the first hover). ROW(i) is the row in wrapper i now.
  await sleep(2500)
  const capture = () => ev(`(window.__rows = ${ROWS}.map((el) => el.closest('[draggable]'))).length`)
  const ROW = (i: number | string) => `(window.__rows[${i}]?.isConnected ? window.__rows[${i}].querySelector('[role="button"][aria-description^="Runs in"]') : null)`
  await capture()
  const at = async (i: number) => {
    const p = (await ev(`(() => { const el = ${ROW(i)}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 } })()`)) as { x: number; y: number } | null
    if (!p) throw new Error(`row ${i} left the list during the run`)
    return p
  }
  const click = async (i: number, button: 'left' | 'right', modifiers = 0) => {
    const p = await at(i)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, modifiers })
    await sleep(80)
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button, buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0, clickCount: 1, modifiers })
    await sleep(250)
  }
  const escape = async () => {
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(200)
  }
  const picked = async () => JSON.stringify(await ev(`window.__rows.map((_, i) => (${ROW('i')}?.getAttribute('aria-pressed') === 'true' ? i : -1)).filter((i) => i >= 0)`))
  const nonePicked = async () => (await ev(`document.querySelectorAll('[role="button"][aria-pressed="true"]').length`)) === 0
  // The open menu's own lines (submenus are not opened): its items, its text lines and its rules.
  const menuLines = async () =>
    (await ev(`[...document.querySelectorAll('[role="menu"] > [role^="menuitem"], [role="menu"] > [role="none"], [role="menu"] > [role="separator"]')].map((e) => (e.getAttribute('role') === 'separator' ? '-' : e.textContent.trim().replace(/\\s+/g, ' ')))`)) as string[]
  const CTRL = 2
  const SHIFT = 8

  await click(1, 'left', CTRL)
  await click(2, 'left', CTRL)
  check((await picked()) === '[1,2]', `Ctrl and a click on two rows picks both: ${await picked()}`)

  await click(1, 'right')
  await until(MENU_OPEN, 3000)
  const lines = await menuLines()
  console.log(`  the shared menu: ${JSON.stringify(lines)}`)
  check(lines[0] === '2 selected' && lines.some((l) => l.startsWith('Pin')), 'a right-click on a picked row opens the shared menu under "2 selected"')
  await escape()

  await click(3, 'left', SHIFT)
  check((await picked()) === '[2,3]', `Shift and a click picks the run from the last row clicked: ${await picked()}`)
  await click(0, 'left', CTRL | SHIFT)
  check((await picked()) === '[0,1,2,3]', `Ctrl+Shift and a click adds the run: ${await picked()}`)

  if (((await ev(`window.__rows.length`)) as number) > 4) {
    await click(4, 'right')
    await until(MENU_OPEN, 3000)
    const own = await menuLines()
    check(own.length > 0 && own[0] !== '' && !/ selected$/.test(own[0]) && (await nonePicked()), 'a right-click on a row not picked opens its own menu and leaves the picks')
    await escape()
  }

  const pinnedBefore = (await ev(PINNED)) as number
  await click(0, 'left')
  await click(1, 'left', SHIFT)
  check((await picked()) === '[0,1]', `a click, then Shift and a click, picks the two rows: ${await picked()}`)
  await click(1, 'right')
  await until(MENU_OPEN, 3000)
  // Pin is the item whose letter is P (its text runs on into the letter: "PinP").
  await ev(`document.querySelector('[role="menu"] [role="menuitem"][data-shortcut="P"]')?.click()`)
  check(await until(`${PINNED} === ${pinnedBefore + 2}`, 5000), 'Pin on the shared menu moves both picked rows into Pinned')
  // The two pinned rows left this list for Pinned: hold the rows on screen now.
  await sleep(500)
  await capture()

  await click(0, 'left', CTRL)
  await click(1, 'left', CTRL)
  await escape()
  check(await nonePicked(), 'Escape leaves the picks')
  await click(0, 'left', CTRL)
  await click(1, 'left')
  check((await nonePicked()) && (await ev(`${ROW(1)}?.getAttribute('aria-current')`)) === 'page', 'a plain click leaves the picks and opens the row')
} catch (err) {
  check(false, `the run stopped: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  ws?.close()
  edge?.kill()
  server.kill()
  await Promise.all([edge?.exited, server.exited].filter(Boolean))
  await sleep(300)
  for (const dir of [home, profile]) if (dir && dir.startsWith(tmpdir())) try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
const failed = results.filter((ok) => !ok).length
console.log(`${results.length - failed} of ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
