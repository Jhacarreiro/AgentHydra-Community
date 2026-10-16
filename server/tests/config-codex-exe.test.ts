// server/tests/config-codex-exe.test.ts — finding the Codex CLI on a Mac or Linux PC whose PATH is minimal.
//
// launchd and systemd start the daemon or the pusher with a PATH that misses Homebrew and the user's own bins, so
// resolveCodexExe (config.ts) checks those places by path. The end-to-end case runs config in a child with a fake
// HOME under the suite's scratch folder: config reads HOME once, as it loads, and nothing here writes into a real one.
import { afterAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { posixCodexCandidates } from '../src/config'

const home = mkdtempSync(join(tmpdir(), 'ah-codex-exe-home-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

test('the install places are tried in order: Homebrew, the user bins, then the npm prefix', () => {
  expect(posixCodexCandidates('/home/me', {})).toEqual([
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/home/me/.local/bin/codex',
    '/home/me/.npm-global/bin/codex',
    '/home/me/.bun/bin/codex',
  ])
  expect(posixCodexCandidates('/home/me', { npm_config_prefix: '/opt/npm' }).at(-1)).toBe(
    '/opt/npm/bin/codex',
  )
  expect(posixCodexCandidates('/home/me', { NPM_CONFIG_PREFIX: '/home/me/npm' }).at(-1)).toBe(
    '/home/me/npm/bin/codex',
  )
})

// A machine with a system-wide codex would answer that one ahead of the fake home's.
const systemCodex = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'].some((p) => existsSync(p))

test.skipIf(process.platform === 'win32' || systemCodex)(
  'with no codex on PATH, the one in the home is found',
  () => {
    const resolve = (extra: Record<string, string> = {}) => {
      const env: Record<string, string | undefined> = { ...process.env, HOME: home, ...extra }
      for (const name of [
        'AGENTHYDRA_CODEX_PATH',
        'CCMANAGERUI_CODEX_PATH',
        'npm_config_prefix',
        'NPM_CONFIG_PREFIX',
      ])
        if (!(name in extra)) delete env[name]
      const config = JSON.stringify(join(import.meta.dir, '..', 'src', 'config.ts'))
      const r = spawnSync(
        process.execPath,
        ['-e', `console.log((await import(${config})).resolveCodexExe())`],
        { encoding: 'utf8', env, timeout: 30_000 },
      )
      expect(r.stderr).toBe('')
      return r.stdout.trim()
    }
    const install = (path: string) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '#!/bin/sh\n', { mode: 0o755 })
      return path
    }

    expect(resolve()).toBe('codex')
    const prefix = install(join(home, 'npm-prefix', 'bin', 'codex'))
    expect(resolve({ npm_config_prefix: join(home, 'npm-prefix') })).toBe(prefix)
    const bun = install(join(home, '.bun', 'bin', 'codex'))
    expect(resolve()).toBe(bun)
    const npm = install(join(home, '.npm-global', 'bin', 'codex'))
    expect(resolve()).toBe(npm)
    const local = install(join(home, '.local', 'bin', 'codex'))
    expect(resolve({ npm_config_prefix: join(home, 'npm-prefix') })).toBe(local)
    // AGENTHYDRA_CODEX_PATH still wins over all of them.
    expect(resolve({ AGENTHYDRA_CODEX_PATH: '/opt/codex/bin/codex' })).toBe('/opt/codex/bin/codex')
  },
  60_000,
)
