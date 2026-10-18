// An outside chat at work keeps its composer and shows its working line where a chat here does, headless, on the parity
// page (`bun e2e/outside-composer.e2e.ts`, after `bun run build`). 2026-10-14: a Codex chat working in Codex showed a
// status line where the composer goes, and the composer came and went at each turn's edge (owner: "Codex should be
// exactly the same ... There should be input boxes"). For a Claude Desktop chat and a Codex chat, both at work: the
// composer's box is on screen and takes typing, the working line is the transcript's last row (inside the scroller,
// above the composer), and no second status line sits between them.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { portFrom } from './lib/free-port'
import { QUIET_EDGE } from './lib/edge-flags'

const DESK = resolve(import.meta.dir, '..')
const PORT = portFrom(process.env.E2E_PORT)
const CDP = portFrom(process.env.E2E_CDP_PORT)
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const SHOTS = process.env.E2E_SHOTS || null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const SCRATCH = mkdtempSync(join(tmpdir(), 'desk2-outside-'))
const home = join(SCRATCH, 'home')
const profile = join(SCRATCH, 'edge')
mkdirSync(home)
mkdirSync(profile)
const server = Bun.spawn([process.execPath, 'server/src/index.ts'], {
  cwd: DESK, env: { ...process.env, HYDRA_DESK_PORT: String(PORT), HYDRA_DESK_HOME: home },
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

// In the page: where the composer's box and the working line are, and what sits between them.
const LAYOUT = `(() => {
  const box = document.querySelector('textarea')
  const status = [...document.querySelectorAll('[role="status"]')].filter((s) => s.getBoundingClientRect().height > 0)
  // The working line (WorkingFooter): the feed's last live status row.
  const working = [...document.querySelectorAll('[role="feed"] [role="status"][aria-live="polite"]')].filter((s) => s.getBoundingClientRect().height > 0).at(-1)
  const b = box?.getBoundingClientRect()
  const w = working?.getBoundingClientRect()
  return {
    box: b ? { top: Math.round(b.top), h: Math.round(b.height), shown: b.width > 0 && b.height > 0 && b.bottom <= innerHeight } : null,
    working: w ? { text: (working.textContent || '').trim().slice(0, 60), bottom: Math.round(w.bottom), inTranscript: !!working.closest('[role="feed"]') } : null,
    between: b && w ? status.filter((s) => { const r = s.getBoundingClientRect(); return r.top >= w.bottom && r.bottom <= b.top && /Working in|Running in/.test(s.textContent || '') }).length : -1
  }
})()`

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
  await send('Page.enable')
  await send('Runtime.enable')

  for (const [scene, what] of [['external-session', 'a Claude Desktop chat at work'], ['external-codex', 'a Codex chat at work']] as const) {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?s=${scene}#/parity/${scene}` })
    let ready = false
    for (let t = 0; t < 300 && !ready; t++) {
      await sleep(150)
      ready = !!(await ev(`!!(window.__parity && window.__parity.ready) && location.href.includes('s=${scene}')`))
    }
    if (!ready) throw new Error(`${scene}: the parity page did not get ready`)
    await sleep(900)
    const err = await ev(`window.__parity.error || null`)
    if (err) throw new Error(`${scene}: ${err}`)
    const l = (await ev(LAYOUT)) as { box: { top: number; h: number; shown: boolean } | null; working: { text: string; bottom: number; inTranscript: boolean } | null; between: number }
    result(!!l.box?.shown, `${what}: the composer's box is on screen`, JSON.stringify(l.box))
    result(!!l.working?.inTranscript && !!l.box && l.working.bottom <= l.box.top, `${what}: the working line is the transcript's last row, above the box`, JSON.stringify(l.working))
    result(l.between === 0, `${what}: no second status line between the transcript and the box`, String(l.between))
    // It takes typing, as a chat here does.
    const typed = await ev(`(() => { const t = document.querySelector('textarea'); if (!t) return null; t.focus(); document.execCommand('insertText', false, 'next step'); return t.value })()`)
    result(typed === 'next step', `${what}: the box takes typing`, String(typed))
    if (SHOTS) {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(SHOTS, `${scene}.png`), Buffer.from(shot.data, 'base64'))
    }
  }
} finally {
  for (const s of sockets) s.close()
  edge?.kill()
  server.kill()
  await Promise.all([edge?.exited, server.exited])
  try { rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {} // floor-ok: a temp folder Edge still holds
}
console.log(`${total - failed} of ${total} outside-composer checks pass`)
process.exit(failed || !total ? 1 : 0)
