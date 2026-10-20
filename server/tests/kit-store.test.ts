import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KIT_SCHEMA_VERSION, migrateKitSchema } from '../src/kit/schema'
import { KitStore, localDay } from '../src/kit/store'

const H = 3_600_000
const D = 24 * H
const T0 = Date.UTC(2026, 5, 10, 12, 0, 0)

const count = (s: KitStore, t: string) =>
  (s.db.query(`select count(*) as n from ${t}`).get() as { n: number }).n

describe('kit store', () => {
  test('duplicate ids: the last write wins', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents([{ id: 'cli:m1', ts: T0, source: 'cli', input: 10, output: 1 }])
    s.upsertEvents([{ id: 'cli:m1', ts: T0, source: 'cli', input: 10, output: 99 }])
    expect(count(s, 'usage_event')).toBe(1)
    expect(s.db.query("select output from usage_event where id = 'cli:m1'").get()).toEqual({
      output: 99,
    })
  })

  test('day is the local date stored at write time', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents([{ id: 'a', ts: T0, source: 'cli' }])
    expect(s.db.query('select day from usage_event').get()).toEqual({ day: localDay(T0) })
  })

  test('rollup sums per hour and dimensions, and is idempotent', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents([
      {
        id: 'a',
        ts: T0 + 1,
        source: 'cli',
        model: 'm',
        input: 5,
        output: 1,
        list_usd: 0.5,
        ok: true,
      },
      {
        id: 'b',
        ts: T0 + 2,
        source: 'cli',
        model: 'm',
        input: 7,
        output: 2,
        list_usd: 0.25,
        ok: false,
      },
      { id: 'c', ts: T0 + 3, source: 'hswarm', model: 'm', input: 100, billed_usd: 1 },
      { id: 'd', ts: T0 + H, source: 'cli', model: 'm', input: 1 },
    ])
    expect(s.rollup()).toBe(3)
    expect(s.rollup()).toBe(0)
    s.rollup(T0)
    const cli = s.db
      .query("select * from usage_hour where source = 'cli' and hour = ?")
      .get(T0) as Record<string, number>
    expect(cli).toMatchObject({
      calls: 2,
      ok_calls: 1,
      failed_calls: 1,
      input: 12,
      output: 3,
      list_usd: 0.75,
    })
    expect(count(s, 'usage_hour')).toBe(3)
  })

  test('a late event re-marks its hour and the next rollup picks it up', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents([{ id: 'a', ts: T0, source: 'cli', input: 1 }])
    s.rollup()
    s.upsertEvents([{ id: 'late', ts: T0 - 5 * H, source: 'cli', input: 4 }])
    // only the dirty hour is rebuilt now (the hour after it is already current); both rows exist
    expect(s.rollup()).toBe(1)
    expect(count(s, 'usage_hour')).toBe(2)
  })

  test('pruning drops old raw events and keeps the hourly rows', () => {
    const s = new KitStore(':memory:', { now: T0 })
    const now = T0 + 60 * D
    s.upsertEvents([
      { id: 'old1', ts: T0, source: 'cli', input: 3 },
      { id: 'old2', ts: T0 + 10, source: 'cli', input: 4 },
      { id: 'new', ts: now - D, source: 'cli', input: 9 },
    ])
    // never rolled up before pruning: the prune must roll the doomed hours up first
    expect(s.pruneRaw(now)).toBe(2)
    expect(count(s, 'usage_event')).toBe(1)
    expect(s.db.query('select input from usage_hour where hour = ?').get(T0 - (T0 % H))).toEqual({
      input: 7,
    })
    expect(s.runMaintenance(now).pruned).toBe(0)
    expect(s.db.query('select sum(input) as n from usage_hour').get()).toEqual({ n: 16 })
  })

  test('drop and rebuild empties every table and clears cursors', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents([{ id: 'a', ts: T0, source: 'cli' }])
    s.rollup()
    s.setCursor({ path: '/x', size: 1, mtime: 2, offset: 1, version: 1 })
    s.dropAndRebuild('v9')
    expect(count(s, 'usage_event') + count(s, 'usage_hour') + count(s, 'ingest_cursor')).toBe(0)
    expect(s.getMeta('price_ver')).toBe('v9')
    s.upsertEvents([{ id: 'b', ts: T0, source: 'cli' }])
    expect(count(s, 'usage_event')).toBe(1)
  })

  test('a newer schema version is refused', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.db.exec('pragma user_version = 99')
    const { migrateKitSchema } = require('../src/kit/schema')
    expect(() => migrateKitSchema(s.db)).toThrow()
  })
})

