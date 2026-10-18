// An open menu closes when the click lands in another document, headless (`bun e2e/frame-click.e2e.ts`, after
// `bun run build`). 2026-10-14: the sidebar's account menu stayed open over AgentHydra's pane, a frame whose clicks
// never reach Desk's document (owner: "this menu does not close, if I click outside of it, it should").
// Desk's side (web/src/lib/frame-dismiss.ts): the account menu closes on a click on the chat, on the sidebar, and into a
// frame. AgentHydra's side (hydra/src/lib/desk-embed.ts): a menu open in its page, framed in Desk, closes on a click on
// Desk. The throwaway Desk's AgentHydra address is a closed port, so its page reads nothing from the real one.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { QUIET_EDGE } from './lib/edge-flags'
import { portFrom } from './lib/free-port'

const DESK = resolve(import.meta.dir, '..')
const PORT = portFrom(process.env.E2E_PORT)
const CDP = portFrom(process.env.E2E_CDP_PORT)
const DEAD = portFrom(undefined)
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const SCRATCH = mkdtempSync(join(tmpdir(), 'desk2-frame-click-'))
const home = join(SCRATCH, 'home')
const profile = join(SCRATCH, 'edge')
mkdirSync(home)
mkdirSync(profile)
const server = Bun.spawn([process.execPath, 'server/src/index.ts'], {
  cwd: DESK,
  env: { ...process.env, HYDRA_DESK_PORT: String(PORT), HYDRA_DESK_HOME: home, HYDRA_URL: `http://127.0.0.1:${DEAD}` },
  stdout: 'ignore', stderr: 'ignore', windowsHide: true,
})
let edge: ReturnType<typeof Bun.spawn> | null = null
const sockets: WebSocket[] = []
let failed = 0
let total = 0
const result = (ok: boolean, what: string, why = '') => {
  total++
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok || !why ? '' : ` :: ${why}`}`)
}

try {
  let up = false
  for (let t = 0; t < 60 && !up; t++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok } catch {} // floor-ok: not up yet, asked again
    if (!up) await sleep(500)
  }
  if (!up) throw new Error(`server did not come up on ${PORT}`)
  edge = Bun.spawn([EDGE, '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    '--no-first-run', ...QUIET_EDGE, '--window-size=1400,900', 'about:blank'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
  let list: { type: string; webSocketDebuggerUrl: string }[] = []
  for (let t = 0; t < 50 && !list.length; t++) {
    try { list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() } catch {} // floor-ok: Edge not listening yet, asked again
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
  const click = async (x: number, y: number) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const centre = (doc: string, sel: string, dx = 0, dy = 0) =>
    ev(`(() => { const e = ${doc}.querySelector(${JSON.stringify(sel)}); const r = e?.getBoundingClientRect(); return r && r.width ? { x: ${dx} + r.x + r.width / 2, y: ${dy} + r.y + r.height / 2 } : null })()`)
  await send('Page.enable')
  await send('Runtime.enable')

  const scene = 'background-tasks'
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?s=${scene}#/parity/${scene}` })
  let ready = false
  for (let t = 0; t < 300 && !ready; t++) {
    await sleep(150)
    ready = !!(await ev(`!!(window.__parity && window.__parity.ready)`))
  }
  if (!ready) throw new Error(`${scene}: the parity page did not get ready`)
  await sleep(900)
  // The parity page freezes Date.now; Vue drops a click stamped no later than its listener (desk2/AGENTS.md).
  await ev(`(() => { const f = Date.now(); let n = 0; Date.now = () => f + 1000 + n++ })()`)
  // AgentHydra's page in a frame over the chat's right half, as Desk's pane holds it.
  await ev(`(() => { const f = document.createElement('iframe'); f.id = 'ah-frame'; f.src = '/ah/?embed=desk'; Object.assign(f.style, { position: 'fixed', left: '760px', top: '120px', width: '620px', height: '700px', zIndex: '10', border: '0' }); document.body.appendChild(f) })()`)

  // Desk's side.
  const DESK_MENU = `!!document.querySelector('[data-slot="popover-content"]')`
  const trigger = await centre('document', '[aria-label^="Account for new chats:"]')
  if (!trigger) throw new Error('no account menu button in the sidebar')
  let frameUp = false
  for (let t = 0; t < 60 && !frameUp; t++) {
    await sleep(250)
    frameUp = !!(await ev(`document.getElementById('ah-frame')?.contentDocument?.querySelector('#app')?.children.length > 0`))
  }
  for (const [where, x, y] of [['on the chat', 400, 300], ['on the sidebar', 100, 120], ['into the AgentHydra frame', 1000, 450]] as const) {
    await click(trigger.x, trigger.y)
    await sleep(400)
    const opened = await ev(DESK_MENU)
    await click(x, y)
    await sleep(500)
    const still = await ev(DESK_MENU)
    result(opened && !still, `the account menu closes on a click ${where}`, opened ? 'it stayed open' : 'it never opened')
    if (still) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300) }
  }

  // AgentHydra's side: a menu open in its page closes on a click on Desk.
  const FRAME = `document.getElementById('ah-frame').contentDocument`
  const AH_MENU = `!!${FRAME}.querySelector('[role="menu"], [data-slot="popover-content"], [data-slot="dropdown-menu-content"]')`
  const ahTrigger = frameUp ? await centre(FRAME, '[aria-haspopup="menu"]', 760, 120) : null
  if (!ahTrigger) result(false, "a menu in AgentHydra's page closes on a click on Desk", frameUp ? 'no menu button in its page' : 'its page did not load')
  else {
    await click(ahTrigger.x, ahTrigger.y)
    await sleep(500)
    const opened = await ev(AH_MENU)
    await click(400, 300)
    await sleep(500)
    const still = await ev(AH_MENU)
    result(opened && !still, "a menu in AgentHydra's page closes on a click on Desk", opened ? 'it stayed open' : 'it never opened')
  }
} finally {
  for (const s of sockets) s.close()
  edge?.kill()
  server.kill()
  await Promise.all([edge?.exited, server.exited])
  try { rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {} // floor-ok: a temp folder Edge still holds
}
console.log(`${total - failed} of ${total} frame-click checks pass`)
process.exit(failed ? 1 : 0)
