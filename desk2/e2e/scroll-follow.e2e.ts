// Scroll-follow end to end (bun run e2e:scroll; Windows, Edge): the transcript follows a streaming reply only while
// the owner is at the bottom. Drives web `#/stream-bench` (the transcript alone, one assistant reply growing a chunk at a time) in
// headless Edge through CDP, and checks: a reply growing under someone reading higher up never moves them (touchpad-sized wheel
// steps, a scrollbar drag, a keyboard Page Up, each WHILE it streams); the down arrow at the top right takes them back down; a
// send (the composer's chat-sent event) takes them down; at the bottom it follows; the up arrow steps back through the messages
// they sent, each landing on the line under the top.
// Starts the web Vite dev server hidden on E2E_PORT (default a free port) and stops it afterwards. Prints PASS/FAIL per case; exits 1 on
// any FAIL.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { portFrom } from './lib/free-port'
import { QUIET_EDGE } from './lib/edge-flags'

const DESK = resolve(import.meta.dir, '..')
const PORT = portFrom(process.env.E2E_PORT)
const CDP = portFrom(process.env.E2E_CDP_PORT)
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const answers = (url: string) => fetch(url).then((r) => r.ok, () => false)

if (await answers(BASE)) throw new Error(`port ${PORT} is already in use`)
// Vite itself, not `bun run dev`: killing a `bun run` on Windows leaves its Vite child serving the port.
const vite = Bun.spawn([process.execPath, 'node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: join(DESK, 'web'), stdout: 'ignore', stderr: 'ignore', windowsHide: true,
})
let edge: ReturnType<typeof Bun.spawn> | null = null
const lines: { ok: boolean; line: string }[] = []
const profile = mkdtempSync(join(tmpdir(), 'desk2-scroll-edge-'))
const sockets: WebSocket[] = []