describe('session ledger and the raw cut', () => {
  const NOW = T0 + 60 * D
  const ledger = (s: KitStore) =>
    s.db
      .query(
        'select session, ref, calls, first_ts, last_ts, input, list_usd from usage_session order by session, ref',
      )
      .all()
  const hourSum = (s: KitStore) =>
    s.db.query('select sum(calls) as c, sum(input) as i from usage_hour').get()

  test('totals equal every event once across pruning, re-upserts and a re-read of old events', () => {
    const s = new KitStore(':memory:', { now: T0 })
    const old = [
      { id: 'o1', ts: T0, session: 'a', ref: 'r', source: 'cli', input: 3, list_usd: 1 },
      { id: 'o2', ts: T0 + 10, session: 'a', ref: 'r', source: 'cli', input: 4, list_usd: 2 },
    ]
    const fresh = [{ id: 'n1', ts: NOW - D, session: 'a', ref: 'r', source: 'cli', input: 9 }]
    s.upsertEvents([...old, ...fresh])
    s.runMaintenance(NOW)
    // o1 and o2 are pruned; one fresh event is still raw. The session total spans both.
    expect(count(s, 'usage_event')).toBe(1)
    const want = [
      { session: 'a', ref: 'r', calls: 3, first_ts: T0, last_ts: NOW - D, input: 16, list_usd: 3 },
    ]
    expect(ledger(s)).toEqual(want)
    const hours = hourSum(s)

    // the fresh event is re-upserted (last write wins), the old ones are read again from byte 0
    s.upsertEvents([{ ...fresh[0], input: 9 }])
    expect(s.upsertEvents(old)).toBe(0)
    s.runMaintenance(NOW)
    s.runMaintenance(NOW + H)
    expect(ledger(s)).toEqual(want)
    expect(hourSum(s)).toEqual(hours)
    expect(count(s, 'usage_event')).toBe(1)

    // a changed fresh event replaces its old value in the total
    s.upsertEvents([{ ...fresh[0], input: 20 }])
    s.runMaintenance(NOW)
    expect((ledger(s)[0] as { input: number }).input).toBe(27)
  })

  test('a rollup and prune cut into slices count every call once, over a dense hour and many days', async () => {
    const s = new KitStore(':memory:', { now: T0 })
    const evs: Array<{
      id: string
      ts: number
      session: string
      model: string
      source: string
      input: number
    }> = []
    // 2500 calls inside one hour (more than a slice holds, with shared timestamps), then one a day for 50 days
    for (let i = 0; i < 2500; i++)
      evs.push({
        id: `dense${i}`,
        ts: T0 + Math.floor(i / 3),
        session: `s${i % 7}`,
        model: i % 5 ? 'm1' : 'm2',
        source: 'cli',
        input: i,
      })
    for (let d = 1; d <= 50; d++)
      evs.push({
        id: `day${d}`,
        ts: T0 + d * D,
        session: `s${d % 3}`,
        model: 'm1',
        source: 'cli',
        input: d,
      })
    s.upsertEvents(evs)
    await s.runMaintenanceAsync(NOW)

    const want = new Map<string, { calls: number; input: number }>()
    for (const e of evs) {
      const k = `${e.ts - (e.ts % H)}|${e.model}`
      const w = want.get(k) ?? { calls: 0, input: 0 }
      w.calls++
      w.input += e.input
      want.set(k, w)
    }
    const got = new Map<string, { calls: number; input: number }>()
    for (const r of s.db.query('select hour, model, calls, input from usage_hour').all() as Array<{
      hour: number
      model: string
      calls: number
      input: number
    }>)
      got.set(`${r.hour}|${r.model}`, { calls: r.calls, input: r.input })
    expect(got).toEqual(want)
    const total = s.db.query('select sum(calls) as c, sum(input) as i from usage_session').get()
    expect(total).toEqual({ c: evs.length, i: evs.reduce((a, e) => a + e.input, 0) })
    expect(count(s, 'usage_event')).toBeLessThan(evs.length) // the old calls were pruned
    expect(s.rawCut()).toBe(Math.floor((NOW - 35 * D) / H) * H)
  })
  test('a v1 file is migrated to v2 with its surviving raw rows in the ledger', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents([{ id: 'a', ts: T0, session: 's', source: 'cli', input: 5 }])
    s.db.exec('drop table usage_session; drop table usage_session_settled; pragma user_version = 1')
    const { migrateKitSchema } = require('../src/kit/schema')
    migrateKitSchema(s.db)
    expect(s.db.query('pragma user_version').get()).toEqual({ user_version: KIT_SCHEMA_VERSION })
    expect(ledger(s)).toMatchObject([{ session: 's', calls: 1, input: 5 }])
  })
})

