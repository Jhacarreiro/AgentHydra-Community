// The session rail takes the pointer where it should, headless, on the parity page (`bun run e2e:rail`, after `bun run build`).
// 2026-10-14: the Background tasks panel inside the rail ignored every click (its back arrow, Expand, Clear finished, Close),
// twice over: the rail lets clicks through to the chat under it and only the cards took them back; and the panel's
// scrollIntoView of its chosen task scrolled the rail's overflow-hidden box 299px sideways, so the panel sat under the chat.
// el.click() ignores pointer-events, so every click here is a real mouse event at the control's centre.
// On a Desk chat with a running task: every control on the cards and on the panel is what a click at its centre hits, and so are
// the transcript's step arrows beside the rail on a wide window; hovering a
// running task shows its Stop; a click on the task slides the panel in, its back arrow slides the cards back, Expand gives the
// panel the chat's place and Restore gives it back, and Close shuts the rail. On an outside session: its facts are rows (no chips)
// and every control on its cards is hit, and its Context card starts with its tokens in context.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { portFrom } from './lib/free-port'
import { QUIET_EDGE } from './lib/edge-flags'

const DESK = resolve(import.meta.dir, '..')
const PORT = portFrom(process.env.E2E_PORT)
const CDP = portFrom(process.env.E2E_CDP_PORT)
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Longer than the rail's slide (--dur-slow) and the panel's lazy load.
const SETTLE = 900

const SCRATCH = mkdtempSync(join(tmpdir(), 'desk2-rail-'))
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

// In the page: the rail's visible, enabled controls outside an inert part, each with whether a click at its centre reaches it.
const HITS = `(() => {
  const aside = document.querySelector('aside[aria-label="Session details"]')
  if (!aside) return null
  return [...aside.querySelectorAll('button')].filter((b) => {
    const r = b.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && !b.disabled && !b.closest('[inert]') && getComputedStyle(b).visibility !== 'hidden'
  }).map((b) => {
    const r = b.getBoundingClientRect()
    const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    const hit = !!t && (t === b || b.contains(t))
    const by = hit ? '' : t ? t.tagName + '.' + String(t.className).slice(0, 60) : 'nothing (x ' + Math.round(r.left + r.width / 2) + ' of ' + innerWidth + ')'
    return { name: b.getAttribute('aria-label') || b.textContent.trim().slice(0, 40), hit, by }
  })
})()`
// Resolves once the rail's slide (and anything else with an end) has finished, or after 3 s with what is still running.
const SETTLED = `(async () => {
  const left = () => document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.getTiming().iterations !== Infinity)
  // floor-ok: a cancelled animation rejects finished, which only means it ended; what still runs after 3 s is returned and printed
  await Promise.race([Promise.all(left().map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 3000))])
  return left().map((a) => (a.transitionProperty || a.animationName) + ' at ' + Math.round(Number(a.currentTime)))
})()`
const centre = (label: string, exact = true) => `(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (${exact} ? x.getAttribute('aria-label') === ${JSON.stringify(label)} : (x.getAttribute('aria-label') || '').endsWith(${JSON.stringify(label)})) && !x.closest('[inert]') && x.getBoundingClientRect().width > 0)
  if (!b) return null
  const r = b.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, name: b.getAttribute('aria-label') }
})()`

