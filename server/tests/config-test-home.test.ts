// server/tests/config-test-home.test.ts - config.ts's throwaway state under NODE_ENV=test.
//
// A process that loads config.ts with no home override (a bun script, a one-off check) gets a
// throwaway temp home that it removes on exit. On Windows a handle opened in it (the sqlite file)
// is still open when 'exit' fires, so the rm threw EBUSY: the process exited non-zero after its
// output and the folder stayed behind (about 3,300 of them in Temp).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cfg-home-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function runConfig(script: string) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith('AGENTHYDRA_')) env[k] = v
  env.NODE_ENV = 'test'
  env.TMPDIR = tmp
  env.TEMP = tmp
  env.TMP = tmp
  return Bun.spawnSync([process.execPath, '-e', script], {
    cwd: join(import.meta.dir, '..'),
    env,
  })
}

const OPEN_DB = `
  const { Database } = require('bun:sqlite')
  require('./src/config')
  globalThis.db = new Database(process.env.AGENTHYDRA_DB, { create: true })
  db.exec('create table t (x)')
  console.log('done')
`

test('a process that opens the throwaway db still exits 0', () => {
  const r = runConfig(OPEN_DB)
  expect(r.stdout.toString()).toContain('done')
  expect(r.stderr.toString()).not.toContain('EBUSY')
  expect(r.exitCode).toBe(0)
}, 30_000)

test('starting up sweeps throwaway homes older than a day and keeps younger ones', () => {
  const old = join(tmp, 'agenthydra-test-OLD')
  const fresh = join(tmp, 'agenthydra-test-NEW')
  mkdirSync(old)
  mkdirSync(fresh)
  const twoDays = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  utimesSync(old, twoDays, twoDays)
  runConfig(OPEN_DB)
  expect(existsSync(old)).toBe(false)
  expect(existsSync(fresh)).toBe(true)
}, 30_000)
