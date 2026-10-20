/**
 * Every README screenshot, in one run: `bun run screenshots:readme`.
 *
 *   bun run screenshots:readme                 # build, shoot every view, check, install, update provenance, report
 *   bun run screenshots:readme -- --keep       # stop after the report: nothing in .github/ changes
 *   bun run screenshots:readme -- --no-build   # shoot the build already there
 *
 * It is not a third generator. It runs the two that exist, with one browser, clock, timezone and type
 * (page-env.mjs), and then checks what they made:
 *
 *   - capture.mjs shoots AgentHydra's own pages (Instances, Analytics) on fixtures that replace every /api/ answer;
 *   - desk2/scripts/window-shots.ts shoots Desk's window on its demo world (window, New, the Codex hub's PCs).
 *
 * Each generator already refuses a view that did not draw, a request that escaped its fixtures, and private text
 * on screen, and lists what it made in its staging folder's manifest.json. This run then checks every picture in
 * those manifests is a PNG of exactly its viewport at its scale and matches the hash its generator wrote. Only when
 * every one passed are they copied into .github/screenshots, and scripts/binary-provenance.json gets each picture's
 * new blob and sha256 (the public audit then checks them as it checks every binary; a new picture gets an entry of
 * its own). The bytes a picture replaces move to its entry's `previous`, so the history audit still matches the
 * published commits that hold them by their exact hash. The report (tmp/screenshots-readme/report.md and .json) says what passed, what failed and what
 * changed. It never commits or pushes: look at the pictures, then commit them yourself.
 *
 * A new view is a new entry in one generator's SHOTS: a window view in window-shots.ts, an AgentHydra page in
 * capture.mjs. This run picks it up from the manifest; README.md places it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeVersion, pngSize, resolveChrome, SHOT_CLOCK, SHOT_TIMEZONE } from './page-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const INSTALL_DIR = join(REPO, '.github', 'screenshots');
const REPORT_DIR = join(REPO, 'tmp', 'screenshots-readme');
const PROVENANCE = join(REPO, 'scripts', 'binary-provenance.json');

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const BUILD = !argv.includes('--no-build');

const GENERATORS = [
  { name: 'AgentHydra pages', cwd: REPO, script: 'scripts/screenshots/capture.mjs', stage: join(REPO, 'tmp', 'screenshots') },
  { name: 'Desk window', cwd: join(REPO, 'desk2'), script: 'scripts/window-shots.ts', stage: join(REPO, 'tmp', 'screenshots-window') },
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tail = (text, lines = 25) => text.trim().split('\n').slice(-lines).join('\n');

function run(cmd, args, cwd, env = process.env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
}

const report = {
  startedAt: new Date().toISOString(),
  commit: run('git', ['rev-parse', 'HEAD'], REPO).output.trim(),
  dirty: run('git', ['status', '--porcelain', '--untracked-files=no'], REPO).output.trim() !== '',
  clock: new Date(SHOT_CLOCK).toISOString(),
  timezone: SHOT_TIMEZONE,
  browser: null,
  build: BUILD ? 'pending' : 'skipped',
  generators: [],
  shots: [],
  installed: false,
  provenance: [],
  ok: false,
  error: null,
};

function finish() {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(REPORT_DIR, 'report.md'), markdown(report));
  console.log(`\n${report.ok ? 'OK' : 'FAILED'}: report in ${relative(REPO, join(REPORT_DIR, 'report.md'))}`);
  process.exit(report.ok ? 0 : 1);
}

function markdown(r) {
  const lines = [
    '# README screenshots',
    '',
    `Result: **${r.ok ? 'passed' : 'failed'}**${r.error ? ` (${r.error})` : ''}`,
    '',
    `- Commit: \`${r.commit}\`${r.dirty ? ' with uncommitted changes' : ''}`,
    `- Browser: ${r.browser ? `${r.browser.version || '(version not reported)'} from ${r.browser.from}` : 'not found'}`,
    `- Clock: ${r.clock}, timezone ${r.timezone}`,
    `- Build: ${r.build}`,
    `- Installed into .github/screenshots: ${r.installed ? 'yes' : 'no'}`,
    '',
    '| Generator | Result |',
    '| --- | --- |',
    ...r.generators.map((g) => `| ${g.name} (\`${g.script}\`) | ${g.ok ? 'passed' : 'failed'} |`),
    '',
    '| Shot | Result | Size | Bytes | Compared with the committed picture |',
    '| --- | --- | --- | --- | --- |',
    ...r.shots.map((s) => `| ${s.name}.png | ${s.ok ? 'passed' : `failed: ${s.problems.join('; ')}`} | ${s.width ?? '?'}×${s.height ?? '?'} | ${s.bytes ?? '?'} | ${s.change} |`),
  ];
  if (r.provenance.length) lines.push('', 'Provenance entries updated:', '', ...r.provenance.map((p) => `- \`${p.path}\` (${p.action})`));
  const failed = r.generators.filter((g) => !g.ok);
  for (const g of failed) lines.push('', `## ${g.name} output`, '', '```', g.outputTail, '```');
  if (r.ok && !r.installed) lines.push('', 'Nothing was installed (--keep). The pictures are in the staging folders named above.');
  if (r.installed) lines.push('', 'Look at the pictures in .github/screenshots before you commit them; nothing was committed or pushed.');
  return `${lines.join('\n')}\n`;
}

// --- the browser both generators use ----------------------------------------------------------
let chrome;
try {
  chrome = resolveChrome();
} catch (err) {
  report.error = err.message;
  finish();
}
report.browser = { path: relative(REPO, chrome.path).startsWith('..') ? chrome.path : relative(REPO, chrome.path), from: chrome.from, version: chromeVersion(chrome.path) };
const env = { ...process.env, CHROME_PATH: chrome.path, PUPPETEER_EXECUTABLE_PATH: chrome.path };
console.log(`browser: ${report.browser.version || chrome.path} (${chrome.from})`);

// --- the build both generators shoot ----------------------------------------------------------
if (BUILD) {
  console.log('building desk2 (web and hydra)…');
  const b = run(process.execPath, ['run', 'build'], REPO, env);
  report.build = b.ok ? 'built' : 'failed';
  if (!b.ok) {
    report.generators.push({ name: 'build', script: 'bun run build', ok: false, outputTail: tail(b.output) });
    report.error = 'the build failed';
    finish();
  }
}

// --- both generators, always into their staging folders ----------------------------------------
for (const g of GENERATORS) {
  console.log(`shooting: ${g.name}…`);
  const r = run(process.execPath, [g.script, '--keep'], g.cwd, env);
  report.generators.push({ name: g.name, script: relative(REPO, join(g.cwd, g.script)).replaceAll('\\', '/'), ok: r.ok, outputTail: tail(r.output) });
  process.stdout.write(`${tail(r.output, 8)}\n`);
  const manifestFile = join(g.stage, 'manifest.json');
  if (!r.ok || !existsSync(manifestFile)) continue;
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  for (const shot of manifest.shots) {
    const file = join(g.stage, shot.file);
    const problems = [];
    let size = null;
    let bytes = null;
    if (!existsSync(file)) problems.push('missing');
    else {
      const data = readFileSync(file);
      bytes = data.length;
      size = pngSize(file);
      if (!size) problems.push('not a PNG');
      else if (size.width !== shot.viewport[0] * shot.scale || size.height !== shot.viewport[1] * shot.scale)
        problems.push(`${size.width}×${size.height}, expected ${shot.viewport[0] * shot.scale}×${shot.viewport[1] * shot.scale}`);
      if (sha256(data) !== shot.sha256) problems.push('changed after its generator checked it');
    }
    const installed = join(INSTALL_DIR, shot.file);
    const change = !bytes ? 'n/a' : !existsSync(installed) ? 'new' : sha256(readFileSync(installed)) === shot.sha256 ? 'unchanged' : 'changed';
    report.shots.push({ name: shot.name, generator: g.name, staged: relative(REPO, file).replaceAll('\\', '/'), ok: problems.length === 0, problems, width: size?.width, height: size?.height, bytes, sha256: shot.sha256, change });
  }
}

const generatorsOk = report.generators.every((g) => g.ok) && report.generators.length === GENERATORS.length;
const shotsOk = report.shots.length > 0 && report.shots.every((s) => s.ok);
if (!generatorsOk || !shotsOk) {
  report.error = !generatorsOk ? 'a generator failed' : 'a picture failed its checks';
  finish();
}

// --- install, and the provenance the public audit checks -------------------------------------
if (!KEEP) {
  mkdirSync(INSTALL_DIR, { recursive: true });
  const provenance = JSON.parse(readFileSync(PROVENANCE, 'utf8'));
  for (const s of report.shots) {
    const target = join(INSTALL_DIR, `${s.name}.png`);
    copyFileSync(join(REPO, s.staged), target);
    const path = relative(REPO, target).replaceAll('\\', '/');
    const blob = run('git', ['hash-object', target], REPO).output.trim();
    const generator = report.generators.find((g) => g.name === s.generator).script;
    const build = `bun run screenshots:readme (scripts/screenshots/readme.mjs, running ${generator}) on synthetic fixtures only; checked for private text, escaped requests and size before install.`;
    const entry = provenance.binaries.find((b) => b.path === path);
    if (entry) {
      if (entry.blob === blob && entry.sha256 === s.sha256 && entry.build === build) continue;
      // The bytes it replaces stay recorded while a commit holds them, so the history audit still knows them by
      // their exact hash; bytes no commit ever held (an earlier uncommitted run) are not in git's store and go.
      const committed = run('git', ['cat-file', '-e', `${entry.blob}^{blob}`], REPO).ok;
      if (entry.blob !== blob && committed && !(entry.previous ?? []).some((p) => p.blob === entry.blob)) {
        entry.previous = [...(entry.previous ?? []), { blob: entry.blob, sha256: entry.sha256 }];
      }
      Object.assign(entry, { blob, sha256: s.sha256, build });
      report.provenance.push({ path, action: 'updated' });
    } else {
      provenance.binaries.push({
        path,
        blob,
        sha256: s.sha256,
        source: 'AgentHydra Community screenshot generated from current UI with wholly synthetic demo fixtures.',
        build,
        license: 'AgentHydra Community MIT-licensed application screenshot.',
      });
      provenance.binaries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      report.provenance.push({ path, action: 'added' });
    }
  }
  writeFileSync(PROVENANCE, `${JSON.stringify(provenance, null, 2)}\n`);
  report.installed = true;
}

report.ok = true;
finish();
