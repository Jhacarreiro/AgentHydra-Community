#!/usr/bin/env bun
/**
 * Stage and archive one AgentHydra release bundle (the same script in CI and on a PC).
 *
 *   bun scripts/package-release.ts --target <windows-x64|linux-x64|linux-arm64|darwin-x64|darwin-arm64> --out <dir> [--bun-version x.y.z]
 *     [--third-party <list.json>]...
 *
 * Writes <out>/AgentHydra-<version>-<target>/ and its archive beside it (Windows also gets the lone
 * exe, which is the same launcher, unless release-channel.json says updates are off). No Bun and no Claude Code binary ship: the daemon is plain JS
 * (scripts/build.ts --bundle, whose app/bun-version is the pin, the running Bun.version unless
 * --bun-version says otherwise) beside a small launcher that downloads that Bun on first run. Desk 2
 * ships as source plus production node_modules and runs on the launcher's Bun; the Agent SDK is left out of those
 * and Desk fetches the version desk2/sdk-pin.json names the first time a chat needs it. Needs
 * desk2/web/dist and desk2/hydra/dist already built; it never builds them and never writes into the
 * checkout.
 *
 * Every bundle carries THIRD-PARTY-LICENSES (scripts/third-party-licenses.ts): the npm packages bun inlined, Desk's
 * node_modules, what vite built into the dists, and the crates of the Rust programs it holds, read with `cargo
 * metadata`. A machine without cargo passes --third-party instead: the list `scripts/third-party-licenses.ts --cargo
 * <crate>=<where it ships> --target x86_64-pc-windows-msvc --json <list.json>` wrote where they were built.
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { RELEASE_CHANNEL } from '../server/src/release-channel'
import { findRepoRoot } from '../tests/repo-root'
import { buildLauncher } from './build-launcher'
import { writePosixLauncher } from './launcher-posix'
import {
  aliasedImports,
  bundleServerModules,
  pointAliasAtBundle,
  pruneNodeModules,
  SDK_PACKAGE,
  SDK_PIN_FILE,
  SERVER_ALIAS,
  SERVER_MODULES_DIR,
  sdkPinFromLock,
  sourceFilesUnder,
  stageLicenceFiles,
  unresolvedImports,
} from './release-bundle'
import {
  BUILT_LIST,
  cargoCrates,
  type Metafile,
  npmFromBuilt,
  npmFromMetafile,
  npmTree,
  readPackageList,
  renderThirdPartyLicenses,
  settleLicences,
  type ThirdPartyPackage,
} from './third-party-licenses'

const ROOT = findRepoRoot(import.meta.dir)
const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const TARGETS = ['windows-x64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']
const NODE_OS: Record<string, string> = { windows: 'win32', linux: 'linux', darwin: 'darwin' }
/** The Windows archive must stay a small download: Bun and Claude Code are fetched on first run. */
const WINDOWS_ARCHIVE_LIMIT = 30 * 1024 * 1024
const MISC_FILES = [
  'AgentHydra-Tray.exe',
  'AgentHydra-Tray.json',
  'AgentHydra.ico',
  'Create-Shortcut.ps1',
  'New-TrayShortcut.ps1',
  'Instance-Launch.vbs',
  'Tray-Host.ps1',
  'AgentHydra-Tray.ps1',
  'Tray-Launch.vbs',
]
/**
 * The Rust programs a bundle can carry, by crate, with every place each one lands: THIRD-PARTY-LICENSES lists the
 * crates of each one the staged bundle holds. All three are Windows programs, whatever the bundle's target.
 */
const NATIVE_PROGRAMS = [
  { crate: 'misc/climayte-runner-native', files: ['app/misc/climayte-runner.exe'] },
  {
    crate: 'misc/tray-host-native',
    files: ['misc/AgentHydra-Tray.exe', 'app/misc/AgentHydra-Tray.exe'],
  },
  { crate: 'desk2/launcher/host', files: ['desk2/launcher/HydraDesk2.exe'] },
]
const NATIVE_TARGET = 'x86_64-pc-windows-msvc'
const LAUNCHER_FILES = [
  'HydraDesk2.exe',
  'start.vbs',
  'start.ps1',
  'stop.ps1',
  'restart.ps1',
  'quit.ps1',
  'install-shortcuts.ps1',
]

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Every value of a flag that may be given more than once. */
function args(name: string): string[] {
  return process.argv.flatMap((a, i) =>
    a === name && process.argv[i + 1] ? [process.argv[i + 1]!] : [],
  )
}

