// server/tests/instance-pointer-side-run.test.ts — a daemon with a relocated store must not take
// the machine-wide pointer.
//
// The defect this exists for, in full: on 2026-09-12 a session started a daemon from source on port
// 7799 with a scratch database to click through a UI change. It overwrote `~/.agenthydra/
// runtime.json` to name itself and exited without restoring it, and from then on every MCP tool,
// every orchestrator script and every hydralib call on the machine dialled the dead 7799 and
// reported the daemon down — while the real one answered /api/health 200 on 7787 the whole time.
//
// instance.ts resolves POINTER_DIR at IMPORT time from config.ts's CONFIG_DIR/DATA_DIR, and this
// process's config is already fixed by the test preload. So each case boots the real module in a
// child bun with the environment a daemon would start with, has it write its pointer the way
// index.ts does at boot, and then looks at which runtime.json changed.

import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MOD = JSON.stringify(join(import.meta.dir, '..', 'src', 'instance.ts'))
const root = mkdtempSync(join(tmpdir(), 'agenthydra-pointer-'))
/** Each test boots a child bun, so it states its own timeout instead of bun's 5 s default. */
const SPAWNS_A_CHILD_BUN = 30_000
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Boot instance.ts in a child with this home and data dir, write the pointer for `port`, and
 *  return where it says it wrote it. */
function bootAndWrite(home: string, dataDir: string, port: number): string {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `const i = await import(${MOD}); i.writeInstanceInfo(${port}); console.log(i.instanceFilePath())`,
    ],
    {
      env: {
        ...process.env,
        AGENTHYDRA_HOME: home,
        AGENTHYDRA_DATA_DIR: dataDir,
        AGENTHYDRA_DB: join(dataDir, 'agenthydra.db'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const out = proc.stdout.toString().trim()
  if (!proc.success || !out) throw new Error(`child failed: ${proc.stderr.toString() || out}`)
  return out.slice(out.lastIndexOf('\n') + 1)
}

const portIn = (file: string) => JSON.parse(readFileSync(file, 'utf8')).port

test(
  'a daemon on a scratch data dir leaves the shared pointer naming the real daemon',
  () => {
    const home = join(root, 'shared')
    mkdirSync(home, { recursive: true })
    const shared = join(home, 'runtime.json')
    writeFileSync(shared, JSON.stringify({ port: 7787, url: 'http://127.0.0.1:7787' }))
    const scratch = join(root, 'probe-data')

    const written = bootAndWrite(home, scratch, 7799)

    expect(portIn(shared)).toBe(7787)
    expect(written).toBe(join(scratch, 'runtime.json'))
    expect(portIn(written)).toBe(7799)
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'the primary install, data inside its config dir, writes the shared pointer',
  () => {
    const home = join(root, 'primary')
    const written = bootAndWrite(home, join(home, 'data'), 7788)
    expect(written).toBe(join(home, 'runtime.json'))
    expect(portIn(written)).toBe(7788)
    expect(existsSync(join(home, 'data', 'runtime.json'))).toBe(false)
  },
  SPAWNS_A_CHILD_BUN,
)
