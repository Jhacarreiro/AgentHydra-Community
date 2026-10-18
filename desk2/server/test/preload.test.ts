// preload.ts (loaded by desk2/bunfig.toml): a remove of the folder the suite runs in throws and deletes nothing. Bun on
// Windows empties the working folder for rmSync(''), which took every file under desk2/ on 2026-10-10. Each check runs
// from a throwaway folder, so a broken guard empties only that. And process.env cannot be swapped for a copy, which is
// what had left that run with no Chrome to find. A global one file leaves swapped is named and put back before the
// next file loads (2026-10-12: a store test's fetch and WebSocket stubs failed 286 tests in later files).

import { afterAll, afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const back = process.cwd()
const ROOT = mkdtempSync(join(tmpdir(), 'desk-preload-'))

afterEach(() => {
  process.chdir(back)
})

afterAll(() => {
  process.chdir(back)
  rmSync(ROOT, { recursive: true, force: true })
})

function workIn(): string {
  const dir = mkdtempSync(join(ROOT, 'work-'))
  writeFileSync(join(dir, 'keep.txt'), 'keep')
  process.chdir(dir)
  return dir
}

test("rmSync of '' or '.' throws, names the folder, and leaves its files", () => {
  const dir = workIn()
  expect(() => rmSync('', { recursive: true, force: true })).toThrow(/folder the tests run in/)
  expect(() => rmSync('.', { recursive: true, force: true })).toThrow(/folder the tests run in/)
  expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('keep')
})

test('the promise rm rejects the same way, and a remove of a folder beside it still works', async () => {
  const dir = workIn()
  await expect(rm('', { recursive: true, force: true })).rejects.toThrow(/folder the tests run in/)
  expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('keep')
  const other = mkdtempSync(join(ROOT, 'other-'))
  rmSync(other, { recursive: true, force: true })
  expect(existsSync(other)).toBe(false)
})

test('process.env cannot be replaced by a copy, and its keys still set and delete', () => {
  expect(() => {
    ;(process as { env: unknown }).env = { ...process.env }
  }).toThrow()
  process.env.DESK_PRELOAD_PROBE = '1'
  expect(process.env.DESK_PRELOAD_PROBE).toBe('1')
  delete process.env.DESK_PRELOAD_PROBE
  expect(process.env.DESK_PRELOAD_PROBE).toBeUndefined()
})

test("a file that leaves fetch swapped fails the next file's first test by name, and the rest get the real fetch", () => {
  const dir = mkdtempSync(join(ROOT, 'leak-'))
  writeFileSync(join(dir, 'bunfig.toml'), `[test]\npreload = [${JSON.stringify(join(import.meta.dir, 'preload.ts'))}]\n`)
  writeFileSync(
    join(dir, 'a-leaks.test.ts'),
    `import { test } from 'bun:test'\ntest('swaps fetch', () => { globalThis.fetch = (() => 'stub') as never })\n`,
  )
  // The next file's own beforeAll stand-in is its own business: it is neither blamed nor taken away.
  writeFileSync(
    join(dir, 'b-next.test.ts'),
    `import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
describe('next file', () => {
  beforeAll(() => { (globalThis as any).document = { title: 'own' } })
  afterAll(() => { delete (globalThis as any).document })
  test('first', () => {})
  test('second', () => {
    expect(String(globalThis.fetch)).not.toContain('stub')
    expect((globalThis as any).document.title).toBe('own')
  })
})
`,
  )
  const run = Bun.spawnSync([process.execPath, 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const out = run.stdout.toString() + run.stderr.toString()
  expect(out).toContain('a-leaks.test.ts left globalThis.fetch swapped')
  expect(out).toContain('(fail) next file > first')
  expect(out).toMatch(/\b2 pass\b/)
  expect(out).toMatch(/\b1 fail\b/)
  expect(run.exitCode).toBe(1)
}, 15_000)
