import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkFolderTree } from '../src/core/folder-tree'

// The transcript index used to list every folder on every build; it now trusts a folder's mtime
// between listings (core/folder-tree.ts), so what a walk returns must still be what is on disk.
const root = mkdtempSync(join(tmpdir(), 'folder-tree-'))
const racyRoot = mkdtempSync(join(tmpdir(), 'folder-tree-racy-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(racyRoot, { recursive: true, force: true })
})

/** Every file as `<folder rel>/<name>`, sorted. */
async function files(): Promise<string[]> {
  const out: string[] = []
  for (const f of (await walkFolderTree(root)).values())
    for (const name of f.files) out.push(f.rel ? `${f.rel}/${name}` : name)
  return out.sort()
}

test('a walk sees files and folders created and removed since the last one', async () => {
  mkdirSync(join(root, 'p', 's', 'subagents'), { recursive: true })
  writeFileSync(join(root, 'p', 'a.jsonl'), '')
  writeFileSync(join(root, 'p', 's', 'subagents', 'x.jsonl'), '')
  expect(await files()).toEqual(['p/a.jsonl', 'p/s/subagents/x.jsonl'])

  writeFileSync(join(root, 'p', 'b.jsonl'), '') // into a folder already listed
  writeFileSync(join(root, 'p', 's', 'subagents', 'y.jsonl'), '') // two levels down
  mkdirSync(join(root, 'q'))
  writeFileSync(join(root, 'q', 'c.jsonl'), '')
  rmSync(join(root, 'p', 'a.jsonl'))
  expect(await files()).toEqual([
    'p/b.jsonl',
    'p/s/subagents/x.jsonl',
    'p/s/subagents/y.jsonl',
    'q/c.jsonl',
  ])

  rmSync(join(root, 'p', 's'), { recursive: true })
  expect(await files()).toEqual(['p/b.jsonl', 'q/c.jsonl'])
})

test('a missing root is an empty tree', async () => {
  expect((await walkFolderTree(join(root, 'not-there'))).size).toBe(0)
})

// A change that lands in the same mtime tick as the listing leaves the folder's mtime as it was, so a
// walk must not trust that mtime alone for a folder listed while it was still recent (racy-git rule).
test('a file added in the same mtime tick as the last listing is seen by the next walk', async () => {
  const dir = join(racyRoot, 'r')
  mkdirSync(dir)
  writeFileSync(join(dir, 'a.jsonl'), '')
  // Whole seconds, so the mtime is exact and can be put back to the same value after the change.
  const tick = Math.floor(Date.now() / 1000)
  utimesSync(dir, tick, tick)
  const seen = async () =>
    [...(await walkFolderTree(racyRoot)).values()]
      .flatMap((f) => f.files.map((name) => (f.rel ? `${f.rel}/${name}` : name)))
      .sort()
  expect(await seen()).toEqual(['r/a.jsonl'])

  writeFileSync(join(dir, 'b.jsonl'), '')
  utimesSync(dir, tick, tick)
  expect(await seen()).toEqual(['r/a.jsonl', 'r/b.jsonl'])
})
