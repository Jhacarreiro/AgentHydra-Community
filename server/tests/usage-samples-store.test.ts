// The SQLite store behind usage-history.ts (docs/STORAGE-PLAN.md piece 12).
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../src/db'
import type { UsageSnapshot } from '../src/types'
import {
  dropUsageHistory,
  importLegacyUsageHistory,
  lastSampleSnapshot,
  pruneUsageSamples,
  recordUsageSample,
  usageReaderCounts,
  usageSamples,
} from '../src/usage-history'
import { asReader } from '../src/usage-reader'

const KEY = 'test:usage-samples-store'
const dir = mkdtempSync(join(tmpdir(), 'usage-store-'))
afterAll(() => {
  dropUsageHistory(KEY)
  rmSync(dir, { recursive: true, force: true })
})

const snap = (at: string, week: number, session: number | null = 7): UsageSnapshot => ({
  account: null,
  session:
    session === null ? null : { pct: session, resets: '', resetsAt: '2030-01-01T05:00:00.000Z' },
  weekAll: { pct: week, resets: '', resetsAt: '2030-01-07T00:00:00.000Z' },
  weekModel: null,
  capturedAt: at,
})

test('a sample written is read back, with its reset times; a replay is ignored', () => {
  dropUsageHistory(KEY)
  const at = new Date().toISOString()
  recordUsageSample(KEY, snap(at, 42))
  recordUsageSample(KEY, snap(at, 42))
  const got = usageSamples(KEY)
  expect(got).toEqual([
    {
      at,
      sessionPct: 7,
      weekAllPct: 42,
      weekResetsAt: '2030-01-07T00:00:00.000Z',
      sessionResetsAt: '2030-01-01T05:00:00.000Z',
    },
  ])
  expect(lastSampleSnapshot(KEY)?.weekAll?.pct).toBe(42)
})

test('a reading records the request or timer it was taken for, an inner label winning', async () => {
  dropUsageHistory(KEY)
  const t = Date.now()
  const at = (n: number) => new Date(t - n * 1000).toISOString()
  const reader = `test reader ${t}`
  await asReader(reader, async () => {
    await Promise.resolve()
    recordUsageSample(KEY, snap(at(3), 1))
    asReader(`${reader} inner`, () => recordUsageSample(KEY, snap(at(2), 2)))
  })
  recordUsageSample(KEY, snap(at(1), 3))
  const mine = usageReaderCounts(t - 60_000).filter((r) => r.reader?.startsWith(reader))
  expect(mine).toEqual([
    { reader, kind: 'test', readings: 1, keys: 1 },
    { reader: `${reader} inner`, kind: 'test', readings: 1, keys: 1 },
  ])
  expect(
    db.query('select reader from usage_samples where key = ? and at = ?').get(KEY, at(1)),
  ).toEqual({ reader: 'unlabelled' })
})

test('retention drops samples older than 90 days and keeps the rest', () => {
  dropUsageHistory(KEY)
  const day = 86_400_000
  recordUsageSample(KEY, snap(new Date(Date.now() - 91 * day).toISOString(), 1))
  recordUsageSample(KEY, snap(new Date(Date.now() - 89 * day).toISOString(), 2))
  expect(pruneUsageSamples()).toBeGreaterThanOrEqual(1)
  expect(usageSamples(KEY).map((s) => s.weekAllPct)).toEqual([2])
})

test('the legacy import is idempotent and leaves the file alone', () => {
  dropUsageHistory(KEY)
  const path = join(dir, 'usage-history.json')
  const at = new Date().toISOString()
  const body = JSON.stringify({
    [KEY]: [{ at, sessionPct: null, weekAllPct: 5, weekResetsAt: null }],
  })
  writeFileSync(path, body)
  expect(importLegacyUsageHistory(path, true)).toBe(1)
  expect(importLegacyUsageHistory(path, true)).toBe(0)
  expect(usageSamples(KEY)).toHaveLength(1)
  expect(db.query('select count(*) as n from usage_samples where key = ?').get(KEY)).toEqual({
    n: 1,
  })
  expect(require('node:fs').readFileSync(path, 'utf8')).toBe(body)
})
