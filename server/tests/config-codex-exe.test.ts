// server/tests/config-codex-exe.test.ts — finding the Codex CLI on a Mac or Linux PC whose PATH is minimal.
//
// launchd and systemd start the daemon or the pusher with a PATH that misses Homebrew and the user's own bins, so
// when PATH has no codex, resolveCodexExe (config.ts) checks those places by path, and codexSpawnEnv gives the codex
// it found a PATH on which npm's `#!/usr/bin/env node` launcher finds a node. The end-to-end cases run config in a
// child with a fake HOME under the suite's scratch folder: config reads HOME once, as it loads, and nothing here
// writes into a real one.
import { afterAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { codexSpawnEnv, posixCodexCandidates } from '../src/config'

const homes: string[] = []
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'ah-codex-exe-home-'))
  homes.push(home)
  return home
}

test('the install places are tried in order: Homebrew, the user bins, nvm, then the npm prefix', () => {
  expect(posixCodexCandidates('/home/me', {})).toEqual([
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/home/linuxbrew/.linuxbrew/bin/codex',
    '/home/me/.local/bin/codex',
    '/home/me/.npm-global/bin/codex',
    '/home/me/.bun/bin/codex',
    '/home/me/.volta/bin/codex',
  ])
  expect(posixCodexCandidates('/home/me', { npm_config_prefix: '/opt/npm' }).at(-1)).toBe(
    '/opt/npm/bin/codex',
  )
  expect(posixCodexCandidates('/home/me', { NPM_CONFIG_PREFIX: '/home/me/npm' }).at(-1)).toBe(
    '/home/me/npm/bin/codex',
  )
})

test.skipIf(process.platform === 'win32')('nvm node versions are tried newest first', () => {
  const home = fakeHome()
  for (const version of ['v9.11.2', 'v22.1.0', 'v20.10.0', 'v22.10.0', 'system'])
    mkdirSync(join(home, '.nvm', 'versions', 'node', version), { recursive: true })
  const nvm = (version: string) => join(home, '.nvm', 'versions', 'node', version, 'bin', 'codex')
  expect(posixCodexCandidates(home, {}).slice(-4)).toEqual([
    nvm('v22.10.0'),
    nvm('v22.1.0'),
    nvm('v20.10.0'),
    nvm('v9.11.2'),
  ])
  // NVM_DIR moves nvm's own folder.
  const elsewhere = join(home, 'nvm-elsewhere')
  mkdirSync(join(elsewhere, 'versions', 'node', 'v18.0.0'), { recursive: true })
  expect(posixCodexCandidates(home, { NVM_DIR: elsewhere }).at(-1)).toBe(
    join(elsewhere, 'versions', 'node', 'v18.0.0', 'bin', 'codex'),
  )
})

test.skipIf(process.platform === 'win32')(
  "a codex named by path runs with its own folder ahead of PATH and node's usual places after",
  () => {
    const home = fakeHome()
    const bin = join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin')
    const launcher = join(bin, '..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    mkdirSync(dirname(launcher), { recursive: true })
    mkdirSync(bin, { recursive: true })
    writeFileSync(launcher, '#!/usr/bin/env node\n', { mode: 0o755 })
    symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', join(bin, 'codex'))
    const realDir = dirname(realpathSync(launcher))
    const fallbacks = [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/home/linuxbrew/.linuxbrew/bin',
      join(home, '.volta', 'bin'),
    ]

    expect(codexSpawnEnv(join(bin, 'codex'), { PATH: '/usr/bin:/bin', KEEP: 'x' }, home)).toEqual({
      PATH: [bin, realDir, '/usr/bin', '/bin', ...fallbacks].join(':'),
      KEEP: 'x',
    })
    // A folder PATH already has keeps its place, ahead of or behind the rest.
    expect(
      codexSpawnEnv(join(bin, 'codex'), { PATH: `/usr/local/bin:/usr/bin:${bin}` }, home).PATH,
    ).toBe(
      [
        realDir,
        '/usr/local/bin',
        '/usr/bin',
        bin,
        '/opt/homebrew/bin',
        '/home/linuxbrew/.linuxbrew/bin',
        join(home, '.volta', 'bin'),
      ].join(':'),
    )
    // With no PATH at all, the system's default one is kept rather than replaced.
    expect(codexSpawnEnv(join(bin, 'codex'), {}, home).PATH).toBe(
      [bin, realDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin', ...fallbacks].join(':'),
    )
    // A bare `codex` is PATH's to find, and starts in the environment as it is.
    const env = { PATH: '/usr/bin:/bin' }
    expect(codexSpawnEnv('codex', env, home)).toBe(env)
  },
)

// A machine with a codex in a system place, or on the minimal PATH, would answer that one ahead of the fake home's.
const systemCodex = [
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '/home/linuxbrew/.linuxbrew/bin/codex',
  '/usr/bin/codex',
  '/bin/codex',
].some((p) => existsSync(p))
const MINIMAL_PATH = '/usr/bin:/bin'

/** Runs `code` in a bun child whose HOME is `home` and PATH is minimal; answers its stdout. */
function runInHome(home: string, code: string, extra: Record<string, string> = {}): string {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    PATH: MINIMAL_PATH,
    ...extra,
  }
  for (const name of [
    'AGENTHYDRA_CODEX_PATH',
    'CCMANAGERUI_CODEX_PATH',
    'npm_config_prefix',
    'NPM_CONFIG_PREFIX',
    'NVM_DIR',
  ])
    if (!(name in extra)) delete env[name]
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env, timeout: 30_000 })
  expect(r.stderr).toBe('')
  return r.stdout.trim()
}
const src = (file: string) => JSON.stringify(join(import.meta.dir, '..', 'src', file))

