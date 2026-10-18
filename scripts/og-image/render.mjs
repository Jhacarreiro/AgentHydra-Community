/**
 * Render the social preview card.
 *
 *   bun run og-image            # shoot scripts/og-image/card.html into .github/og-image.png
 *   bun run og-image -- --keep  # stop at tmp/og-image/og-image.png, to look before installing
 *
 * The card is a plain HTML page (card.html, beside this file). This inlines the files it points
 * at (the logo and the Inter face) as data: URLs into tmp/og-image/card.html, opens that in a
 * local headless Chrome, Chromium or Edge with a 1280x640 viewport at one device pixel per CSS
 * pixel, waits until the face and the logo have loaded, shoots it, checks the PNG really is
 * 1280x640, then copies it to .github/og-image.png and writes its new blob and sha256 into that
 * file's entry in scripts/binary-provenance.json, which the public audit checks.
 *
 * Chrome is driven over the DevTools protocol, as scripts/screenshots/capture.mjs does, so no
 * package is needed. Its own --screenshot switch is not enough: under the new headless mode
 * --window-size sizes the window, not the page, and the card came out with its bottom 87px
 * unpainted. CHROME_PATH picks the browser; otherwise a Playwright download under
 * PLAYWRIGHT_BROWSERS_PATH, then the usual install folders, are tried.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CARD = join(HERE, 'card.html');
const TMP_DIR = join(REPO, 'tmp', 'og-image');
const PROFILE_DIR = join(TMP_DIR, 'profile');
const SHOT = join(TMP_DIR, 'og-image.png');
const TARGET = '.github/og-image.png';
const PROVENANCE = join(REPO, 'scripts', 'binary-provenance.json');
const WIDTH = 1280;
const HEIGHT = 640;

/** What card.html points at, relative to it, and the type its data: URL carries. Each must appear in the page. */
const INLINE = [
  { ref: '../../misc/brand/icon.svg', type: 'image/svg+xml' },
  { ref: '../../desk2/hydra/public/fonts/inter-latin.woff2', type: 'font/woff2' },
];

const KEEP = process.argv.includes('--keep');

function findChrome() {
  // An override that points at nothing is a typo, not a hint to look elsewhere.
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`CHROME_PATH points at nothing: ${fromEnv}`);
    return fromEnv;
  }
  const candidates = [];
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pw && existsSync(pw)) {
    // Newest first: chromium-1194 before chromium-1100.
    const builds = readdirSync(pw)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of builds) {
      candidates.push(
        join(pw, d, 'chrome-linux', 'chrome'),
        join(pw, d, 'chrome-win', 'chrome.exe'),
        join(pw, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      );
    }
  }
  if (process.platform === 'win32') {
    candidates.push(
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  const hit = candidates.find((p) => p && existsSync(p));
  if (!hit) throw new Error('No Chrome/Chromium/Edge found. Set CHROME_PATH to a Chromium-based browser executable.');
  return hit;
}

/** card.html with every INLINE file swapped for a data: URL, so the page needs nothing from disk. */
function inlinedCard() {
  let html = readFileSync(CARD, 'utf8');
  for (const { ref, type } of INLINE) {
    if (!html.includes(ref)) throw new Error(`card.html no longer points at ${ref}; update INLINE in render.mjs`);
    const bytes = readFileSync(join(HERE, ref));
    html = html.replaceAll(ref, `data:${type};base64,${bytes.toString('base64')}`);
  }
  return html;
}

/** Reads the IHDR width and height; anything that does not open with PNG's signature gives null. */
function pngDimensions(bytes) {
  const signature = '89504e470d0a1a0a';
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== signature) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Git's blob id for these bytes (what `git hash-object` prints). */
const gitBlob = (bytes) =>
  createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest('hex');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chrome writes the port it really bound as the first line of DevToolsActivePort in its profile. */
async function devtoolsPort() {
  const file = join(PROFILE_DIR, 'DevToolsActivePort');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0].trim());
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      /* not written yet */
    }
    await sleep(200);
  }
  throw new Error('Chrome never reported a DevTools port (did it fail to start?)');
}

