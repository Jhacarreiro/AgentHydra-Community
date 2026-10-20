/**
 * What every README screenshot shares, whichever generator takes it (capture.mjs for AgentHydra's pages,
 * desk2/scripts/window-shots.ts for Desk's window): the browser, the clock and timezone, the window's type,
 * and the check that no private value is on screen when the shutter fires. `bun run screenshots:readme`
 * (readme.mjs) runs both generators with these, so a shot taken today and one taken next month on another
 * machine differ only where the app did.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

/** The moment every shot is taken at: "resets 10:33" and "3 min ago" read the same in every run. */
export const SHOT_CLOCK = Date.parse('2026-10-15T09:30:00Z');
export const SHOT_TIMEZONE = 'UTC';
export const SHOT_LOCALE = 'en-US';

/**
 * Runs in the page before anything else: Date starts at `fixedMs` and ticks on from there, so timers,
 * animations and "working for 3m" still move, but from the same start every run.
 */
export function installClock(fixedMs) {
  const RealDate = Date;
  const offset = fixedMs - RealDate.now();
  class ShotDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShotDate;
}

/** The page script for the clock, ready for addScriptToEvaluateOnNewDocument. */
export const clockScript = `(${installClock.toString()})(${SHOT_CLOCK});`;

/**
 * Desk's window types in `system-ui`, which is a different face on every OS (Segoe UI, San Francisco, whatever a
 * Linux runner has). For the pictures it uses Inter, the face AgentHydra's own pages already ship
 * (desk2/hydra/public/fonts, OFL), so a picture does not change because the machine did.
 */
export const windowFontCss = `@font-face{font-family:'Shot Inter';font-style:normal;font-weight:100 900;font-display:block;src:url('/__shot-fonts/inter-latin.woff2') format('woff2')}
:root{--font-sans:'Shot Inter',system-ui,sans-serif !important}`;
/**
 * Motion is a moment: a shimmer or spinner mid-loop changes pixels from run to run. Every animation jumps to its last
 * frame and nothing transitions, so a picture is the view at rest.
 */
export const stillCss = `*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;animation-iteration-count:1 !important;transition:none !important;caret-color:transparent !important}`;

/** A page script that adds `css` to the page as soon as it has a head. */
export const styleScript = (css) =>
  `document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s) });`;

export const SHOT_FONT_DIR = join(REPO, 'desk2', 'hydra', 'public', 'fonts');

/**
 * Text on screen that must never be in a public picture: an email address off the reserved example domains, a
 * home folder other than the fixtures' `me`, and anything shaped like a key. Pure, so it runs in the page
 * (`privacyScript`) and in tests alike.
 */
export function privateFindings(text) {
  const found = [];
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
    if (!/@(?:[A-Za-z0-9-]+\.)*example\.(?:com|org|net|test)$/i.test(m[0])) found.push(`email: ${m[0]}`);
  }
  for (const m of text.matchAll(/(?:^|[\s"'`(=:])((?:[A-Za-z]:)?[\\/](?:Users|home)[\\/]([^\\/\s"'`)]+))/gi)) {
    if (m[2].toLowerCase() !== 'me') found.push(`home folder: ${m[1]}`);
  }
  for (const m of text.matchAll(/\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})/g)) {
    found.push(`key: ${m[0].slice(0, 8)}…`);
  }
  return [...new Set(found)];
}

/** Every piece of text a person could read in the page: what is drawn, tooltips, labels and field values. */
const collectPageText = () =>
  [
    document.title,
    document.body.innerText,
    ...[...document.querySelectorAll('[title],[aria-label],[placeholder],input,textarea')].map((e) =>
      [e.getAttribute('title'), e.getAttribute('aria-label'), e.getAttribute('placeholder'), 'value' in e ? e.value : null].filter(Boolean).join('\n'),
    ),
  ].join('\n');

/** A page expression answering the private values on screen now (an empty array when there are none). */
export const privacyScript = `(${privateFindings.toString()})((${collectPageText.toString()})())`;

/** Chrome's flags for a shot: a root user (a container, some CI) has no sandbox to start. */
export function chromeArgs() {
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  return [`--lang=${SHOT_LOCALE}`, '--force-color-profile=srgb', '--font-render-hinting=none', ...(process.env.CI || root ? ['--no-sandbox'] : [])];
}

/**
 * The one browser both generators use: CHROME_PATH (or PUPPETEER_EXECUTABLE_PATH) when set, else the Chrome
 * for Testing that desk2's puppeteer installed, whose version the lockfile fixes, else a Chrome on the machine.
 */
export function resolveChrome() {
  for (const key of ['CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH']) {
    const p = process.env[key];
    if (p) {
      if (!existsSync(p)) throw new Error(`${key} points at nothing: ${p}`);
      return { path: p, from: key };
    }
  }
  try {
    const require = createRequire(join(REPO, 'desk2', 'package.json'));
    const p = require('puppeteer').executablePath();
    if (p && existsSync(p)) return { path: p, from: 'puppeteer' };
  } catch {
    /* puppeteer's browser was not downloaded */
  }
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
          `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  const hit = candidates.find((p) => p && existsSync(p));
  if (!hit) throw new Error('No Chrome/Chromium/Edge found. Set CHROME_PATH to a Chromium-based browser executable.');
  return { path: hit, from: 'system' };
}

/** The browser's own version line, for the report ("" when it will not say, as Chrome on Windows may not). */
export function chromeVersion(path) {
  const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  return (r.stdout || '').trim();
}

/** Width and height from a PNG's IHDR, or null when the file is no PNG. */
export function pngSize(file) {
  const b = readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || sig.some((v, i) => b[i] !== v) || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
