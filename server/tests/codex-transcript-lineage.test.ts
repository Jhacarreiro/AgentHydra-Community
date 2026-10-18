import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCodexHistory, readCodexTail } from '../src/core/codex-transcript-lineage'

const ID = '0f0f0f0f-1111-4222-8333-444444444444'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const row = (ordinal: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ordinal,
    type: 'response_item',
    payload: { type: 'message', n: ordinal, ...extra },
  })
const meta = (ordinal: number, base?: { end: number; endOrdinal: number }) =>
  JSON.stringify({
    ordinal,
    type: 'session_meta',
    payload: {
      id: ID,
      ...(base
        ? {
            history_base: {
              thread_id: ID,
              end_ordinal_exclusive: base.endOrdinal,
              end_byte_offset: base.end,
            },
          }
        : {}),
    },
  })
const bytes = (lines: string[]) => Buffer.byteLength(`${lines.join('\n')}\n`)

test('a history rolled over twice reads as one file, without rows past each boundary', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-lineage-'))
  roots.push(home)
  // Three context windows of one chat. Each earlier file runs on past the point the next one
  // continues from, and those abandoned rows reuse the next file's ordinals.
  const first = [meta(0), row(1), row(2)]
  const second = [meta(3, { end: bytes(first), endOrdinal: 3 }), row(4), row(5)]
  const newest = [meta(6, { end: bytes(second), endOrdinal: 6 }), row(7)]
  const day = join(home, 'sessions', '2026', '10', '13')
  const archive = join(home, 'archived_sessions', '2026', '10', '13')
  mkdirSync(day, { recursive: true })
  mkdirSync(archive, { recursive: true })
  writeFileSync(
    join(archive, `rollout-a-${ID}.jsonl`),
    `${[...first, row(3, { abandoned: true })].join('\n')}\n`,
  )
  writeFileSync(
    join(day, `rollout-b-${ID}_w2.jsonl`),
    `${[...second, row(6, { abandoned: true })].join('\n')}\n`,
  )
  writeFileSync(join(day, `rollout-c-${ID}_w3.jsonl`), `${newest.join('\n')}\n`)

  const history = readCodexHistory(join(day, `rollout-c-${ID}_w3.jsonl`), home)
  const rows = history.text
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(rows.map((r) => r.ordinal)).toEqual([0, 1, 2, 4, 5, 7])
  expect(rows[0].payload).toEqual({ id: ID })
  expect(history.text).not.toContain('abandoned')
  expect(history.segments.map((s) => s.bytes)).toEqual([bytes(first), bytes(second), bytes(newest)])
  expect(history.lastOrdinal).toBe(7)
})

test('the tail of a continued chat reads back into its earlier rollout, up to the boundary and within the budget', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-lineage-'))
  roots.push(home)
  const first = [meta(0), row(1), row(2)]
  const newest = [meta(3, { end: bytes(first), endOrdinal: 3 }), row(4)]
  const day = join(home, 'sessions', '2026', '10', '13')
  mkdirSync(day, { recursive: true })
  writeFileSync(
    join(day, `rollout-a-${ID}.jsonl`),
    `${[...first, row(3, { abandoned: true })].join('\n')}\n`,
  )
  const path = join(day, `rollout-b-${ID}_w2.jsonl`)
  writeFileSync(path, `${newest.join('\n')}\n`)

  const ordinals = (text: string) =>
    text.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line).ordinal]
      } catch {
        return []
      }
    })
  // Before, the tail read the newest file alone: the chat's earlier messages were gone from its view.
  const whole = await readCodexTail(path, 1 << 20)
  expect(ordinals(whole.text)).toEqual([0, 1, 2, 3, 4])
  expect(whole.text).not.toContain('abandoned')
  expect(whole.start).toBe(0)
  // A budget that ends inside a row of the earlier rollout begins at the next whole row; the page above ends there.
  const budget = bytes(newest) + bytes([row(2)]) + 3
  const recent = await readCodexTail(path, budget)
  expect(ordinals(recent.text)).toEqual([2, 3, 4])
  expect(recent.start).toBe(bytes([meta(0), row(1)]))
  const above = await readCodexTail(path, 1 << 20, recent.start)
  expect([ordinals(above.text), above.start]).toEqual([[0, 1], 0])
})