function fail(message: string): never {
  console.error(`package-release: ${message}`)
  process.exit(1)
}

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed (exit ${r.status ?? r.error})`)
}

function dirSize(path: string): number {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st) return 0
  if (!st.isDirectory()) return st.size
  return readdirSync(path).reduce((sum, name) => sum + dirSize(join(path, name)), 0)
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function removePycache(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = join(dir, e.name)
    if (e.name === '__pycache__') rmSync(p, { recursive: true, force: true })
    else removePycache(p)
  }
}

function trackedFiles(dir: string): string[] {
  const r = spawnSync('git', ['ls-files', '-z', '--', dir], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) fail(`git ls-files ${dir} failed`)
  return r.stdout.split('\0').filter(Boolean)
}

// Source the bundle never needs: tests, e2e, scratch, the window host's Rust project, the Vue sources
// (their dist ships), and the launcher (staged by name on Windows only).
const DESK2_SKIP = [
  /^desk2\/(e2e|tmp)\//,
  /^desk2\/launcher\//,
  /^desk2\/(web|hydra)\/src\//,
  /^desk2\/server\/test\//,
  /^desk2\/web\/test\//,
  /\.test\.tsx?$/,
]

function stageTracked(dir: string, stage: string, skip: RegExp[] = []): void {
  for (const rel of trackedFiles(dir)) {
    if (skip.some((re) => re.test(rel))) continue
    const src = join(ROOT, rel)
    if (!existsSync(src)) continue
    const dest = join(stage, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
  }
}

function installArgs(target: string, hostTarget: string, frozen: boolean): string[] {
  const args = ['install', '--production', '--linker', 'hoisted']
  if (frozen) args.push('--frozen-lockfile')
  if (target !== hostTarget) {
    const [os, cpu] = target.split('-')
    args.push('--os', NODE_OS[os], '--cpu', cpu)
  }
  return args
}

type Json = Record<string, unknown>

/** The exact version bun.lock resolved for a package name ("hono": ["hono@4.13.12", ...]). */
function lockedVersion(lock: string, dep: string): string | undefined {
  const esc = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return lock.match(new RegExp(`"${esc}": \\["${esc}@([^"]+)"`))?.[1]
}

function pinDeps(deps: unknown, lock: string): unknown {
  if (!deps) return deps
  return Object.fromEntries(
    Object.entries(deps as Record<string, string>).map(([k, v]) => [
      k,
      lockedVersion(lock, k) ?? v,
    ]),
  )
}

/**
 * Install only what runs: the staged tree keeps the `server` workspace and drops the others (web,
 * hydra: their dists ship prebuilt) and every devDependency. Tries the frozen lockfile first; bun
 * refuses it when the workspaces differ from the lock, so then it pins each server dependency to the
 * version bun.lock resolved, drops the lock and installs.
 */