async function pageSocket(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not listening yet */
    }
    await sleep(200);
  }
  throw new Error('Chrome never exposed a page target');
}

/** One DevTools session: send(method, params) answers the call's result, or throws its error. */
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not attach to Chrome'));
  });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const call = m.id && pending.get(m.id);
    if (!call) return;
    pending.delete(m.id);
    if (m.error) call.reject(new Error(m.error.message));
    else call.resolve(m.result);
  };
  ws.onclose = () => {
    for (const [, call] of pending) call.reject(new Error('Chrome closed the DevTools connection'));
    pending.clear();
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after 30s`));
      }, 30_000);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close() };
}

/** True once the page has its face and its logo: what a shot taken any earlier would be missing. */
const READY = `(async () => {
  await document.fonts.ready;
  const img = document.querySelector('img');
  const loaded = document.readyState === 'complete' && document.fonts.check('800 92px Inter') && !!img && img.complete && img.naturalWidth > 0;
  // Two frames, so what is painted is the page at the viewport's size, not a frame from before it.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return loaded && innerWidth === ${WIDTH} && innerHeight === ${HEIGHT};
})()`;

async function shoot(page) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${PROFILE_DIR}`,
    // Port 0: the OS picks a free one, read back from the profile, so two runs never meet.
    '--remote-debugging-port=0',
    // A window taller than the card, so the page's surface never has to grow to the viewport below.
    `--window-size=${WIDTH},${HEIGHT + 200}`,
  ];
  // Chrome refuses to start as root with its sandbox on (a container, a CI box); the page is this
  // repository's own file, with nothing fetched from anywhere.
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
  args.push('about:blank');

  const chrome = findChrome();
  console.log(`shooting card.html with ${chrome}`);
  // detached on POSIX so the group kill below takes Chrome's helper processes too.
  const child = spawn(chrome, args, { stdio: 'ignore', detached: process.platform !== 'win32' });
  try {
    const { send, close } = await connect(await pageSocket(await devtoolsPort()));
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: pathToFileURL(page).href });
    const deadline = Date.now() + 20_000;
    for (;;) {
      const r = await send('Runtime.evaluate', { expression: READY, awaitPromise: true, returnByValue: true }).catch(() => null);
      if (r?.result?.value === true) break;
      if (Date.now() > deadline) throw new Error('the card never finished loading its face and logo');
      await sleep(200);
    }
    // Two shots of a still page are the same bytes. They were not while the viewport could still be
    // resizing (a window shorter than the card): one in two runs came out as the card's top-left
    // corner tiled four times, which nothing else here would notice.
    const capture = async () =>
      Buffer.from(
        (await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 } }))
          .data,
        'base64',
      );
    const first = await capture();
    await sleep(300);
    if (!first.equals(await capture())) throw new Error('two shots of the same card differ; run it again');
    close();
    return first;
  } finally {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

async function main() {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  const page = join(TMP_DIR, 'card.html');
  writeFileSync(page, inlinedCard());

  const bytes = await shoot(page);
  const size = pngDimensions(bytes);
  if (!size || size.width !== WIDTH || size.height !== HEIGHT) {
    throw new Error(`the shot is ${size ? `${size.width}x${size.height}` : 'not a PNG'}, not ${WIDTH}x${HEIGHT}`);
  }
  writeFileSync(SHOT, bytes);
  // Chrome may still hold files in its profile for a moment after the kill.
  await sleep(300);
  rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 5 });

  if (KEEP) {
    console.log(`kept ${SHOT}; run again without --keep to install it`);
    return;
  }
  copyFileSync(SHOT, join(REPO, TARGET));

  // The audit fails on a binary whose blob or sha256 differ from its entry, so the entry moves with the image.
  const provenance = JSON.parse(readFileSync(PROVENANCE, 'utf8'));
  const entry = provenance.binaries.find((b) => b.path === TARGET);
  if (!entry) throw new Error(`scripts/binary-provenance.json has no entry for ${TARGET}`);
  entry.blob = gitBlob(bytes);
  entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(PROVENANCE, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`installed ${TARGET} (blob ${entry.blob}, sha256 ${entry.sha256})`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`og-image: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
