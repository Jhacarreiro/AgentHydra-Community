#!/usr/bin/env bun
/**
 * The README's and the website's pictures of AgentHydra's window, from its demo world.
 *
 *   bun run build                        # first: it shoots the built window (web/dist)
 *   bun run screenshots                  # shoot, then install into ../.github/screenshots
 *   bun run screenshots -- --keep        # stop after ../tmp/screenshots-window, to look first
 *
 * From the repository root, `bun run screenshots:readme` runs this and the AgentHydra pages' generator together,
 * checks every picture and writes a report (../scripts/screenshots/readme.mjs).
 *
 * The pictures are public, so nothing real may be in them. They are of `#/gallery/shell`, the whole
 * window drawn on invented chats, accounts and projects (web/src/components/shell/demo.ts). The page is
 * served here, by a server that holds no data: it answers every /api/, /dw/ and /ah/ request with a 503,
 * and the browser is allowed no other origin, so no daemon or Desk is ever reached. Each shot has an
 * `expect` that must hold (the demo's own words on screen) before the picture is kept, the drawn page must hold
 * no private value (an address off example.*, a home folder other than `me`, a key), and a picture is copied
 * into .github/screenshots only when every shot passed. The clock, timezone, language, browser and type are
 * ../scripts/screenshots/page-env.mjs's, shared with the AgentHydra pages' pictures (Instances, Analytics),
 * which come from ../scripts/screenshots/capture.mjs.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import puppeteer from 'puppeteer'
import { chromeArgs, clockScript, privacyScript, resolveChrome, SHOT_FONT_DIR, SHOT_TIMEZONE, stillCss, styleScript, windowFontCss } from '../../scripts/screenshots/page-env.mjs'

const DESK = join(import.meta.dir, '..')
const DIST = join(DESK, 'web', 'dist')
const STAGE = join(DESK, '..', 'tmp', 'screenshots-window')
const INSTALL = join(DESK, '..', '.github', 'screenshots')
const KEEP = process.argv.includes('--keep')
const PORT = 5196
const SCALE = 2
/** A picture smaller than this never holds a drawn window. */
const MIN_PNG_BYTES = 40_000

interface Shot {
  name: string
  route: string
  viewport: [number, number]
  /** Run in the page; true once the view is drawn as it should be. */
  expect: string
  /** localStorage the window reads at start (each shot runs in a fresh browser context, so nothing carries over). */
  storage?: Record<string, string>
}

const SHOTS: Shot[] = [
  {
    name: 'window',
    route: '/gallery/shell',
    viewport: [1280, 800],
    expect: `/Desktop client rewrite plan/.test(document.body.innerText) && /To-dos/.test(document.body.innerText)`,
  },
  {
    name: 'new',
    route: '/gallery/shell/new',
    viewport: [1280, 800],
    expect: `/What’s up next/.test(document.body.innerText) && /nexuscode-2d/.test(document.body.innerText) && /docs-site/.test(document.body.innerText) && document.querySelectorAll('[aria-label$="open chats"], [aria-label$="open chat"]').length >= 1`,
  },
  {
    // Codex chats two other PCs push to the Codex hub, listed beside this PC's, one of them open and read.
    name: 'hub',
    route: '/gallery/shell/hub',
    viewport: [1280, 800],
    // The Apps filter with Codex ticked, as someone who uses the hub has it.
    storage: { 'hydra-desk.cloud.scopes': JSON.stringify({ apps: ['claude', 'codex'] }) },
    // Two rows from each PC, each with the other PC's mark, and the open chat's transcript drawn (not its error).
    expect: `document.querySelectorAll('[aria-label="Codex chat from Studio PC, through the chat sync"]').length >= 2 && document.querySelectorAll('[aria-label="Codex chat from Travel laptop, through the chat sync"]').length >= 2 && /save counter first/.test(document.body.innerText) && !/Could not load/.test(document.body.innerText)`,
  },
]

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('web/dist is missing: run `bun run build` first.')
  process.exit(1)
}

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }
const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname)
    if (/^\/(api|dw|ah|events)(\/|$)/.test(path)) return new Response('no data here: window-shots serves the demo window only', { status: 503 })
    // The pictures' type (page-env.mjs windowFontCss), from AgentHydra's own pages' fonts.
    if (path.startsWith('/__shot-fonts/')) {
      const font = normalize(join(SHOT_FONT_DIR, path.slice('/__shot-fonts/'.length)))
      if (!font.startsWith(SHOT_FONT_DIR) || !existsSync(font)) return new Response('no such font', { status: 404 })
      return new Response(readFileSync(font), { headers: { 'content-type': 'font/woff2' } })
    }
    const file = normalize(join(DIST, path === '/' ? 'index.html' : path))
    if (!file.startsWith(DIST) || !statSync(file, { throwIfNoEntry: false })?.isFile()) return new Response(readFileSync(join(DIST, 'index.html')), { headers: { 'content-type': 'text/html' } })
    return new Response(readFileSync(file), { headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' } })
  },
})
const origin = `http://127.0.0.1:${PORT}`

