// tests/build-natives.test.ts - the three Windows programs are built from this repository's source:
// scripts/build-natives.ts knows each one's crate and place, and every build pins the same Rust release
// and remaps every machine path.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cannotBuild,
  DEFAULT_TARGET,
  NATIVE_PROGRAMS,
  namedPath,
  pinnedToolchain,
  rustFlags,
  selectPrograms,
} from '../scripts/build-natives'
import { REPO_ROOT } from './repo-root'

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

describe('the programs', () => {
  test('are the tray host, the CliMayte runner and the window host, at the paths the app runs them from', () => {
    expect(NATIVE_PROGRAMS.map((p) => [p.name, p.dest])).toEqual([
      ['tray', 'misc/AgentHydra-Tray.exe'],
      ['runner', 'misc/climayte-runner.exe'],
      ['window', 'desk2/launcher/HydraDesk2.exe'],
    ])
  })

  test('each crate builds the bin the table names, from a lockfile', () => {
    for (const p of NATIVE_PROGRAMS) {
      const manifest = read(`${p.crate}/Cargo.toml`)
      const bin = /\[\[bin\]\][^[]*?name\s*=\s*"([^"]+)"/.exec(manifest)?.[1]
      const pkg = /\[package\][^[]*?name\s*=\s*"([^"]+)"/.exec(manifest)?.[1]
      expect(bin ?? pkg).toBe(p.bin)
      expect(existsSync(join(REPO_ROOT, p.crate, 'Cargo.lock'))).toBe(true)
    }
  })

  test('all three pin the same exact Rust release, with the shipped target', () => {
    const pins = NATIVE_PROGRAMS.map((p) => pinnedToolchain(join(REPO_ROOT, p.crate)))
    expect(new Set(pins).size).toBe(1)
    expect(pins[0]).toMatch(/^\d+\.\d+\.\d+$/)
    for (const p of NATIVE_PROGRAMS)
      expect(read(`${p.crate}/rust-toolchain.toml`)).toContain(`targets = ["${DEFAULT_TARGET}"]`)
  })

  test('a name the table does not have is refused, and the rest keep table order', () => {
    expect(() => selectPrograms(['tray', 'launcher'])).toThrow(/No native program called launcher/)
    expect(selectPrograms(['window', 'tray']).map((p) => p.name)).toEqual(['tray', 'window'])
    expect(selectPrograms().length).toBe(3)
  })
})

describe('a reproducible build', () => {
  const inputs = {
    root: 'C:\\Users\\me\\src\\AgentHydra',
    crate: 'misc/tray-host-native',
    cargoHome: 'C:\\Users\\me\\.cargo',
    rustupHome: 'C:\\Users\\me\\.rustup',
  }

  test('remaps both homes, then the crate (rustc applies the last remap that matches)', () => {
    const flags = rustFlags({ ...inputs, target: DEFAULT_TARGET })
    expect(flags.slice(0, 3)).toEqual([
      '--remap-path-prefix=C:\\Users\\me\\.cargo=cargo',
      '--remap-path-prefix=C:\\Users\\me\\.rustup=rustup',
      `--remap-path-prefix=${join(inputs.root, inputs.crate)}=misc/tray-host-native`,
    ])
  })

  test('tells the linker to stamp content, not the time', () => {
    expect(rustFlags({ ...inputs, target: 'x86_64-pc-windows-msvc' })).toContain(
      '-Clink-arg=/Brepro',
    )
    const gnu = rustFlags({ ...inputs, target: 'x86_64-pc-windows-gnu' })
    expect(gnu).toContain('-Clink-arg=-Wl,--no-insert-timestamp')
    expect(gnu).not.toContain('-Clink-arg=/Brepro')
  })

  test('finds a machine path left in an exe, in UTF-16 or single bytes, whatever its case or slashes', () => {
    const path = 'C:\\Users\\me\\.cargo'
    const ascii = Buffer.from('panicked at c:/users/ME/.cargo/registry/src/x.rs')
    const wide = Buffer.concat([
      Buffer.from([0]),
      Buffer.from('C:\\Users\\me\\.cargo\\x', 'utf16le'),
    ])
    expect(namedPath(ascii, [path])).toBe(path)
    expect(namedPath(wide, [path])).toBe(path)
    expect(namedPath(Buffer.from('cargo/registry/src/x.rs'), [path])).toBeNull()
    // Too short to mean anything: '/a' is in every binary.
    expect(namedPath(Buffer.from('/a/b'), ['/a'])).toBeNull()
  })
})

describe('before it builds', () => {
  test('says how to get cargo when there is none', () => {
    expect(cannotBuild(DEFAULT_TARGET, 'win32', () => null)).toContain('https://rustup.rs')
  })

  test('refuses the MSVC target off Windows, and names the check build instead', () => {
    const why = cannotBuild(DEFAULT_TARGET, 'linux', () => '/usr/bin/cargo')
    expect(why).toContain('x86_64-pc-windows-gnu')
    expect(cannotBuild('x86_64-pc-windows-gnu', 'linux', () => '/usr/bin/cargo')).toBeNull()
    expect(cannotBuild(DEFAULT_TARGET, 'win32', () => 'C:/cargo.exe')).toBeNull()
  })

  test('the command line refuses an unknown program without starting cargo', () => {
    const r = Bun.spawnSync([process.execPath, 'scripts/build-natives.ts', 'nonesuch'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.toString()).toContain('No native program called nonesuch')
  }, 20_000)
})