function installServerOnly(dir: string, target: string, hostTarget: string): void {
  for (const w of ['web', 'hydra']) rmSync(join(dir, w, 'package.json'), { force: true })
  const pkgPath = join(dir, 'package.json')
  const serverPath = join(dir, 'server/package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Json
  pkg.workspaces = ['server']
  delete pkg.devDependencies
  delete pkg.scripts
  writeFileSync(
    pkgPath,
    `${JSON.stringify(pkg, null, 2)}
`,
  )
  const server = JSON.parse(readFileSync(serverPath, 'utf8')) as Json
  delete server.devDependencies
  writeFileSync(
    serverPath,
    `${JSON.stringify(server, null, 2)}
`,
  )

  const frozen = spawnSync(process.execPath, installArgs(target, hostTarget, true), {
    cwd: dir,
    stdio: 'inherit',
  })
  if (frozen.status === 0) return
  console.log(`frozen install of ${dir} refused; pinning server dependencies from bun.lock`)
  const lockPath = join(dir, 'bun.lock')
  const lock = readFileSync(lockPath, 'utf8')
  for (const [file, json] of [
    [pkgPath, pkg],
    [serverPath, server],
  ] as const) {
    for (const key of ['dependencies', 'optionalDependencies'])
      if (json[key]) json[key] = pinDeps(json[key], lock)
    writeFileSync(
      file,
      `${JSON.stringify(json, null, 2)}
`,
    )
  }
  rmSync(lockPath, { force: true })
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
  run(process.execPath, installArgs(target, hostTarget, false), dir)
}

const target = arg('--target')
const outArg = arg('--out')
const bunVersion = (arg('--bun-version') ?? Bun.version).trim()
if (!target || !TARGETS.includes(target)) fail(`--target must be one of ${TARGETS.join(', ')}`)
if (!outArg) fail('--out <dir> is required')
if (!/^\d+\.\d+\.\d+$/.test(bunVersion)) fail(`--bun-version must be x.y.z, got ${bunVersion}`)
const out = resolve(outArg)
const isWindows = target === 'windows-x64'
const platform = process.platform === 'win32' ? 'windows' : process.platform
const hostTarget = `${platform}-${process.arch}`
// Windows has no execute bit to put in a tar, so a POSIX bundle packaged there ships an `agenthydra`
// that will not start ("Permission denied"). release.yml packages those targets on Linux.
if (!isWindows && process.platform === 'win32')
  fail(`${target} must be packaged on Linux or macOS: Windows cannot mark the launcher executable`)

for (const dist of ['desk2/web/dist', 'desk2/hydra/dist']) {
  if (!existsSync(join(ROOT, dist, 'index.html'))) {
    fail(
      `${dist} is missing: run \`bun run build\` in desk2/ first (this script does not build it)`,
    )
  }
}

const name = `AgentHydra-${VERSION}-${target}`
const stage = join(out, name)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
console.log(`Packaging AgentHydra ${VERSION} for ${target} into ${stage} (Bun ${bunVersion})`)
// What the MIT licence asks of every copy, at the top of every bundle: the licence itself, NOTICE (where this
// project comes from), the notices for the code AgentHydra adapts from other projects, and the licence texts those
// notices point to.
stageLicenceFiles(ROOT, stage)
// The build metafiles the licence list is read from live outside the bundle.
const scratch = mkdtempSync(join(tmpdir(), 'package-release-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
const daemonMetafile = join(scratch, 'server.metafile.json')

// The daemon as app/ (server.js, its misc assets, release.json and bun-version, the pin the launcher
// downloads), then the launcher that runs it.
run(
  process.execPath,
  [
    'scripts/build.ts',
    '--bundle',
    '--target',
    target,
    '--outdir',
    stage,
    '--bun-version',
    bunVersion,
    '--metafile',
    daemonMetafile,
  ],
  ROOT,
)
if (readFileSync(join(stage, 'app/bun-version'), 'utf8').trim() !== bunVersion)
  fail('app/bun-version does not hold the pin')
const launcher = join(stage, isWindows ? 'AgentHydra.exe' : 'agenthydra')
if (isWindows) {
  await buildLauncher({ outfile: launcher, version: VERSION })
  // The lone .exe installs the rest from its own version's archive the first time it runs. A launcher whose channel
  // says updates are off downloads no part of AgentHydra, not even that, so on its own it could only stop and say so: while the
  // channel is off the zip is the Windows download, and no lone .exe is made.
  if (RELEASE_CHANNEL.updates !== 'off') copyFileSync(launcher, join(out, `${name}.exe`))
} else {
  writePosixLauncher({ outfile: launcher, version: VERSION })
}
// Ship the managed-Hub installer in each macOS release so operators need no source checkout.
if (target.startsWith('darwin-')) {
  copyFileSync(join(ROOT, 'scripts/install-hub-macos.sh'), join(stage, 'install-hub-macos.sh'))
}

if (target === hostTarget) {
  const v = spawnSync(launcher, ['--version'], { cwd: ROOT, encoding: 'utf8' })
  const printed = (v.stdout ?? '').trim()
  if (v.error) fail(`${launcher} --version did not run: ${v.error.message}`)
  if (v.status !== 0 || printed !== VERSION)
    fail(`${launcher} --version exited ${v.status} printing "${printed}", expected ${VERSION}`)
}

// The orchestrator's python half: never tests, bytecode or state.
const orch = join(stage, 'orchestrator')
mkdirSync(orch)
for (const f of ['orch.py', 'orch_cli.py', 'README.md'])
  copyFileSync(join(ROOT, 'orchestrator', f), join(orch, f))
cpSync(join(ROOT, 'orchestrator/scripts'), join(orch, 'scripts'), { recursive: true })
cpSync(join(ROOT, 'orchestrator/docs'), join(orch, 'docs'), { recursive: true })
rmSync(join(orch, 'scripts/tests'), { recursive: true, force: true })
removePycache(orch)

// Desk 2: tracked source, the built dists and production node_modules; it runs on the launcher's Bun.
const desk2 = join(stage, 'desk2')
stageTracked('desk2', stage, DESK2_SKIP)
// The window's What's new pop-up reads the changelog the release ships (desk2/server/src/changelog.ts).
copyFileSync(join(ROOT, 'CHANGELOG.md'), join(desk2, 'CHANGELOG.md'))
for (const dist of ['web/dist', 'hydra/dist']) {
  cpSync(join(ROOT, 'desk2', dist), join(desk2, dist), { recursive: true })
}
installServerOnly(desk2, target, hostTarget)

// The Agent SDK's licence reserves all rights, so the bundle does not carry it: it carries the pin of the version
// desk2/bun.lock resolved instead, and Desk downloads exactly that tarball, checked against its sha512, the first time
// a chat needs it (desk2/server/src/host/sdk-package.ts).
const sdkInstalled = join(desk2, 'node_modules', ...SDK_PACKAGE.split('/'), 'package.json')
if (!existsSync(sdkInstalled)) fail(`the install put no ${SDK_PACKAGE} in desk2/node_modules`)
let sdkPin: ReturnType<typeof sdkPinFromLock>
try {
  sdkPin = sdkPinFromLock(
    readFileSync(join(ROOT, 'desk2', 'bun.lock'), 'utf8'),
    JSON.parse(readFileSync(sdkInstalled, 'utf8')),
  )
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
pruneNodeModules(join(desk2, 'node_modules'))
if (existsSync(dirname(sdkInstalled)))
  fail(`${SDK_PACKAGE} is still in desk2/node_modules after pruning`)
writeFileSync(join(desk2, SDK_PIN_FILE), `${JSON.stringify(sdkPin, null, 2)}\n`)
console.log(
  `left ${SDK_PACKAGE} out; desk2/${SDK_PIN_FILE} pins ${sdkPin.version} for Desk to fetch`,
)

// Desk's server runs some of the daemon's own modules, imported as @agenthydra/server/<path> (desk2/tsconfig.base.json
// maps that to the checkout's server/src). A bundle has no server/src, so those modules are bundled into
// desk2/agenthydra-server/ and the staged alias points there. Then every import of desk2/server/src must resolve inside
// the staged tree: a plugin whose import fails is skipped at boot with only a log line, which is how a bundle once lost
// its whole engine.
const serverImports = aliasedImports(sourceFilesUnder(join(desk2, 'server', 'src')))
const serverModulesMeta = await bundleServerModules(ROOT, desk2, serverImports)
pointAliasAtBundle(join(desk2, 'tsconfig.base.json'))
console.log(
  `bundled ${serverImports.length} ${SERVER_ALIAS}* module(s) into desk2/${SERVER_MODULES_DIR}/: ${serverImports.join(', ')}`,
)
const unresolved = unresolvedImports(join(desk2, 'server', 'src'), [SDK_PACKAGE])
if (unresolved.length)
  fail(`desk2/server/src has imports the bundle cannot resolve:\n  ${unresolved.join('\n  ')}`)

if (isWindows) {
  const deskLauncher = join(desk2, 'launcher')
  mkdirSync(deskLauncher)
  for (const f of LAUNCHER_FILES)
    copyFileSync(join(ROOT, 'desk2/launcher', f), join(deskLauncher, f))
}

if (isWindows) {
  mkdirSync(join(stage, 'misc'))
  for (const f of MISC_FILES) copyFileSync(join(ROOT, 'misc', f), join(stage, 'misc', f))
}

// THIRD-PARTY-LICENSES: every third-party package whose code the bundle holds, with its licence and text. A package
// with no licence, one off the allowlist or no text fails the build here, before anything is archived.
const licences: ThirdPartyPackage[][] = [
  npmFromMetafile(JSON.parse(readFileSync(daemonMetafile, 'utf8')) as Metafile, ROOT, [
    'app/server.js',
  ]),
  npmFromMetafile(serverModulesMeta, ROOT, [`desk2/${SERVER_MODULES_DIR}`]),
  npmTree(join(desk2, 'node_modules'), ['desk2/node_modules']),
]
for (const app of ['web', 'hydra']) {
  const list = join(ROOT, 'desk2', app, 'dist', BUILT_LIST)
  if (!existsSync(list))
    fail(
      `desk2/${app}/dist has no ${BUILT_LIST}, the list of the packages its build put in it: rebuild it (\`bun run build\` in desk2/)`,
    )
  licences.push(npmFromBuilt(list, join(ROOT, 'desk2', app), [`desk2/${app}/dist`]))
  // The list is for this file; the window does not need it.
  rmSync(join(desk2, app, 'dist', dirname(BUILT_LIST)), { recursive: true, force: true })
}
const natives = NATIVE_PROGRAMS.map((p) => ({
  ...p,
  shipped: p.files.filter((f) => existsSync(join(stage, f))),
})).filter((p) => p.shipped.length)
const givenLists = args('--third-party')
if (givenLists.length) {
  const given = givenLists.flatMap((f) => readPackageList(resolve(f)))
  const unlisted = natives
    .flatMap((p) => p.shipped)
    .filter((f) => !given.some((g) => g.shippedIn.includes(f)))
  if (unlisted.length) fail(`--third-party lists nothing shipped in ${unlisted.join(', ')}`)
  licences.push(given)
} else {
  for (const p of natives) {
    try {
      licences.push(cargoCrates(join(ROOT, p.crate), p.shipped, NATIVE_TARGET))
    } catch (err) {
      fail(
        `the licences of ${p.shipped.join(', ')} could not be read from ${p.crate}: ${err instanceof Error ? err.message : String(err)}\n` +
          'packaging reads them with cargo; on a machine without it, pass --third-party <list.json> written by ' +
          `scripts/third-party-licenses.ts --cargo <crate>=<where it ships> --target ${NATIVE_TARGET} --json <list.json>`,
      )
    }
  }
}
const settled = await settleLicences(licences)
if (settled.problems.length)
  fail(
    `${settled.problems.length} third-party package(s) cannot ship:\n  ${settled.problems.join('\n  ')}`,
  )
writeFileSync(
  join(stage, 'THIRD-PARTY-LICENSES'),
  renderThirdPartyLicenses(settled.packages, `AgentHydra ${VERSION} for ${target}`),
)
console.log(`THIRD-PARTY-LICENSES lists ${settled.packages.length} third-party package(s)`)

const archive = join(out, isWindows ? `${name}.zip` : `${name}.tar.gz`)
rmSync(archive, { force: true })
if (isWindows) {
  // 7-Zip is often installed without being on PATH; Compress-Archive takes over six minutes on this bundle.
  const sevenZipCandidates = [
    '7z',
    ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter((dir): dir is string => !!dir)
      .map((dir) => join(dir, '7-Zip', '7z.exe')),
  ]
  const sevenZip = sevenZipCandidates.find(
    (exe) => !spawnSync(exe, ['i'], { stdio: 'ignore' }).error,
  )
  if (sevenZip) {
    run(sevenZip, ['a', '-tzip', archive, name], out)
  } else {
    run(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -LiteralPath '${stage}' -DestinationPath '${archive}'`,
      ],
      out,
    )
  }
} else {
  run('tar', ['-czf', archive, name], out)
}

const deskModules = dirSize(join(desk2, 'node_modules'))
const sizes = {
  launcher: dirSize(launcher),
  'app (daemon)': dirSize(join(stage, 'app')),
  'desk2 node_modules': deskModules,
  'desk2 server modules': dirSize(join(desk2, SERVER_MODULES_DIR)),
  'desk2 dists': dirSize(join(desk2, 'web/dist')) + dirSize(join(desk2, 'hydra/dist')),
  'desk2 other':
    dirSize(desk2) -
    deskModules -
    dirSize(join(desk2, SERVER_MODULES_DIR)) -
    dirSize(join(desk2, 'web/dist')) -
    dirSize(join(desk2, 'hydra/dist')),
  orchestrator: dirSize(orch),
  misc: dirSize(join(stage, 'misc')),
}
console.log(`
Bundle size (${name}):`)
for (const [k, v] of Object.entries(sizes)) console.log(`  ${k.padEnd(20)} ${mb(v)}`)
console.log(`  ${'folder total'.padEnd(20)} ${mb(dirSize(stage))}`)
console.log(`  ${'archive'.padEnd(20)} ${mb(statSync(archive).size)}  ${archive}`)
if (isWindows && statSync(archive).size > WINDOWS_ARCHIVE_LIMIT)
  fail(
    `the Windows archive is ${mb(statSync(archive).size)}, over the ${mb(WINDOWS_ARCHIVE_LIMIT)} limit`,
  )
