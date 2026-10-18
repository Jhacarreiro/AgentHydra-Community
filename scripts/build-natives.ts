#!/usr/bin/env bun
/**
 * Build the three Windows programs AgentHydra runs, from their Rust source in this repository, into the
 * places the app looks for them (or under --out). The same script runs on a PC and in CI:
 * .github/workflows/natives.yml builds all three on every change to their source, ci.yml builds the two
 * the Windows tests start, and release.yml builds the ones each Windows bundle ships.
 *
 *   tray     misc/AgentHydra-Tray.exe        the tray host               misc/tray-host-native
 *   runner   misc/climayte-runner.exe        CliMayte's worker runner    misc/climayte-runner-native
 *   window   desk2/launcher/HydraDesk2.exe   AgentHydra's window host    desk2/launcher/host
 *
 *   bun scripts/build-natives.ts [tray] [runner] [window] [--test] [--out <dir>] [--target <triple>]
 *
 * None of the three is committed (.gitignore): each is built from the source beside it, so what runs is
 * what that source says. They were committed exes until 2026-10, and nothing recorded how they had been
 * built; the tray's was older than its own source.
 *
 * What makes two builds of the same source with the same tools the same bytes, whatever folder or PC:
 * - each crate's rust-toolchain.toml pins the Rust release (rustup installs it here when it is missing);
 * - --locked: the crates in each Cargo.lock and nothing newer;
 * - every machine path rustc would write into a panic message is remapped (the crate's folder to its path
 *   in this repository, CARGO_HOME to `cargo`, RUSTUP_HOME to `rustup`), and the build refuses an exe that
 *   still names one, as the runner's own build script did before this one;
 * - the MSVC linker gets /Brepro, so the PE timestamp and debug ids are a hash of the content instead of
 *   the time of the build (GNU ld, for a check build, gets --no-insert-timestamp).
 * The MSVC build tools are the one input not pinned here: the linker writes its version into the program,
 * so a PC build matches CI's hash only with the Visual Studio build tools of CI's runner image.
 *
 * --test runs each crate's own tests first (on Windows only: they are Windows programs).
 * --out <dir> writes each exe under <dir> at its path in the checkout, plus <dir>/natives.sha256 in
 *   sha256sum's format, and leaves the checkout alone.
 * --target defaults to x86_64-pc-windows-msvc, which is what ships. x86_64-pc-windows-gnu (with mingw-w64)
 *   also builds on Linux, to check that the source compiles; such an exe is not what ships.
 *
 * Needs cargo (https://rustup.rs) and, for the MSVC target, Visual Studio's C++ build tools: the linker,
 * and the Windows SDK's rc.exe for the window's icon. A source checkout without them still runs: the
 * tray shortcut falls back to the PowerShell tray (misc/Create-Shortcut.ps1), the window opens in the
 * browser (desk2/launcher/start.ps1) and CliMayte's workers run under Bun (server/src/climayte-runner.ts).
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { findRepoRoot } from '../tests/repo-root'

export interface NativeProgram {
  /** What the command line calls it. */
  name: 'tray' | 'runner' | 'window'
  /** The crate's folder, relative to the repository root. */
  crate: string
  /** The [[bin]] cargo builds (target/<triple>/release/<bin>.exe). */
  bin: string
  /** Where the app looks for it, relative to the repository root: the checkout, and a Windows bundle. */
  dest: string
  what: string
}

export const NATIVE_PROGRAMS: readonly NativeProgram[] = [
  {
    name: 'tray',
    crate: 'misc/tray-host-native',
    bin: 'lunarwerx-tray',
    dest: 'misc/AgentHydra-Tray.exe',
    what: 'the tray host',
  },
  {
    name: 'runner',
    crate: 'misc/climayte-runner-native',
    bin: 'climayte-runner',
    dest: 'misc/climayte-runner.exe',
    what: "CliMayte's worker runner",
  },
  {
    name: 'window',
    crate: 'desk2/launcher/host',
    bin: 'HydraDesk2',
    dest: 'desk2/launcher/HydraDesk2.exe',
    what: "AgentHydra's window host",
  },
]

export const DEFAULT_TARGET = 'x86_64-pc-windows-msvc'

/** The file --out writes beside the exes: `<sha256>  <dest>` per program, as sha256sum prints it. */
export const SUMS_FILE = 'natives.sha256'

/** The Rust release a crate's rust-toolchain.toml pins. */
export function pinnedToolchain(crateDir: string): string {
  const text = readFileSync(join(crateDir, 'rust-toolchain.toml'), 'utf8')
  const channel = text.match(/^\s*channel\s*=\s*"([^"]+)"/m)?.[1]
  // An exact release: "stable" or "1.97" would be a different compiler next month.
  if (!channel || !/^\d+\.\d+\.\d+$/.test(channel))
    throw new Error(`${crateDir}/rust-toolchain.toml does not pin an exact Rust release (x.y.z).`)
  return channel
}