try {
  let up = false
  for (let t = 0; t < 60 && !up; t++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok } catch {} // floor-ok: not up yet, asked again
    if (!up) await sleep(500)
  }
  if (!up) throw new Error(`server did not come up on ${PORT}`)
  edge = Bun.spawn([EDGE, '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    '--no-first-run', ...QUIET_EDGE, '--window-size=1500,950', 'about:blank'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })

  const move = (x: number, y: number) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  /** A real click at the centre of the control so named; false when there is none. */
  async function click(label: string, exact = true): Promise<boolean> {
    const at = (await ev(centre(label, exact))) as { x: number; y: number } | null
    if (!at) return false
    await move(at.x, at.y)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await sleep(100)
    const still = (await ev(SETTLED)) as string[]
    if (still.length) console.log(`  after ${label}, still animating: ${still.join(', ')}`)
    await sleep(SETTLE)
    return true
  }
  async function allHit(what: string) {
    const hits = (await ev(HITS)) as { name: string; hit: boolean; by: string }[] | null
    if (!hits) return result(false, what, 'no rail on screen')
    const missed = hits.filter((h) => !h.hit).map((h) => `${h.name} (by ${h.by})`)
    result(hits.length > 0 && !missed.length, `${what}: ${hits.length} controls take a click`, missed.length ? `missed: ${missed.join(', ')}` : 'no controls')
  }
  async function open(scene: string) {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?rail=${scene}#/parity/${scene}` })
    let ready = false
    for (let t = 0; t < 300 && !ready; t++) {
      await sleep(150)
      ready = !!(await ev(`!!(window.__parity && window.__parity.ready) && location.href.includes('rail=${scene}')`))
    }
    if (!ready) throw new Error(`${scene}: the parity page did not get ready`)
    await sleep(SETTLE)
    if (!(await ev(`!!document.querySelector('aside[aria-label="Session details"]')`))) await click('Show session details')
  }
  /** At each window width, the px between the text column's right edge and the step arrows (at least 12 is a clear lane). */
  async function laneClear(what: string, widths: number[]) {
    const gaps: string[] = []
    let ok = true
    for (const width of widths) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
      await sleep(SETTLE)
      const gap = (await ev(`(() => {
        const up = document.querySelector('button[aria-label="Previous message you sent"]')
        const col = document.querySelector('[data-transcript-scroller] > div')
        if (!up || !col) return null
        const c = col.getBoundingClientRect()
        return Math.round(up.getBoundingClientRect().left - (c.right - parseFloat(getComputedStyle(col).paddingRight)))
      })()`)) as number | null
      gaps.push(`${width}: ${gap ?? 'no arrows'}`)
      if (gap === null || gap < 11) ok = false
    }
    result(ok, `${what}, the step arrows stay 12px clear of the text at every width`, gaps.join(', '))
  }
  const panelOpen = () => ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Back to session details'); return !!b && !b.closest('[inert]') })()`)

  // A Desk chat with a running CliMayte task.
  await open('background-tasks')
  if (await panelOpen()) await click('Back to session details')
  result(!(await panelOpen()), 'the back arrow slides the cards back')
  await allHit('the cards')
  // On a wide window the rail lies over the chat's empty margin, where the transcript's step arrows sit (owner, 2026-10-14: it
  // "hides the peek and previous message buttons"): each must still be what a click at its centre hits.
  await send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(SETTLE)
  const steps = (await ev(`['Previous message you sent', 'Peek at the previous message you sent'].map((l) => {
    const b = document.querySelector('button[aria-label="' + l + '"]')
    if (!b) return l + ': none'
    const r = b.getBoundingClientRect()
    const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return t === b || b.contains(t) ? '' : l + ': under ' + (t && t.closest('aside') ? t.closest('aside').getAttribute('aria-label') : t ? t.tagName : 'nothing')
  }).filter(Boolean)`)) as string[]
  result(!steps.length, 'on a wide window the step arrows take a click beside the open rail', steps.join(', '))
  // The step arrows keep a lane of their own beside the text at every width (owner, 2026-10-14: "issue with the ... gap
  // around the peek/previous chat thingy"; they sat over the column's last 28px, on a right-hand message's picture).
  await laneClear('beside the open rail', [2400, 1500, 1200, 1000])
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(SETTLE)
  const task = ', show it in Background tasks'
  const row = (await ev(centre(task, false))) as { x: number; y: number; name: string } | null
  if (!row) result(false, 'a running task on the Background tasks card')
  else {
    await move(row.x, row.y)
    await sleep(200)
    const stop = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(`Stop ${row.name.slice(0, -task.length)}`)}); if (!b) return 'none'; const r = b.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.width > 0 && (t === b || b.contains(t)) ? 'shown' : 'hidden' })()`)
    result(stop === 'shown', 'hovering a running task shows its Stop', `Stop is ${stop}`)
    await click(task, false)
    result(!!(await panelOpen()), 'a click on the task slides the panel in')
    await allHit('the Background tasks panel')
    await click('Back to session details')
    result(!(await panelOpen()), "the panel's back arrow slides the cards back")
    await click(task, false)
    await click('Expand')
    result(!!(await ev(centre('Restore'))), 'Expand gives the panel the chat\'s place')
    await click('Restore')
    result(!!(await panelOpen()), 'Restore puts the panel back in the rail')
    await click('Close')
    result(!(await ev(`!!document.querySelector('aside[aria-label="Session details"]')`)), 'Close shuts the rail')
    await laneClear('with the rail shut', [1500, 1000, 820, 700])
    await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(SETTLE)
  }

  // An outside session: its facts are rows in the cards.
  await open('external-session')
  // The scene's folder and model (its source and account need AgentHydra's session row, which this server has none of).
  const rows = (await ev(`[...document.querySelectorAll('[data-rail-card="environment"] li')].map((li) => !!li.querySelector('svg') && li.getBoundingClientRect().height <= 28)`)) as boolean[]
  result(rows.length >= 2 && rows.every(Boolean), `the Environment card's facts are rows, each with its icon (${rows.length})`)
  // The scene's index says 84,300 tokens, as a session file's last reply would (bridge lastContextTokens).
  const ctx = (await ev(`(() => { const r = document.querySelector('[data-rail-card="context"] [data-testid="rail-context-tokens"]'); return r ? { text: r.textContent.trim(), icon: !!r.querySelector('svg') } : null })()`)) as { text: string; icon: boolean } | null
  result(!!ctx && ctx.icon && /^84\.3K tokens in context$/i.test(ctx.text), "the Context card's first row is the session's tokens in context, with its icon", JSON.stringify(ctx))
  // How often each tool and each connector was called (owner, 2026-10-14: "show how many times each was accessed"), the most first.
  const calls = (await ev(`({
    tools: [...document.querySelectorAll('[data-rail-card="tools"] [data-testid="rail-tool"]')].map((r) => Number(r.lastElementChild.textContent.trim())),
    connectors: [...document.querySelectorAll('[data-rail-card="connectors"] [data-testid="rail-connector-calls"]')].map((r) => Number(r.textContent.trim()))
  })`)) as { tools: number[]; connectors: number[] }
  const ranked = (ns: number[]) => ns.length > 0 && ns.every((n, i) => n > 0 && (i === 0 || n <= ns[i - 1]!))
  result(ranked(calls.tools) && ranked(calls.connectors), "the Tools and Connectors cards give each one's calls, the most first", JSON.stringify(calls))
  await allHit("an outside session's cards")
  // Find sits in the title bar beside Session details, not on the Environment card (owner, 2026-10-14: "move the search
  // here"), and opens the Find bar with the rail shut too.
  const place = (await ev(`(() => {
    const f = document.querySelector('button[aria-label="Find in session"]')
    const r = document.querySelector('button[aria-label="Hide session details"], button[aria-label="Show session details"]')
    if (!f || !r) return null
    const a = f.getBoundingClientRect()
    const b = r.getBoundingClientRect()
    return { inRail: !!f.closest('aside'), beside: Math.abs(a.top - b.top) < 4 && b.left - a.right >= 0 && b.left - a.right < 16 }
  })()`)) as { inRail: boolean; beside: boolean } | null
  result(!!place && !place.inRail && place.beside, 'Find sits in the title bar beside Session details', JSON.stringify(place))
  await click('Hide session details')
  await click('Find in session')
  result(!!(await ev(`!!document.querySelector('input[aria-label="Find in this session"]')`)), 'with the rail shut, Find opens the Find bar')
} finally {
  for (const s of sockets) s.close()
  edge?.kill()
  server.kill()
  await Promise.all([edge?.exited, server.exited])
  try { rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {} // floor-ok: a temp folder Edge still holds
}
console.log(`${total - failed} of ${total} rail checks pass`)
process.exit(failed || !total ? 1 : 0)
