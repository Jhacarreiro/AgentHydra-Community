// Desk starts the Codex AgentHydra's daemon starts (server/src/config.ts resolveCodexExe): on a Mac or Linux PC that
// runs AgentHydra as a service, PATH is launchd's or systemd's, with no codex on it, so the install places are checked
// by path, and the codex found there starts with its own folder ahead of PATH (codexSpawnEnv), where npm's
// `#!/usr/bin/env node` launcher finds the node installed beside it. Config reads HOME once, as it loads, so the case
// runs in a child whose HOME is a scratch folder; nothing here writes into a real one.

import { afterAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const homes: string[] = []
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

// A machine with a codex in a system place, or on the minimal PATH, would answer that one ahead of the scratch home's.
const systemCodex = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/home/linuxbrew/.linuxbrew/bin/codex', '/usr/bin/codex', '/bin/codex'].some((p) => existsSync(p))
const MINIMAL_PATH = '/usr/bin:/bin'
const src = (file: string) => JSON.stringify(join(import.meta.dir, '..', '..', '..', 'src', 'engine', 'codex', file))

test.skipIf(process.platform === 'win32' || systemCodex)(
  "with no codex on a service's PATH, Desk starts npm's codex under nvm, with the node installed beside it",
  () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-codex-exe-home-'))
    homes.push(home)
    // An npm install under nvm: bin/codex links to the package's launcher, and bin/node is the node npm ran on. Here
    // that node is this bun, which says so, so a node elsewhere on the machine cannot pass for it.
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

    const env: Record<string, string | undefined> = { ...process.env, HOME: home, PATH: MINIMAL_PATH, AGENTHYDRA_HOME: join(home, '.agenthydra') }
    for (const name of ['CODEX_PATH', 'AGENTHYDRA_CODEX_PATH', 'CCMANAGERUI_CODEX_PATH', 'npm_config_prefix', 'NPM_CONFIG_PREFIX', 'NVM_DIR']) delete env[name]
    const code = `const { codexExe } = await import(${src('exe.ts')})
      const { openAppServer } = await import(${src('app-server.ts')})
      const server = await openAppServer(${JSON.stringify(codexHome)})
      const result = await server.call('probe')
      server.release()
      console.log(JSON.stringify({ exe: codexExe(), result }))
      process.exit(0)`
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env, timeout: 30_000 })
    expect(r.stderr).toBe('')
    const { exe, result } = JSON.parse(r.stdout.trim()) as { exe: string; result: { bun: boolean; path: string; args: string[] } }
    expect(exe).toBe(join(bin, 'codex'))
    expect(result.bun).toBe(true)
    expect(result.args).toEqual(['app-server'])
    expect(result.path.split(':').slice(0, 4)).toEqual([bin, dirname(realpathSync(launcher)), '/usr/bin', '/bin'])
  },
  60_000,
)
