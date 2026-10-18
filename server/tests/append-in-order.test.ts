// core/append-in-order.ts: the appends to one record file land in the order they were asked for,
// and an append that cannot be written loses its text without rejecting or stopping the next one.
// Measured 2026-10-11: two unchained fs/promises appends (8 MB, then one line) landed small-first
// in 11 of 20 tries.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendInOrder } from '../src/core/append-in-order'

const dir = mkdtempSync(join(tmpdir(), 'append-in-order-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('a big append and the small ones after it land in the order they were asked for', async () => {
  const big = `${'x'.repeat(8 * 1024 * 1024)}\n`
  for (let round = 0; round < 3; round++) {
    const path = join(dir, `round-${round}`, 'record.jsonl')
    const small = Array.from({ length: 10 }, (_, i) => `line ${i}\n`)
    await Promise.all([appendInOrder(path, big), ...small.map((s) => appendInOrder(path, s))])
    const text = readFileSync(path, 'utf8')
    expect(text.startsWith('xxx')).toBe(true)
    expect(text.slice(big.length)).toBe(small.join(''))
  }
})

test('an append that cannot be written settles, and the next one to that file still lands', async () => {
  const blocker = join(dir, 'blocked')
  writeFileSync(blocker, '') // a file where the record's folder should be
  const path = join(blocker, 'record.jsonl')
  await expect(appendInOrder(path, 'lost\n')).resolves.toBeUndefined()
  rmSync(blocker)
  await appendInOrder(path, 'kept\n')
  expect(readFileSync(path, 'utf8')).toBe('kept\n')
})