const browser = await puppeteer.launch({ headless: true, executablePath: resolveChrome().path, args: ['--hide-scrollbars', ...chromeArgs()] })
let failed = false
try {
  mkdirSync(STAGE, { recursive: true })
  // A manifest is only ever this run's: a failed run must not leave the last one's for readme.mjs to read.
  rmSync(join(STAGE, 'manifest.json'), { force: true })
  for (const shot of SHOTS) {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    const elsewhere: string[] = []
    await page.setRequestInterception(true)
    page.on('request', (r) => {
      const url = r.url()
      if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return void r.continue()
      elsewhere.push(url)
      void r.abort()
    })
    await page.setViewport({ width: shot.viewport[0], height: shot.viewport[1], deviceScaleFactor: SCALE })
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await page.emulateTimezone(SHOT_TIMEZONE)
    await page.evaluateOnNewDocument(clockScript)
    await page.evaluateOnNewDocument(styleScript(`${windowFontCss}\n${stillCss}`))
    if (shot.storage)
      await page.evaluateOnNewDocument((kv: Record<string, string>) => {
        for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v)
      }, shot.storage)
    await page.goto(`${origin}/#${shot.route}`, { waitUntil: 'networkidle0' })
    const drawn = await page.waitForFunction(shot.expect, { timeout: 30_000 }).then(
      () => true,
      () => false,
    )
    await page.evaluate(() => document.fonts.ready)
    await new Promise((go) => setTimeout(go, 800))
    const privateText = (await page.evaluate(privacyScript)) as string[]
    const file = join(STAGE, `${shot.name}.png`)
    await page.screenshot({ path: file })
    const size = statSync(file).size
    if (privateText.length > 0) {
      console.error(`[${shot.name}] private text on screen: not installed\n  ${privateText.join('\n  ')}`)
      failed = true
    } else if (!drawn || size < MIN_PNG_BYTES) {
      console.error(`[${shot.name}] not drawn as expected (expect held: ${drawn}, ${size} bytes): not installed`)
      failed = true
    } else console.log(`[${shot.name}] ${file} (${Math.round(size / 1024)} KB)${elsewhere.length ? `; refused ${elsewhere.length} request(s) to other origins` : ''}`)
    await context.close()
  }
} finally {
  await browser.close()
  server.stop(true)
}

if (failed) process.exit(1)
// What was shot, for readme.mjs's report and checks, written only once every shot passed.
const manifest = {
  generator: 'desk2/scripts/window-shots.ts',
  shots: SHOTS.map((shot) => {
    const bytes = readFileSync(join(STAGE, `${shot.name}.png`))
    return { name: shot.name, file: `${shot.name}.png`, route: shot.route, viewport: shot.viewport, scale: SCALE, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }),
}
writeFileSync(join(STAGE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
if (KEEP) console.log(`kept in ${STAGE}; nothing installed`)
else {
  mkdirSync(INSTALL, { recursive: true })
  for (const shot of SHOTS) copyFileSync(join(STAGE, `${shot.name}.png`), join(INSTALL, `${shot.name}.png`))
  console.log(`installed ${SHOTS.length} picture(s) into ${INSTALL}`)
}