try {
  let up = false
  for (let t = 0; t < 120 && !up; t++) if (!(up = await answers(BASE))) await sleep(500)
  if (!up) throw new Error(`the Vite dev server did not answer on ${PORT}`)
  edge = Bun.spawn([EDGE, '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    '--no-first-run', ...QUIET_EDGE, '--window-size=1000,600', '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', 'about:blank'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
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
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m); pending.delete(m.id) } }
  const send = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
  await send('Page.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  const FRAME = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'
  const SC = `document.querySelector('[data-transcript-scroller]')`
  /** n more chunks, a frame apart: each grows the last row, as an item.delta does, and past a reply's end new rows start. */
  const push = (n = 1) => ev(`(async () => { for (let i = 0; i < ${n}; i++) { await window.__streamBench.grow(); await ${FRAME} } })()`)
  const frame = () => ev(FRAME)
  type Box = { left: number; right: number; bottom: number; top: number }
  type State = { top: number; distance: number; client: number; up: Box | null; down: Box | null; peek: Box | null; view: { top: number; right: number; bottom: number } }
  // The step arrows at the top right: up is "Previous message you sent", down is "Next message you sent" or, past the last, "Back to the latest";
  // the peek's eye is between them.
  const state = async (): Promise<State> => ev(`(() => { const el = ${SC}; const r = el.getBoundingClientRect();
    const box = (sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b && b.width ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom } : null };
    return { top: el.scrollTop, distance: el.scrollHeight - el.scrollTop - el.clientHeight, client: el.clientHeight,
      up: box('[aria-label="Previous message you sent"]'), down: box('[aria-label="Next message you sent"],[aria-label="Back to the latest"]'),
      peek: box('[data-testid="peek-step"]'), view: { top: r.top, right: r.right, bottom: r.bottom } } })()`)
  const check = (ok: boolean, line: string) => lines.push({ ok, line: `${ok ? 'PASS' : 'FAIL'} ${line}` })
  /** A real click (move, press, release) in the middle of a box. */
  async function click(box: Box): Promise<void> {
    const x = (box.left + box.right) / 2
    const y = (box.top + box.bottom) / 2
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  /** A fresh page with the reply streamed until the transcript is several screens tall, sitting at its bottom. */
  async function load(): Promise<void> {
    await ev('window.__previous = 1')
    // A query that changes every time: the same URL with only its #/ part would not load the page again.
    await send('Page.navigate', { url: `${BASE}/?load=${Date.now()}#/stream-bench` })
    let ready = false
    for (let t = 0; t < 100 && !(ready = await ev(`!window.__previous && !!window.__streamBench?.ready && !!${SC}`)); t++) await sleep(100)
    if (!ready) throw new Error('the stream bench did not load')
    for (let t = 0; t < 400; t++) {
      const s = await state()
      if (s.top + s.distance > s.client * 4) break
      await push(5)
    }
    await frame()
  }
  const wheel = (deltaY: number) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 300, deltaX: 0, deltaY })

  // 1. A touchpad: small wheel steps up, the reply growing between them. They stay up.
  await load()
  for (let i = 0; i < 12; i++) {
    await wheel(-8)
    await push(1)
  }
  await sleep(300)
  let a = await state()
  await push(15)
  await sleep(200)
  let b = await state()
  check(a.distance > 40 && Math.abs(b.top - a.top) < 2, `touchpad steps up while it streams stay up (distance ${Math.round(a.distance)}, top ${Math.round(a.top)} -> ${Math.round(b.top)})`)

  // 2. A scrollbar drag: no wheel event, the scroll lands in the same frame as a chunk. They stay up.
  await load()
  await ev(`(async () => { const el = ${SC}; el.scrollTop -= 400; await window.__streamBench.grow(); await ${FRAME} })()`)
  await sleep(200)
  a = await state()
  await push(15)
  await sleep(200)
  b = await state()
  check(a.distance > 300 && Math.abs(b.top - a.top) < 2, `a scrollbar drag up while it streams stays up (distance ${Math.round(a.distance)}, top ${Math.round(a.top)} -> ${Math.round(b.top)})`)

  // 3. Page Up on the keyboard while it streams. They stay up.
  await load()
  await ev(`(() => { const el = ${SC}; el.tabIndex = -1; el.focus() })()`)
  for (let i = 0; i < 2; i++) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 })
    await push(3)
  }
  await sleep(400)
  a = await state()
  await push(15)
  await sleep(200)
  b = await state()
  check(a.distance > 200 && Math.abs(b.top - a.top) < 2, `Page Up while it streams stays up (distance ${Math.round(a.distance)}, top ${Math.round(a.top)} -> ${Math.round(b.top)})`)

  // 4. Well up: the reply grows and they do not move; the down arrow sits at the top right (the bottom-right jump button
  // is gone, owner 2026-10-10: "just have ... the ones on the top right be the ones that do it").
  await load()
  await wheel(-800)
  await sleep(400)
  a = await state()
  await push(20)
  await sleep(300)
  b = await state()
  check(Math.abs(b.top - a.top) < 2, `well up, 20 more chunks do not move them (top ${Math.round(a.top)} -> ${Math.round(b.top)})`)
  const down = b.down
  check(!!down && b.view.right - down.right < 48 && down.top - b.view.top < 80,
    `the down arrow shows at the top right (${down ? `right gap ${Math.round(b.view.right - down.right)}, top gap ${Math.round(down.top - b.view.top)}` : 'not shown'})`)

  // 5. The down arrow, clicked until it goes, ends at the bottom (its last step), and the reply is followed from there.
  for (let i = 0; i < 12; i++) {
    const s = await state()
    if (!s.down) break
    await click(s.down)
    await sleep(700)
  }
  a = await state()
  await push(10)
  await sleep(300)
  b = await state()
  check(a.distance < 2 && b.distance < 2, `the down arrow goes to the bottom and it follows from there (distance ${Math.round(a.distance)}, then ${Math.round(b.distance)})`)
  check(!b.down, 'the down arrow hides at the bottom')
  // The peek right under the up arrow there (owner, 2026-10-10, pointing under it: "I thought there was supposed to be
  // one here"): in the down arrow's slot's place it stood a whole slot lower with nothing between.
  const gap = b.up && b.peek ? b.peek.top - b.up.bottom : null
  check(gap !== null && gap >= 0 && gap <= 8 && Math.abs(b.peek!.left - b.up!.left) < 1,
    `at the bottom the peek sits right under the up arrow (gap ${gap === null ? 'none shown' : Math.round(gap)})`)

  // 7. A send in this chat takes them to the bottom from well up; one for another chat does not.
  await wheel(-800)
  await sleep(400)
  await ev(`window.dispatchEvent(new CustomEvent('hydra-desk:chat-sent', { detail: { chatId: 'some-other-chat', sessionId: null } }))`)
  await sleep(300)
  a = await state()
  await ev(`window.dispatchEvent(new CustomEvent('hydra-desk:chat-sent', { detail: { chatId: 'stream-bench', sessionId: null } }))`)
  await sleep(500)
  b = await state()
  check(a.distance > 300 && b.distance < 2, `a send here goes to the bottom, another chat's does not (other ${Math.round(a.distance)}, here ${Math.round(b.distance)})`)

  // 8. At the bottom it follows the reply.
  await push(10)
  await sleep(300)
  b = await state()
  check(b.distance < 2, `at the bottom it follows the reply (distance ${Math.round(b.distance)})`)

  // 9. A chat mounts with rows of varied height (replies of 200 to 3,200 characters, tool runs): it ends at its newest message.
  const SAMPLE = `window.__streamBench.sample(40, 1000)`
  await load()
  await ev(`window.__streamBench.mount('chat-a', ${SAMPLE})`)
  await sleep(1000)
  a = await state()
  check(a.distance <= 2, `a chat mounted with varied rows ends at its bottom after 1 s (distance ${Math.round(a.distance)})`)
  await sleep(2000)
  a = await state()
  check(a.distance <= 2, `a chat mounted with varied rows ends at its bottom after 3 s (distance ${Math.round(a.distance)})`)

  // 10. A chat mounts with no items (loading), and they arrive later: it ends at the bottom once they are in.
  for (const late of [800, 2000]) {
    await load()
    await ev(`window.__streamBench.mount('chat-b', [], true)`)
    await sleep(late)
    await ev(`window.__streamBench.arrive(${SAMPLE})`)
    await sleep(1000)
    a = await state()
    check(a.distance <= 2, `items arriving ${late} ms after the mount: at the bottom 1 s after they land (distance ${Math.round(a.distance)})`)
    await sleep(2000)
    a = await state()
    check(a.distance <= 2, `items arriving ${late} ms after the mount: at the bottom 3 s after they land (distance ${Math.round(a.distance)})`)
  }

  // 11. Scrolled up in one chat, then another chat mounts (a new key, as DeskFrame does): it starts at its bottom.
  await load()
  await ev(`window.__streamBench.mount('chat-a', ${SAMPLE})`)
  await sleep(800)
  await wheel(-600)
  await sleep(300)
  await ev(`window.__streamBench.mount('chat-c', window.__streamBench.sample(30, 5000))`)
  await sleep(1000)
  a = await state()
  check(a.distance <= 2, `switching chat lands at the new chat's bottom after 1 s (distance ${Math.round(a.distance)})`)
  await sleep(2000)
  a = await state()
  check(a.distance <= 2, `switching chat lands at the new chat's bottom after 3 s (distance ${Math.round(a.distance)})`)

  // 12. In a chat whose rows above were never measured, each click on the up arrow lands the previous message they sent on the
  // line 8px under the top (owner, 2026-10-10: it "sometimes just nudges the page up, like, a tiny bit"); a second click while
  // it glides steps on from where it is headed; the down arrow walks forward again the same way.
  await load()
  await ev(`window.__streamBench.mount('chat-s', ${SAMPLE})`)
  await sleep(1000)
  type Landed = { n: number; off: number }
  /** The sent message (sample id "<base>-u<n>") nearest the landing line, and how far off the line it sits. */
  const onLine = (): Promise<Landed> => ev(`(() => { const el = ${SC}; const line = el.getBoundingClientRect().top + 8; let best = null;
    for (const r of el.querySelectorAll('[data-id]')) { const m = /-u(\\d+)$/.exec(r.dataset.id); if (!m) continue;
      const off = r.getBoundingClientRect().top - line; if (!best || Math.abs(off) < Math.abs(best.off)) best = { n: +m[1], off } }
    return best })()`)
  const said = (l: Landed[]) => l.map((x) => `u${x.n} ${x.off >= 0 ? '+' : ''}${Math.round(x.off)}`).join(', ')
  const ups: Landed[] = []
  for (let i = 0; i < 6; i++) {
    const s = await state()
    if (!s.up) break
    await click(s.up)
    await sleep(800)
    ups.push(await onLine())
  }
  check(ups.length === 6 && ups.every((u, i) => Math.abs(u.off) <= 2 && (i === 0 || u.n === ups[i - 1]!.n - 1)),
    `six up clicks land six sent messages in turn on the line (${said(ups)})`)
  const from = await onLine()
  let s = await state()
  if (s.up) {
    await click(s.up)
    await sleep(120)
    s = await state()
    if (s.up) await click(s.up)
  }
  await sleep(900)
  const two = await onLine()
  check(two.n === from.n - 2 && Math.abs(two.off) <= 2, `two quick up clicks go two messages back (u${from.n} -> ${said([two])})`)
  const downs: Landed[] = []
  for (let i = 0; i < 3; i++) {
    s = await state()
    if (!s.down) break
    await click(s.down)
    await sleep(800)
    downs.push(await onLine())
  }
  check(downs.length === 3 && downs.every((d, i) => Math.abs(d.off) <= 2 && d.n === (i ? downs[i - 1]!.n : two.n) + 1),
    `three down clicks land the next three sent messages on the line (${said(downs)})`)

  // 13. The peek under the arrows (owner, 2026-10-10: "show me what the previous message was in ... a slide-down tray"):
  // it shows the message the up arrow would go to and the view stays put; it stays while the pointer is on it, goes about
  // a second after the pointer leaves, and on its own after two seconds; its arrow lands that message on the line.
  const boxOf = (sel: string): Promise<Box | null> => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect();
    return b && b.width ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom } : null })()`)
  const PEEK_BTN = '[data-testid="peek-step"]'
  const TRAY = '[data-testid="message-peek"]'
  const peekText = (): Promise<string | null> => ev(`document.querySelector('${TRAY} p')?.textContent ?? null`)
  const here = await onLine()
  const before = (await state()).top
  const btn = await boxOf(PEEK_BTN)
  if (btn) await click(btn)
  await sleep(400)
  const shown = await peekText()
  const still = Math.abs((await state()).top - before)
  check(!!shown?.startsWith(`Question ${here.n - 1}:`) && still < 1,
    `the peek shows the previous message you sent and the view stays (u${here.n}, tray "${shown?.slice(0, 12) ?? 'none'}", moved ${Math.round(still)})`)
  const tray = await boxOf(TRAY)
  if (tray) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (tray.left + tray.right) / 2 - 100, y: (tray.top + tray.bottom) / 2 })
  await sleep(3000)
  const held = await peekText()
  const away = (await state()).view
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: away.bottom - 60 })
  await sleep(1600)
  const left = await peekText()
  check(held !== null && left === null, `the peek stays while the pointer is on it and goes after it leaves (held ${held !== null}, after ${left !== null})`)
  const again = await boxOf(PEEK_BTN)
  if (again) await click(again)
  await sleep(400)
  const opened = await peekText()
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: away.bottom - 60 })
  await sleep(2600)
  check(opened !== null && (await peekText()) === null, `the peek goes on its own after two seconds`)
  const third = await boxOf(PEEK_BTN)
  if (third) await click(third)
  await sleep(400)
  const go = await ev(`(() => { const b = document.querySelector('${TRAY} button[aria-label="Go to this message"]')?.getBoundingClientRect();
    return b && b.width ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom } : null })()`)
  if (go) await click(go)
  await sleep(900)
  const landed = await onLine()
  check(!!go && landed.n === here.n - 1 && Math.abs(landed.off) <= 2 && (await peekText()) === null,
    `The peek's arrow lands the peeked message on the line and closes the peek (${said([landed])})`)

  // 13. Lazy loading: a 1,000-item chat starts with its newest 200; at the top the pages above land (a spinner while one
  // loads) and the row that was on screen stays where it was.
  await ev('window.__previous = 1')
  await send('Page.navigate', { url: `${BASE}/?load=${Date.now()}#/parity/lazy` })
  let lazyUp = false
  for (let t = 0; t < 100 && !(lazyUp = await ev(`!window.__previous && !!${SC} && !!document.querySelector('[data-id^="lazy-"]')`)); t++) await sleep(100)
  if (!lazyUp) throw new Error('the lazy parity scene did not load')
  await sleep(500)
  const lazyRow = `(() => { const sc = ${SC}, v = sc.getBoundingClientRect();
    const r = [...sc.querySelectorAll('[data-id]')].find((x) => x.getBoundingClientRect().bottom > v.top + 1);
    return r ? { id: r.dataset.id, y: r.getBoundingClientRect().top - v.top } : null })()`
  await ev(`(() => { ${SC}.scrollTop = 0 })()`)
  await frame()
  // Up through the blank that stands for the rows not loaded yet, to where the first loaded row is at the top of the view.
  await ev(`(() => { const sc = ${SC}; sc.scrollTop += ${lazyRow}.y })()`)
  await frame()
  const lazyBefore = await ev(lazyRow)
  const spun = await ev(`!!document.querySelector('[data-testid="older-spinner"]')`)
  await sleep(1800)
  const lazyAfter = await ev(lazyRow)
  const lazyIds = await ev(`[...${SC}.querySelectorAll('[data-id]')].map((x) => Number(x.dataset.id.slice(5)))`)
  const lowest = Math.min(...lazyIds)
  const high = await ev(`${SC}.scrollHeight`)
  check(!!lazyBefore && !!lazyAfter && lazyBefore.id === lazyAfter.id && Math.abs(lazyBefore.y - lazyAfter.y) < 2,
    `the page above lands without moving the row on screen (${lazyBefore?.id} at ${Math.round(lazyBefore?.y ?? 0)} -> ${lazyAfter?.id} at ${Math.round(lazyAfter?.y ?? 0)}; spinner ${spun}; scroll height ${Math.round(high)})`)
  check(lowest < 800, `rows older than the first 200 were loaded (lowest rendered lazy-${lowest})`)

  // 14. A long chat switched to, its history arriving after it mounted, or its history loaded again under it (the window's
  // socket reconnecting empties the cache and fetches it whole): it is at its bottom within 500 ms of its items being
  // there, no frame shows the history above the last screen, and it stays at the bottom (owner, 2026-10-13: the chat
  // "keeps spending 30 seconds scrolling all the way down ... like they were behind"). Measured in the page: every
  // painted frame's distance from the bottom once the items are in, and the scrollTop writes the transcript makes.
  type Open = { landMs: number; far: number; first: number; end: number; writes: number; frames: number }
  async function openLong(how: 'switch' | 'arrive' | 'reload', listExpr: string): Promise<Open> {
    await ev('window.__previous = 1')
    await send('Page.navigate', { url: `${BASE}/?load=${Date.now()}#/stream-bench` })
    for (let t = 0; t < 100 && !(await ev(`!window.__previous && !!window.__streamBench?.ready && !!${SC}`)); t++) await sleep(100)
    if (how === 'reload') {
      // Opened as the Desk opens a chat: empty, then its history; the rows at its bottom are measured, the top's never are.
      await ev(`window.__streamBench.mount('long', [], true); window.__list = ${listExpr}; setTimeout(() => window.__streamBench.arrive(window.__list), 50)`)
      await sleep(800)
    }
    return ev(`new Promise((done) => {
      const SC = '[data-transcript-scroller]';
      const bench = window.__streamBench;
      const list = window.__list ?? ${listExpr};
      const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      const rec = { writes: 0, frames: [], t0: Infinity };
      Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get: d.get, set(v) { if (this.matches?.(SC)) rec.writes++; d.set.call(this, v) } });
      const finish = () => {
        Object.defineProperty(Element.prototype, 'scrollTop', d);
        // Landed: the first frame from which every later one is at the bottom.
        const off = rec.frames.findLastIndex((f) => f.distance > 2);
        const landed = rec.frames[off + 1];
        done({ landMs: landed ? landed.t : 1e9, far: rec.frames.filter((f) => f.distance > f.client).length, first: rec.frames[0]?.distance ?? -1,
          end: rec.frames[rec.frames.length - 1]?.distance ?? -1, writes: rec.writes, frames: rec.frames.length });
      };
      const sampleFrame = () => {
        const el = document.querySelector(SC);
        const t = performance.now() - rec.t0;
        if (el && t >= 0 && el.scrollHeight > 2 * el.clientHeight) rec.frames.push({ t, distance: el.scrollHeight - el.scrollTop - el.clientHeight, client: el.clientHeight });
        if (t < 2000) requestAnimationFrame(sampleFrame); else finish();
      };
      requestAnimationFrame(sampleFrame);
      const land = () => { rec.t0 = performance.now(); bench.arrive(list) };
      if ('${how}' === 'switch') { rec.t0 = performance.now(); bench.mount('long', list, false) }
      else if ('${how}' === 'arrive') { bench.mount('long', [], true); setTimeout(land, 0) }
      else { bench.arrive([]); setTimeout(land, 120) }
    })`)
  }
  // A long chat in the shape of the owner's longest (2026-10-14: 6,600 to 16,500 items, three in four of them tool runs,
  // then replies, thinking, tasks, notes and system lines; text 150 to 7,000 characters), opening on a long one-paragraph
  // question and replies that render shorter than their estimates. Invented text throughout.
  const REAL = (n: number) => `((n) => {
    const words = 'the build reads its config then checks each module and writes a short report of what it found '.split(' ');
    const say = (i, len) => { let t = ''; for (let k = 0; t.length < len; k++) t += words[(i + k * 7) % words.length] + (k % 13 === 12 ? '.\\n\\n' : ' '); return t };
    const one = (t) => t.replace(/\\n+/g, ' ');
    const size = (i) => [120, 180, 240, 400, 900, 1800, 3000, 4600][(i * 2654435761 >>> 0) % 8];
    const out = []; let ts = 0;
    for (let i = 0; out.length < n; i++) {
      const id = 'r' + i + '-', at = () => ts++;
      out.push({ id: id + 'u', ts: at(), kind: 'user', text: i === 0 ? one(say(0, 1800)) : i % 8 ? say(i, size(i) / 3) : [say(i, 200), say(i + 1, 120), say(i + 2, 90), say(i + 3, 60)].join('\\n') });
      if (i % 4 === 0) out.push({ id: id + 'th', ts: at(), kind: 'thinking', text: say(i + 1, size(i + 1)) });
      for (let k = 0; k < 12; k++) {
        const t = at(), name = ['Bash', 'Read', 'Edit', 'Grep'][k % 4];
        out.push({ id: id + 't' + k, ts: t, kind: 'tool_use', name, input: name === 'Bash' ? { command: 'npm test -- run ' + k } : { file_path: 'C:/Users/me/work/src/mod' + k + '.ts' }, status: 'done', startedAt: t, endedAt: t + 1 });
        if (k % 4 === 3) out.push({ id: id + 'a' + k, ts: at(), kind: 'assistant_text', text: i === 0 ? one(say(k, 900)) : say(i + k, size(i + k)) });
      }
      if (i % 6 === 0) out.push({ id: id + 'task', ts: at(), kind: 'task', taskId: String(i), description: 'Check the module ' + i, status: 'completed', taskKind: 'agent' });
      if (i % 5 === 0) out.push({ id: id + 'n', ts: at(), kind: 'note', from: 'lead', text: say(i + 2, 300) });
      if (i % 7 === 0) out.push({ id: id + 's', ts: at(), kind: 'system', level: 'info', text: 'Compacted the context.' });
      out.push({ id: id + 'res', ts: at(), kind: 'result', ok: true, durationMs: 4000, costUsd: 0.1, turns: 12 });
    }
    return out;
  })(${n})`
  // A desktop-sized window: the rows at the bottom of a taller view are all measured before the reload.
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  for (const how of ['switch', 'arrive', 'reload'] as const) {
    const r = await openLong(how, REAL(12000))
    check(r.landMs <= 500 && r.far === 0 && Math.abs(r.end) <= 2,
      `a 12,000-item chat ${how === 'switch' ? 'switched to' : how === 'arrive' ? 'whose history arrives after it opened' : 'whose history loads again under it'} opens at its bottom: at the bottom after ${Math.round(r.landMs)} ms, ${r.far} of ${r.frames} frames above the last screen, first frame ${Math.round(r.first)}px and last ${Math.round(r.end)}px from the bottom, ${r.writes} scrollTop writes`)
  }
} finally {
  // The Edge launched here may hand its window to another process: close the browser over CDP, then the launcher.
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json()
    const b = new WebSocket(webSocketDebuggerUrl)
    await new Promise((r) => (b.onopen = r))
    b.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
    await sleep(300)
    b.close()
  } catch {}
  for (const s of sockets) s.close()
  edge?.kill()
  vite.kill()
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {}
}

for (const l of lines) console.log(l.line)
const failed = lines.filter((l) => !l.ok).length
console.log(failed ? `${failed} of ${lines.length} FAILED` : `all ${lines.length} passed`)
process.exit(failed ? 1 : 0)