test.skipIf(process.platform === 'win32' || systemCodex)(
  'with no codex on PATH, the one in the home is found; one on PATH still wins',
  () => {
    const home = fakeHome()
    const resolve = (extra: Record<string, string> = {}) =>
      runInHome(home, `console.log((await import(${src('config.ts')})).resolveCodexExe())`, extra)
    const install = (path: string) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '#!/bin/sh\n', { mode: 0o755 })
      return path
    }

    expect(resolve()).toBe('codex')
    const prefix = install(join(home, 'npm-prefix', 'bin', 'codex'))
    expect(resolve({ npm_config_prefix: join(home, 'npm-prefix') })).toBe(prefix)
    const nvm = install(join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin', 'codex'))
    expect(resolve({ npm_config_prefix: join(home, 'npm-prefix') })).toBe(nvm)
    const bun = install(join(home, '.bun', 'bin', 'codex'))
    expect(resolve()).toBe(bun)
    const npm = install(join(home, '.npm-global', 'bin', 'codex'))
    expect(resolve()).toBe(npm)
    const local = install(join(home, '.local', 'bin', 'codex'))
    expect(resolve({ npm_config_prefix: join(home, 'npm-prefix') })).toBe(local)
    // A codex on PATH is the one the person's own `codex` runs, and is used ahead of all of them.
    install(join(home, 'on-path', 'codex'))
    expect(resolve({ PATH: `${join(home, 'on-path')}:${MINIMAL_PATH}` })).toBe('codex')
    // AGENTHYDRA_CODEX_PATH still wins over everything.
    expect(resolve({ AGENTHYDRA_CODEX_PATH: '/opt/codex/bin/codex' })).toBe('/opt/codex/bin/codex')
  },
  60_000,
)

test.skipIf(process.platform === 'win32' || systemCodex)(
  "npm's `#!/usr/bin/env node` codex starts under a minimal PATH, with the node installed beside it",
  () => {
    const home = fakeHome()
    // An npm install under nvm: bin/codex links to the package's launcher, and bin/node is the node npm ran on.
    // Here that node is this bun, which says so, so a node elsewhere on the machine cannot pass for it.
    const bin = join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin')
    const launcher = join(bin, '..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    mkdirSync(dirname(launcher), { recursive: true })
    writeFileSync(
      launcher,
      `#!/usr/bin/env node
      const { createInterface } = require('node:readline')
      createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line)
        if (message.id === undefined) return
        const result = { bun: typeof Bun !== 'undefined', path: process.env.PATH, args: process.argv.slice(2) }
        process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n')
      })
      `,
      { mode: 0o755 },
    )
    mkdirSync(bin)
    symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', join(bin, 'codex'))
    symlinkSync(process.execPath, join(bin, 'node'))
    const codexHome = join(home, '.codex')
    mkdirSync(codexHome)

    const out = runInHome(
      home,
      `const { resolveCodexExe } = await import(${src('config.ts')})
      const { connectCodexRpc } = await import(${src('core/codex-rpc.ts')})
      const rpc = await connectCodexRpc(${JSON.stringify(codexHome)})
      console.log(JSON.stringify({ exe: resolveCodexExe(), result: await rpc.call('probe') }))
      await rpc.close()`,
    )
    const { exe, result } = JSON.parse(out) as {
      exe: string
      result: { bun: boolean; path: string; args: string[] }
    }
    expect(exe).toBe(join(bin, 'codex'))
    expect(result.bun).toBe(true)
    expect(result.args).toEqual(['app-server'])
    expect(result.path.split(':').slice(0, 4)).toEqual([
      bin,
      dirname(realpathSync(launcher)),
      '/usr/bin',
      '/bin',
    ])
  },
  60_000,
)