describe('settled calls, the raw cut and the hour rollup', () => {
  const hourCalls = (s: KitStore, source: string) =>
    (
      s.db
        .query('select coalesce(sum(calls),0) as c from usage_hour where source = ?')
        .get(source) as {
        c: number
      }
    ).c
  const ledgerCalls = (s: KitStore) =>
    (s.db.query('select coalesce(sum(calls),0) as c from usage_session').get() as { c: number }).c

  test('a pruned call read again below the cut is not counted a second time', () => {
    const s = new KitStore(':memory:', { now: T0 })
    const ev = { id: 'msg_X', ts: T0 - 30 * D, session: 's', ref: 'r', source: 'cli', input: 5 }
    s.upsertEvents([ev])
    s.runMaintenance(T0)
    s.pruneRaw(T0 + 10 * D)
    expect(count(s, 'usage_event')).toBe(0)
    expect(s.settleOld([ev])).toBe(0)
    expect(hourCalls(s, 'cli')).toBe(1)
    expect(ledgerCalls(s)).toBe(1)
  })

  test('an old foreign event on a fresh store does not erase settled Claude hours', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.settleOld([{ id: 'c1', ts: T0 - 100 * D, session: 's', source: 'cli', input: 7 }])
    s.upsertEvents([{ id: 'x1', ts: T0 - 200 * D, session: 'z', source: 'codex', input: 3 }])
    s.runMaintenance(T0)
    expect(hourCalls(s, 'cli')).toBe(1)
    expect(hourCalls(s, 'codex')).toBe(1)
    expect(ledgerCalls(s)).toBe(2)
    expect(count(s, 'usage_event')).toBe(0)
  })

  test('a call re-written with a later hour leaves its old hour', () => {
    const s = new KitStore(':memory:', { now: T0 })
    const h = T0 - (T0 % H)
    s.upsertEvents([{ id: 'm', ts: h + H - 1000, session: 's', source: 'cli', input: 5 }])
    s.rollup()
    s.upsertEvents([{ id: 'm', ts: h + H + 1000, session: 's', source: 'cli', input: 6 }])
    s.rollup()
    const rows = s.db.query('select hour, calls, input from usage_hour order by hour').all()
    expect(rows).toEqual([{ hour: h + H, calls: 1, input: 6 }])
  })

  test('a call settled in the band between the cut and the sweep cutoff survives the rollup', () => {
    const s = new KitStore(':memory:', { now: T0 })
    const A = T0 - (T0 % H)
    s.upsertEvents([
      { id: 'b1', ts: A - 600_000, session: 's', source: 'cli', input: 1 },
      { id: 'b2', ts: A + 60_000, session: 's', source: 'cli', input: 2 },
    ])
    s.runMaintenance(A + 35 * D + 30_000)
    expect(s.rawCut()).toBe(A)
    s.settleOld([{ id: 'b3', ts: A + 20 * 60_000, session: 's', source: 'cli', input: 4 }])
    s.runMaintenance(A + 35 * D + H + 60_000)
    expect(s.db.query('select calls, input from usage_hour where hour = ?').get(A)).toEqual({
      calls: 2,
      input: 6,
    })
    expect(ledgerCalls(s)).toBe(3)
  })

  test('a long ingest keeps the dirty hours near now and readers use the rollup below them', async () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.rollupEveryMs = 0
    const evs = Array.from({ length: 1200 }, (_, i) => ({
      id: `l${i}`,
      ts: T0 - 20 * D + i * 1_440_000,
      session: 's',
      source: 'cli',
      input: 1,
    }))
    await s.upsertEventsAsync(evs)
    const dirty = s.dirtyFrom()
    // without the mid-ingest rollup this is the first event's hour, 20 days back
    expect(dirty === null || dirty > T0 - 10 * D).toBe(true)
    expect(
      (s.db.query('select coalesce(sum(calls),0) as c from usage_hour').get() as { c: number }).c,
    ).toBeGreaterThan(0)
  })

  test('a v3 file is upgraded: unbilled and per-call cost are backfilled, in slices', async () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents([
      { id: 'a', ts: T0, session: 's', source: 'hswarm', list_usd: 0.2, billed_usd: null },
      { id: 'b', ts: T0 + 1, session: 's', source: 'hswarm', list_usd: 0.5, billed_usd: 0.1 },
      { id: 'c', ts: T0 + 2, session: 's', source: 'hswarm', list_usd: 0.7, billed_usd: 0 },
    ])
    await s.runMaintenanceAsync(T0 + H)
    const want = s.db.query('select unbilled_usd as u, cost_usd as c from usage_hour').get() as {
      u: number
      c: number
    }
    expect(want.u).toBeCloseTo(0.2)
    expect(want.c).toBeCloseTo(0.3)
    s.db.exec('update usage_hour set unbilled_usd = 0, cost_usd = 0')
    s.db.exec('update usage_session set unbilled_usd = 0, cost_usd = 0')
    s.setMeta('backfill_v4', 'a')
    await s.backfillAsync()
    expect(s.db.query('select unbilled_usd as u, cost_usd as c from usage_hour').get()).toEqual(
      want,
    )
    expect(
      (s.db.query('select cost_usd as c from usage_session').get() as { c: number }).c,
    ).toBeCloseTo(0.3)
  })

  test('the schema-4 backfill pages a session with thousands of ledger rows by the whole key', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents(
      Array.from({ length: 2500 }, (_, i) => ({
        id: `r${i}`,
        ts: T0 + i,
        session: 'big',
        ref: `ref${i}`,
        source: 'hswarm',
        list_usd: 0.2,
        billed_usd: i % 2 ? 0.1 : null,
      })),
    )
    s.runMaintenance(T0 + H)
    expect(count(s, 'usage_session')).toBe(2500)
    s.db.exec('update usage_session set unbilled_usd = 0, cost_usd = 0')
    s.setMeta('backfill_v4', 'a')
    const steps = (s as unknown as { backfillSteps(): Generator<void> }).backfillSteps()
    let most = 0
    for (;;) {
      const phaseA = s.getMeta('backfill_v4') === 'a'
      const before = (s.db.query('select total_changes() as c').get() as { c: number }).c
      const r = steps.next()
      const after = (s.db.query('select total_changes() as c').get() as { c: number }).c
      if (phaseA) most = Math.max(most, after - before)
      if (r.done) break
    }
    // the old paging by session id updated all 2500 rows of the one session in a single step
    expect(most).toBeLessThan(2000)
    expect(s.db.query('select count(*) as n from usage_session where cost_usd = 0').get()).toEqual({
      n: 0,
    })
    const sum = s.db.query('select sum(unbilled_usd) as u from usage_session').get() as {
      u: number
    }
    expect(sum.u).toBeCloseTo(1250 * 0.2)
  })

  test('a long sliced write waits for the WAL to restart instead of growing it for ever, also after the store went idle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-wal-'))
    const path = join(dir, 'kit.db')
    const s = new KitStore(path, { now: T0 })
    try {
      s.ckptEveryMs = 10
      s.walLimitBytes = 1_000_000
      await s.upsertEventsAsync([{ id: 'warm', ts: T0, source: 'cli' }])
      let peak = 0
      let pausesAtIdle = 0
      for (let b = 0; b < 40; b++) {
        // the end of a sweep: the checkpoint worker stops, and the next long write must start another
        if (b === 20) {
          s.idle()
          pausesAtIdle = s.walPauses
        }
        await s.upsertEventsAsync(
          Array.from({ length: 1500 }, (_, i) => ({
            id: `w${b}-${i}`,
            ts: T0 + b * 1500 + i,
            source: 'cli',
            session: `s${i % 50}`,
            model: 'm',
            input: i,
          })),
        )
        peak = Math.max(peak, statSync(`${path}-wal`).size)
      }
      // 60,000 rows with their indexes are 60 MB of WAL when it is never restarted
      expect(pausesAtIdle).toBeGreaterThan(0)
      expect(s.walPauses).toBeGreaterThan(pausesAtIdle)
      expect(peak).toBeLessThan(20_000_000)
      // and the worker's checkpoints kept it so, not only the writer's own after a pause gave up on the worker;
      // counted over both workers, so one that never answers costs a pause, not the test
      expect(s.walCaughtUp).toBeGreaterThan(0)
    } finally {
      s.close()
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // the terminated checkpoint worker can still hold the files on Windows; the test temp dir is wiped
      }
    }
  }, 30_000)

  const walBatch = (b: number) =>
    Array.from({ length: 1500 }, (_, i) => ({
      id: `w${b}-${i}`,
      ts: T0 + b * 1500 + i,
      source: 'cli',
      session: `s${i % 50}`,
      model: 'm',
      input: i,
    }))
  const workerOf = (s: KitStore) => (s as unknown as { ckptWorker: Worker | null }).ckptWorker
  const busyOf = (s: KitStore) => (s as unknown as { ckptBusy: boolean }).ckptBusy
  const autocheckpoint = (s: KitStore) =>
    (s.db.query('pragma wal_autocheckpoint').get() as { wal_autocheckpoint: number })
      .wal_autocheckpoint

  test('a checkpoint worker that never answers costs a long write one pause, not one per slice, and the next long write starts another', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-wal-'))
    const path = join(dir, 'kit.db')
    const s = new KitStore(path, { now: T0 })
    try {
      s.walLimitBytes = 1_000_000
      s.walPauseMaxMs = 100
      // the first write only starts the worker (a slow one could ask it a checkpoint too, under load)
      s.ckptEveryMs = 60_000
      await s.upsertEventsAsync([{ id: 'warm', ts: T0, source: 'cli' }])
      // a worker that did not start, or a request lost on its way: nothing ever answers
      const silent = workerOf(s) as Worker
      silent.postMessage = () => {}
      s.ckptEveryMs = 10
      let ended = false
      silent.addEventListener('close', () => (ended = true))
      let peak = 0
      for (let b = 0; b < 20; b++) {
        await s.upsertEventsAsync(walBatch(b))
        peak = Math.max(peak, statSync(`${path}-wal`).size)
      }
      // the writer used to wait out another pause each time the WAL file had grown (14-21 here, 5 s each in
      // the daemon), with its own checkpoint off
      expect(s.walPauses).toBe(1)
      expect(peak).toBeLessThan(20_000_000)
      s.idle()
      for (let b = 20; b < 30; b++) await s.upsertEventsAsync(walBatch(b))
      // its request still open, the silent worker was let go all the same, and ended: it never reads the
      // close it was told, so it is terminated
      expect(workerOf(s)).not.toBe(silent)
      expect(s.walPauses).toBeGreaterThan(1)
      for (let i = 0; i < 100 && !ended; i++) await Bun.sleep(10)
      expect(ended).toBe(true)
    } finally {
      s.close()
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // the terminated checkpoint worker can still hold the files on Windows; the test temp dir is wiped
      }
    }
  }, 30_000)

  test('idle() during a pause that then gives up on a silent worker lets it go all the same, and the long work after it starts another', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-wal-'))
    const path = join(dir, 'kit.db')
    const s = new KitStore(path, { now: T0 })
    try {
      s.walLimitBytes = 1_000_000
      s.walPauseMaxMs = 100
      s.ckptEveryMs = 60_000
      await s.upsertEventsAsync([{ id: 'warm', ts: T0, source: 'cli' }])
      const silent = workerOf(s) as Worker
      silent.postMessage = () => {}
      s.ckptEveryMs = 10
      // the sweep ends (idle()) while a sync asked for on /api/kit/sync waits in a pause: idle() leaves the
      // park to that pause, which then gives up on the worker
      let idled = false
      const walPause = s.walPause.bind(s)
      s.walPause = () => {
        const p = walPause()
        if (p && !idled) {
          idled = true
          s.idle()
        }
        return p
      }
      for (let b = 0; b < 10; b++) await s.upsertEventsAsync(walBatch(b))
      expect(idled).toBe(true)
      for (let b = 10; b < 20; b++) await s.upsertEventsAsync(walBatch(b))
      // the give-up used to turn the worker off again after idle() had cleared that: the silent worker
      // stayed, and the writer started no other and took no pause after that one until the next idle().
      // Counted from the give-up, not from the second write: the next worker may itself be slow
      expect(workerOf(s)).not.toBe(silent)
      expect(s.walPauses).toBeGreaterThan(1)
    } finally {
      s.close()
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // the terminated checkpoint worker can still hold the files on Windows; the test temp dir is wiped
      }
    }
  }, 30_000)

  test('a checkpoint worker that answers after its pause gave up takes the checkpoints back, once per run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-wal-'))
    const path = join(dir, 'kit.db')
    const s = new KitStore(path, { now: T0 })
    try {
      s.walLimitBytes = 1_000_000
      s.ckptEveryMs = 60_000
      await s.upsertEventsAsync([{ id: 'warm', ts: T0, source: 'cli' }])
      s.ckptEveryMs = 10
      const w = workerOf(s) as Worker
      const post = w.postMessage.bind(w)
      const pauseMax = s.walPauseMaxMs
      let asked = 0
      // a slow worker: nothing it is asked is answered in time, and a pause (100 ms here) gives up on it
      const slow = (worker: Worker) => {
        s.walPauseMaxMs = 100
        worker.postMessage = () => {}
      }
      // then the answer comes after all, as the worker's would
      const answerLate = (worker: Worker) =>
        worker.dispatchEvent(new MessageEvent('message', { data: { log: 0, done: 0 } }))
      const quick = () => {
        s.walPauseMaxMs = pauseMax
        w.postMessage = (m: unknown) => {
          asked++
          post(m)
        }
      }
      slow(w)
      for (let b = 0; b < 5; b++) await s.upsertEventsAsync(walBatch(b))
      expect(s.walPauses).toBe(1)
      expect(autocheckpoint(s)).toBe(1000)
      answerLate(w)
      expect(autocheckpoint(s)).toBe(0)
      // quick again: the same worker is asked for checkpoints, and the writer waits for them again
      quick()
      const pauses = s.walPauses
      for (let b = 5; b < 15; b++) await s.upsertEventsAsync(walBatch(b))
      expect(workerOf(s)).toBe(w)
      expect(asked).toBeGreaterThan(0)
      expect(s.walPauses).toBeGreaterThan(pauses)
      // slow again: a second give-up holds until idle(), late answer or not
      slow(w)
      for (let b = 15; b < 30 && autocheckpoint(s) === 0; b++)
        await s.upsertEventsAsync(walBatch(b))
      expect(autocheckpoint(s)).toBe(1000)
      answerLate(w)
      expect(autocheckpoint(s)).toBe(1000)
      const given = s.walPauses
      for (let b = 30; b < 35; b++) await s.upsertEventsAsync(walBatch(b))
      expect(s.walPauses).toBe(given)
      // once per run, not once per store: idle() lets the worker go, the next long write starts another, and
      // that one's late answer gives the checkpoints back again. Quick again first, the worker reads the close
      // it is told and closes its connection itself, not terminated while the next run writes (see
      // dropCheckpointWorker)
      quick()
      s.idle()
      for (let b = 35; b < 45 && !workerOf(s); b++) await s.upsertEventsAsync(walBatch(b))
      const next = workerOf(s) as Worker
      expect(next).toBeInstanceOf(Worker)
      expect(next).not.toBe(w)
      for (let i = 0; i < 500 && busyOf(s); i++) await Bun.sleep(10)
      slow(next)
      for (let b = 45; b < 60 && autocheckpoint(s) === 0; b++)
        await s.upsertEventsAsync(walBatch(b))
      expect(autocheckpoint(s)).toBe(1000)
      answerLate(next)
      expect(autocheckpoint(s)).toBe(0)
    } finally {
      s.close()
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // the terminated checkpoint worker can still hold the files on Windows; the test temp dir is wiped
      }
    }
  }, 30_000)

  test('idle() lets a worker that has answered close its own connection and end, not be terminated, and the writes right after it go through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-wal-'))
    const path = join(dir, 'kit.db')
    const s = new KitStore(path, { now: T0 })
    try {
      s.walLimitBytes = 1_000_000
      s.ckptEveryMs = 60_000
      await s.upsertEventsAsync([{ id: 'warm', ts: T0, source: 'cli' }])
      const w = workerOf(s) as Worker
      let answers = 0
      w.addEventListener('message', () => answers++)
      s.ckptEveryMs = 10
      for (let b = 0; b < 3; b++) await s.upsertEventsAsync(walBatch(b))
      for (let i = 0; i < 500 && (answers === 0 || busyOf(s)); i++) await Bun.sleep(10)
      expect(answers).toBeGreaterThan(0)
      // a connection still open when the worker's thread ends, terminated or not, checkpoints as the thread goes
      // down, and the writer's next commits threw SQLITE_BUSY (see dropCheckpointWorker): this worker must close
      // its connection itself, before its thread ends and before the terminate() that follows walPauseMaxMs later
      s.walPauseMaxMs = 60_000
      let terminated = false
      const terminate = w.terminate.bind(w)
      w.terminate = () => {
        terminated = true
        terminate()
      }
      let ended = false
      w.addEventListener('close', () => (ended = true))
      // frames the worker has not checkpointed yet, as at the end of a sweep, then writes right after idle()
      s.upsertEvents(walBatch(9).slice(0, 500))
      s.idle()
      expect(workerOf(s)).toBeNull()
      let busy = 0
      for (let n = 0; n < 100; n++) {
        try {
          s.setMeta('x', String(n))
        } catch {
          busy++
        }
        await Bun.sleep(1)
      }
      expect(busy).toBe(0)
      for (let i = 0; i < 500 && !ended; i++) await Bun.sleep(10)
      expect(ended).toBe(true)
      expect(terminated).toBe(false)
    } finally {
      s.close()
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // a checkpoint worker not ended yet can still hold the files on Windows; the test temp dir is wiped
      }
    }
  }, 30_000)
})

