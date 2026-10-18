// The .devwebui watcher's backstop (watch.ts rules 6 and 7): an edit still applies when the folder's fs.watch is no
// use. Removing a folder and restoring it (a branch switch does it) leaves its watch dead on Linux, and on Windows
// reporting the folder gone hundreds of times a second, which held the debounce off forever. Before the poll and the
// close-on-gone, the save after the restore never applied, on either.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createProjectWatch, type ProjectWatch } from '../../src/devservers/watch'

const dirs: string[] = []
const watches: ProjectWatch[] = []
afterEach(() => {
  for (const w of watches.splice(0)) w.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!fn() && Date.now() - start < timeoutMs) await sleep(25)
}

test('a folder removed and restored still reloads: the stat poll sees the save no watch reports', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devs-watch-'))
  dirs.push(root)
  const folder = path.join(root, 'app')
  const file = path.join(folder, '.devwebui')
  mkdirSync(folder)
  writeFileSync(file, '{"v":1}')
  const applied: string[] = []
  const w = createProjectWatch({ files: () => [file], apply: (f) => applied.push(f), log: () => {} })
  watches.push(w)
  w.sync()

  // The folder goes, and the debounced check its removal set off runs while it is gone: nothing to apply.
  rmSync(folder, { recursive: true, force: true })
  await sleep(600)
  expect(applied).toEqual([])
  // It comes back with new content, in a folder no live watch covers.
  mkdirSync(folder)
  writeFileSync(file, '{"v":2}')
  await waitFor(() => applied.length > 0, 4000)
  expect(applied).toEqual([file])
}, 10_000)