export interface FlagInputs {
  root: string
  crate: string
  cargoHome: string
  rustupHome: string
  target: string
}

/**
 * The rustc flags of a reproducible build, in order. rustc applies the LAST remap whose prefix matches,
 * so the crate's own folder comes after the homes: a checkout under a home folder still reads as its
 * path in the repository.
 */
export function rustFlags({ root, crate, cargoHome, rustupHome, target }: FlagInputs): string[] {
  const flags = [
    `--remap-path-prefix=${cargoHome}=cargo`,
    `--remap-path-prefix=${rustupHome}=rustup`,
    `--remap-path-prefix=${join(root, crate)}=${crate}`,
  ]
  if (target.endsWith('-windows-msvc')) flags.push('-Clink-arg=/Brepro')
  // GNU ld's own switch for the same timestamp, so a check build compares too.
  if (target.endsWith('-windows-gnu')) flags.push('-Clink-arg=-Wl,--no-insert-timestamp')
  return flags
}

/**
 * The first of `paths` that `bytes` still names, in UTF-16 or in single bytes, ignoring case and which
 * slash it uses; null when none. A path under four characters is skipped: it would match by chance.
 */
export function namedPath(bytes: Uint8Array, paths: string[]): string | null {
  const buf = Buffer.from(bytes)
  const texts = [
    buf.toString('latin1'),
    buf.toString('utf16le'),
    buf.subarray(1).toString('utf16le'),
  ].map((t) => t.toLowerCase())
  for (const path of paths) {
    if (path.length < 4) continue
    const forms = new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')])
    for (const form of forms) {
      const needle = form.toLowerCase()
      if (texts.some((t) => t.includes(needle))) return path
    }
  }
  return null
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

export interface BuildNativesOptions {
  names?: string[]
  /** Write under this folder instead of into the checkout. */
  out?: string
  target?: string
  test?: boolean
  log?: (line: string) => void
}

export interface BuiltNative {
  program: NativeProgram
  path: string
  sha256: string
  bytes: number
}

/** The programs `names` asks for, in table order; all of them when it is empty. */
export function selectPrograms(names: string[] = []): NativeProgram[] {
  const unknown = names.filter((n) => !NATIVE_PROGRAMS.some((p) => p.name === n))
  if (unknown.length > 0)
    throw new Error(
      `No native program called ${unknown.join(', ')}: the names are ${NATIVE_PROGRAMS.map((p) => p.name).join(', ')}.`,
    )
  return NATIVE_PROGRAMS.filter((p) => names.length === 0 || names.includes(p.name))
}

/** Why this machine cannot build the MSVC target, or null when it can try. */
export function cannotBuild(
  target: string,
  platform = process.platform,
  which: (cmd: string) => string | null = Bun.which,
): string | null {
  if (!which('cargo'))
    return (
      'cargo is not installed. Install Rust with rustup (https://rustup.rs); the Rust release each ' +
      'program pins (its rust-toolchain.toml) is installed by this script on its first build. On Windows, ' +
      "rustup also offers Visual Studio's C++ build tools, which the linker and the window's icon need."
    )
  if (target.endsWith('-windows-msvc') && platform !== 'win32')
    return (
      `${target} builds on Windows: it needs Microsoft's linker and the Windows SDK. To check that the ` +
      'source compiles elsewhere, use --target x86_64-pc-windows-gnu (with mingw-w64 installed).'
    )
  return null
}

function run(argv: string[], cwd: string, env?: Record<string, string>): void {
  const r = Bun.spawnSync(argv, {
    cwd,
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')} (in ${cwd}) exited ${r.exitCode}`)
}

function output(argv: string[], cwd: string): string {
  const r = Bun.spawnSync(argv, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  return r.exitCode === 0 ? r.stdout.toString() : ''
}

/** The pinned Rust release with the target's standard library, installed through rustup when either is missing. */
function ensureToolchain(channel: string, target: string, cwd: string, log: (l: string) => void) {
  if (!Bun.which('rustup')) return // cargo without rustup: the toolchain file cannot be honoured, cargo says so
  const installed = output(['rustup', 'toolchain', 'list'], cwd)
    .split(/\r?\n/)
    .some((line) => line.startsWith(`${channel}-`))
  if (!installed) {
    log(`installing Rust ${channel} (${target}) with rustup`)
    run(
      [
        'rustup',
        'toolchain',
        'install',
        channel,
        '--profile',
        'minimal',
        '--target',
        target,
        '--no-self-update',
      ],
      cwd,
    )
    return
  }
  const targets = output(['rustup', 'target', 'list', '--installed', '--toolchain', channel], cwd)
  if (!targets.split(/\r?\n/).includes(target)) {
    log(`adding ${target} to Rust ${channel} with rustup`)
    run(['rustup', 'target', 'add', '--toolchain', channel, target], cwd)
  }
}

/**
 * Put `from` at `dest`, unless `dest` already holds the same bytes. Windows will not overwrite a running
 * exe (an open tray or window), but it does rename one: the running copy steps aside as
 * `<dest>.old-<pid>` and goes on running, and a later build removes it once it has exited.
 */
function place(from: string, dest: string, log: (l: string) => void): void {
  if (existsSync(dest) && sha256(readFileSync(dest)) === sha256(readFileSync(from))) return
  mkdirSync(dirname(dest), { recursive: true })
  const dir = dirname(dest)
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(`${basename(dest)}.old-`)) continue
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      // still running
    }
  }
  try {
    copyFileSync(from, dest)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw err
    const aside = `${dest}.old-${process.pid}`
    renameSync(dest, aside)
    copyFileSync(from, dest)
    log(`${dest} was running: that copy is now ${basename(aside)} until it exits`)
  }
}

export async function buildNatives({
  names = [],
  out,
  target = DEFAULT_TARGET,
  test = false,
  log = console.log,
}: BuildNativesOptions = {}): Promise<BuiltNative[]> {
  if (!/^[A-Za-z0-9_.-]+$/.test(target)) throw new Error(`"${target}" is not a target triple.`)
  const programs = selectPrograms(names)
  const why = cannotBuild(target)
  if (why) throw new Error(why)

  const root = findRepoRoot(import.meta.dir)
  const home = homedir()
  const cargoHome = resolve(process.env.CARGO_HOME || join(home, '.cargo'))
  const rustupHome = resolve(process.env.RUSTUP_HOME || join(home, '.rustup'))
  const built: BuiltNative[] = []
  for (const program of programs) {
    const crateDir = join(root, program.crate)
    const channel = pinnedToolchain(crateDir)
    ensureToolchain(channel, target, crateDir, log)
    const env = {
      // 0x1f between flags, so a path with a space stays one flag.
      CARGO_ENCODED_RUSTFLAGS: rustFlags({
        root,
        crate: program.crate,
        cargoHome,
        rustupHome,
        target,
      }).join('\x1f'),
    }
    log(`${program.name}: ${output(['rustc', '--version'], crateDir).trim() || `Rust ${channel}`}`)
    if (test) {
      if (process.platform === 'win32') run(['cargo', 'test', '--locked', '--quiet'], crateDir, env)
      else log(`${program.name}: tests skipped (they are Windows programs and run on Windows)`)
    }
    run(['cargo', 'build', '--release', '--locked', '--target', target], crateDir, env)
    const exe = join(crateDir, 'target', target, 'release', `${program.bin}.exe`)
    const bytes = readFileSync(exe)
    const named = namedPath(bytes, [root, crateDir, home, cargoHome, rustupHome])
    if (named) throw new Error(`${exe} still names ${named}: a path was not remapped.`)
    const dest = join(out ? resolve(out) : root, program.dest)
    place(exe, dest, log)
    built.push({ program, path: dest, sha256: sha256(bytes), bytes: statSync(dest).size })
  }
  if (out) {
    writeFileSync(
      join(resolve(out), SUMS_FILE),
      built.map((b) => `${b.sha256}  ${b.program.dest}\n`).join(''),
    )
  }
  return built
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index >= 0) return process.argv[index + 1]
  return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const valued = new Set(['--out', '--target'])
  const names = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''))
  const target = option('--target') ?? DEFAULT_TARGET
  try {
    const built = await buildNatives({
      names,
      out: option('--out'),
      target,
      test: args.includes('--test'),
    })
    console.log('')
    for (const b of built) console.log(`${b.sha256}  ${b.program.dest}  (${b.bytes} bytes)`)
    const summary = process.env.GITHUB_STEP_SUMMARY
    if (summary) {
      const rows = built.map((b) => `| \`${b.program.dest}\` | \`${b.sha256}\` | ${b.bytes} |`)
      const table = [
        `### Native programs (${target})`,
        '',
        '| file | sha256 | bytes |',
        '|---|---|---|',
      ]
      writeFileSync(summary, `${[...table, ...rows].join('\n')}\n\n`, { flag: 'a' })
    }
  } catch (err) {
    console.error(`build-natives: ${(err as Error).message}`)
    process.exit(1)
  }
}