describe('sub-agent id (schema 5)', () => {
  const cursor = (path: string, mtime: number) =>
    ({ path, size: 10, mtime, offset: 10, version: 3 }) as const
  const paths = (s: KitStore) =>
    (s.db.query('select path from ingest_cursor order by path').all() as { path: string }[]).map(
      (r) => r.path,
    )

  test('a v4 file gets the column, and a marker only when it has read files', () => {
    for (const read of [true, false]) {
      const s = new KitStore(':memory:', { now: T0 })
      if (read) s.setCursor(cursor('/p/s/subagents/agent-a.jsonl', T0))
      s.db.exec('alter table usage_event drop column agent_id')
      s.db.exec("delete from meta where key = 'backfill_v5'")
      s.db.exec('pragma user_version = 4')
      migrateKitSchema(s.db)
      s.upsertEvents([{ id: 'a', ts: T0, source: 'cli', agent_id: 'agent-a' }])
      expect(s.db.query('select agent_id from usage_event').get()).toEqual({ agent_id: 'agent-a' })
      expect(s.getMeta('backfill_v5')).toBe(read ? 'a' : null)
    }
  })

  test('the backfill forgets the cursors of recent sub-agent files only, in slices, once', async () => {
    const s = new KitStore(':memory:', { now: T0 })
    const cut = s.rawCut() as number
    const sub = (i: number) => `/p/s/subagents/agent-${i}.jsonl`
    for (let i = 0; i < 1300; i++) s.setCursor(cursor(sub(i), cut + 1000))
    s.setCursor(cursor('C:\\p\\s\\subagents\\agent-win.jsonl', cut + 1000))
    s.setCursor(cursor('/p/s/subagents/agent-old.jsonl', cut - 1000)) // only calls past the raw cut
    s.setCursor(cursor('/p/main.jsonl', cut + 1000))
    s.setMeta('backfill_v5', 'a')
    const epoch = s.cursorEpoch
    const steps = (s as unknown as { backfillSteps(): Generator<void> }).backfillSteps()
    let slices = 0
    while (!steps.next().done) slices++
    expect(slices).toBeGreaterThan(1)
    expect(paths(s)).toEqual(['/p/main.jsonl', '/p/s/subagents/agent-old.jsonl'])
    expect(s.cursorEpoch).toBe(epoch + 1)
    expect(s.getMeta('backfill_v5')).toBeNull()
    s.setCursor(cursor(sub(1), cut + 1000))
    await s.backfillAsync() // nothing left to do: a later cursor is kept
    expect(paths(s)).toContain(sub(1))
  })
})
