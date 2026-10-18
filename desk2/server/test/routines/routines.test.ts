// The routine manager (routines/): the cron reading, the definition check, the judging of one look, the Windows task reading,
// and the plugin end to end over a temp home with fake clock, chats and Windows tasks. Never the real home or a real task.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { DeskSettings } from '@shared/protocol'
import type { RoutinesStatus } from '@shared/routines'
import type { ServerContext } from '../../src/context'
import { nextSlot, parseCron, previousSlot } from '../../src/routines/cron'
import { checkDefinition, untilEndOf, type Entry } from '../../src/routines/manifest'
import { emptyMemory, judge, MIN_GAP_MS, MISSED_MS, type Memory, type Reading, type Seen } from '../../src/routines/decide'
import { parseTaskReadings, readTasks, type TaskReading } from '../../src/routines/wintask'
import type { RunFile } from '../../src/routines/runner'
import { cleanDescription, describePrompt, DESCRIBE_INPUT_CHARS, type Describer, type DescribeRequest } from '../../src/routines/describe'
import { pidAlive, recordedPidOwner } from '../../src/host/launch'
import { loadSettings, settingsPath } from '../../src/settings'
import plugin, { type RoutinesOptions, type RoutineTasks, type RoutineWorkers } from '../../src/plugins/73-routines'

const MIN = 60_000
const HOUR = 60 * MIN
/** A local time, as the cron reading takes it (the tests run in the PC's zone, so they build local dates). */
const at = (y: number, mo: number, d: number, h: number, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()

// ---------- cron ----------

describe('cron (routines/cron.ts)', () => {
  test('lists, ranges and steps: the slots of a day come out in order, both ways', () => {
    const c = parseCron('0 8,12 * * *')
    expect(nextSlot(c, at(2026, 10, 12, 8, 0))).toBe(at(2026, 10, 12, 12, 0))
    expect(previousSlot(c, at(2026, 10, 12, 11, 59))).toBe(at(2026, 10, 12, 8, 0))

    const steps = parseCron('*/20 * * * *')
    expect(previousSlot(steps, at(2026, 10, 12, 10, 50))).toBe(at(2026, 10, 12, 10, 40))

    const range = parseCron('10-30/10 9 * * *')
    expect(nextSlot(range, at(2026, 10, 12, 9, 10))).toBe(at(2026, 10, 12, 9, 20))
  })

  test('the next slot is strictly after the time it is asked from, and the previous slot is at or before it', () => {
    const c = parseCron('57 8 * * *')
    expect(nextSlot(c, at(2026, 10, 12, 8, 57))).toBe(at(2026, 10, 13, 8, 57))
    expect(previousSlot(c, at(2026, 10, 12, 8, 57))).toBe(at(2026, 10, 12, 8, 57))
  })

  test('day-of-week 7 is Sunday, like 0', () => {
    // 2026-10-17 is a Saturday, so the next Sunday is the 18th.
    expect(nextSlot(parseCron('0 9 * * 7'), at(2026, 10, 17, 10, 0))).toBe(at(2026, 10, 18, 9, 0))
    expect(nextSlot(parseCron('0 9 * * 0'), at(2026, 10, 17, 10, 0))).toBe(at(2026, 10, 18, 9, 0))
  })

  test('when both day-of-month and day-of-week are restricted, either one matching counts', () => {
    // Monday 2026-10-12 09:30: the 13th (a Tuesday) comes before the next Monday, the 19th.
    expect(nextSlot(parseCron('0 9 13 * 1'), at(2026, 10, 12, 9, 30))).toBe(at(2026, 10, 13, 9, 0))
  })

  test('month ends: the 31st only runs in the months that have one', () => {
    expect(nextSlot(parseCron('0 0 31 * *'), at(2026, 9, 30, 12, 0))).toBe(at(2026, 10, 31, 0, 0))
    expect(nextSlot(parseCron('0 0 31 * *'), at(2026, 10, 31, 0, 0))).toBe(at(2026, 12, 31, 0, 0))
  })

  test('rejects what it does not take, with a reason', () => {
    expect(() => parseCron('0 9 * * MON')).toThrow()
    expect(() => parseCron('@daily')).toThrow()
    expect(() => parseCron('0 0 9 * * *')).toThrow()
    expect(() => parseCron('60 9 * * *')).toThrow()
    expect(() => parseCron('0 9 * *')).toThrow()
  })
})

// ---------- the definition check ----------

const askedBy = 'Example Owner, 2026-10-12: "check the inbox every weekday morning"'

describe('the definition (routines/manifest.ts)', () => {
  test('each kind checks out, and the timeout defaults to 120 minutes', () => {
    const sched = checkDefinition('example-sched', { name: 'Example', askedBy, schedule: '57 8 * * 1-5', run: ['node', 'x.js'] })
    expect(sched).toMatchObject({ id: 'example-sched', schedule: '57 8 * * 1-5', timeoutMinutes: 120 })

    const status = checkDefinition('example-status', { name: 'Example', askedBy, status: ['node', 'status.js'], run: ['node', 'tick.js'] })
    expect(status.status).toEqual(['node', 'status.js'])

    const task = checkDefinition('example-task', { name: 'Example', askedBy, windowsTask: '\\Example nightly job' })
    expect(task.windowsTask).toBe('\\Example nightly job')
  })

  test('exactly one of schedule, status or windowsTask', () => {
    expect(() => checkDefinition('example-two', { name: 'E', askedBy, schedule: '0 9 * * *', status: ['x'], run: ['x'] })).toThrow(/exactly one/)
    expect(() => checkDefinition('example-none', { name: 'E', askedBy, run: ['x'] })).toThrow(/exactly one/)
  })

  test('a schedule or status routine has exactly one of run or prompt; a windowsTask routine has neither', () => {
    expect(() => checkDefinition('example-both', { name: 'E', askedBy, schedule: '0 9 * * *', run: ['x'], prompt: 'y', cwd: 'C:/Users/me/project' })).toThrow()
    expect(() => checkDefinition('example-none', { name: 'E', askedBy, schedule: '0 9 * * *' })).toThrow()
    expect(() => checkDefinition('example-task', { name: 'E', askedBy, windowsTask: '\\Example', run: ['x'] })).toThrow(/no "run" or "prompt"/)
  })

  test('a prompt routine needs its cwd', () => {
    expect(() => checkDefinition('example-prompt', { name: 'E', askedBy, schedule: '0 9 * * *', prompt: 'Check it.' })).toThrow(/cwd/)
    expect(checkDefinition('example-prompt', { name: 'E', askedBy, schedule: '0 9 * * *', prompt: 'Check it.', cwd: 'C:/Users/me/project' }).prompt).toBe('Check it.')
  })

  test('askedBy is required, non-empty and at most 500 characters', () => {
    expect(() => checkDefinition('example-a', { name: 'E', schedule: '0 9 * * *', run: ['x'] })).toThrow(/askedBy/)
    expect(() => checkDefinition('example-a', { name: 'E', askedBy: '   ', schedule: '0 9 * * *', run: ['x'] })).toThrow(/askedBy/)
    expect(() => checkDefinition('example-a', { name: 'E', askedBy: 'x'.repeat(501), schedule: '0 9 * * *', run: ['x'] })).toThrow(/500/)
  })

  test('until is a real day, YYYY-MM-DD, and its end is the next local midnight', () => {
    expect(checkDefinition('example-u', { name: 'E', askedBy, schedule: '0 9 * * *', run: ['x'], until: '2026-10-23' }).until).toBe('2026-10-23')
    expect(() => checkDefinition('example-u', { name: 'E', askedBy, schedule: '0 9 * * *', run: ['x'], until: '2026-02-30' })).toThrow()
    expect(untilEndOf('2026-10-23')).toBe(at(2026, 10, 24, 0, 0))
  })

  test('tick is refused with its replacement; the id must be a file name', () => {
    expect(() => checkDefinition('example-t', { name: 'E', askedBy, schedule: '0 9 * * *', tick: ['x'] })).toThrow(/"run"/)
    expect(() => checkDefinition('Bad Id', { name: 'E', askedBy, schedule: '0 9 * * *', run: ['x'] })).toThrow()
  })

  test('describe is true or false, and a Windows task routine is never described', () => {
    expect(checkDefinition('example-d', { name: 'E', askedBy, schedule: '0 9 * * *', run: ['x'], describe: true }).describe).toBe(true)
    expect(() => checkDefinition('example-d', { name: 'E', askedBy, schedule: '0 9 * * *', run: ['x'], describe: 'yes' })).toThrow(/describe/)
    expect(() => checkDefinition('example-d', { name: 'E', askedBy, windowsTask: '\\Example', describe: true })).toThrow(/windowsTask/)
  })

  test('the timeout is 5 to 360 minutes', () => {
    expect(() => checkDefinition('example-m', { name: 'E', askedBy, schedule: '0 9 * * *', run: ['x'], timeoutMinutes: 4 })).toThrow(/timeoutMinutes/)
    expect(() => checkDefinition('example-m', { name: 'E', askedBy, schedule: '0 9 * * *', run: ['x'], timeoutMinutes: 361 })).toThrow(/timeoutMinutes/)
  })
})

// ---------- judging one look ----------

const NOW = at(2026, 10, 12, 9, 30)
const entryOf = (id: string, body: Record<string, unknown>): Entry => ({ id, def: checkDefinition(id, { name: 'Example', askedBy, ...body }), broken: null })
const reading = (over: Partial<Reading> = {}): Reading => ({ nextTickAt: null, lastTickAt: null, off: false, headline: null, totals: null, settings: null, numbers: null, trends: null, ...over })
const seenOf = (entry: Entry, over: Partial<Seen> = {}): Seen => ({ entry, reading: null, readError: null, task: null, ...over })
const memWith = (over: Partial<Memory> = {}): Memory => ({ ...emptyMemory(), ...over })

describe('judging (routines/decide.ts)', () => {
  const sched = entryOf('example-sched', { schedule: '0 9 * * *', run: ['x'] })

  test('the first look of a schedule (no memory) is a baseline: a slot already past never runs', () => {
    const j = judge(seenOf(sched), memWith({ lastSlot: null }), NOW, true, false)
    expect(j.start).toBe(false)
    expect(j.nextRunAt).toBe(at(2026, 10, 13, 9, 0))
  })

  test('the newest missed slot runs once, and the memory moves past it', () => {
    const slot = at(2026, 10, 12, 9, 0)
    const first = judge(seenOf(sched), memWith({ lastSlot: at(2026, 10, 11, 9, 0) }), NOW, true, false)
    expect(first).toMatchObject({ start: true, slot, state: 'due' })
    // Once the run has recorded its slot, the same look starts nothing again.
    const again = judge(seenOf(sched), memWith({ lastSlot: slot }), NOW, true, false)
    expect(again.start).toBe(false)
  })

  // Regression (2026-10-12): memory made while the file was broken (or of another kind) had no slot, and `newest > null`
  // never held, so the routine read "next due" at every look and never ran. One look later it runs from its next slot.
  test('a schedule with no slot remembered takes this look as its baseline and runs at its next slot', () => {
    const mem = memWith({ lastSlot: null })
    const first = judge(seenOf(sched), mem, NOW, true, false)
    expect(first.start).toBe(false)
    if (first.skipSlot !== null) mem.lastSlot = first.skipSlot
    expect(judge(seenOf(sched), mem, at(2026, 10, 13, 9, 1), true, false)).toMatchObject({ start: true, slot: at(2026, 10, 13, 9, 0) })
  })

  // Regression (2026-10-12): a run now while a slot was due left the slot due, so the next look ran it a second time.
  test('a run now while a slot is due is that slot: the next look does not run it again', () => {
    const slot = at(2026, 10, 12, 9, 0)
    const mem = memWith({ lastSlot: at(2026, 10, 11, 9, 0) })
    const manual = judge(seenOf(sched), mem, NOW, false, true)
    expect(manual).toMatchObject({ start: true, slot })
    if (manual.slot !== null) mem.lastSlot = manual.slot
    expect(judge(seenOf(sched), mem, NOW + 5 * MIN, true, false).start).toBe(false)
  })

  test('a slot missed by more than 12 hours is skipped, not run late', () => {
    const slot = at(2026, 10, 11, 9, 0)
    const late = judge(seenOf(sched), memWith({ lastSlot: at(2026, 10, 10, 9, 0) }), at(2026, 10, 11, 9, 0) + MISSED_MS + MIN, true, false)
    expect(late.start).toBe(false)
    expect(late.skipSlot).toBe(slot)
    expect(late.state).toBe('idle')
  })

  test('a paused routine never starts on its own', () => {
    const j = judge(seenOf(sched), memWith({ lastSlot: at(2026, 10, 11, 9, 0), paused: true }), NOW, true, false)
    expect(j).toMatchObject({ state: 'paused', start: false })
  })

  test('an ended routine (past until) is listed as ended and never runs', () => {
    const ended = entryOf('example-ended', { schedule: '0 9 * * *', run: ['x'], until: '2026-10-11' })
    const j = judge(seenOf(ended), memWith({ lastSlot: at(2026, 10, 11, 9, 0) }), NOW, true, false)
    expect(j).toMatchObject({ state: 'ended', start: false })
    const manual = judge(seenOf(ended), memWith(), NOW, true, true)
    expect(manual.state).toBe('ended')
  })

  test('a running routine is not started again', () => {
    const j = judge(seenOf(sched), memWith({ lastSlot: at(2026, 10, 11, 9, 0), running: { startedAt: NOW, kind: 'command', pid: null, workerId: null, sessionId: null } }), NOW, true, false)
    expect(j).toMatchObject({ state: 'running', start: false })
  })

  test('with the manager off, a due routine waits and starts nothing', () => {
    const j = judge(seenOf(sched), memWith({ lastSlot: at(2026, 10, 11, 9, 0) }), NOW, false, false)
    expect(j).toMatchObject({ state: 'due', start: false })
  })

  test('a status routine waits 15 minutes after its last run, and a manual run skips the wait', () => {
    const status = entryOf('example-status', { status: ['x'], run: ['y'] })
    const last = NOW - 5 * MIN
    const r = reading({ nextTickAt: NOW - MIN, lastTickAt: last })
    const soon = judge(seenOf(status, { reading: r }), memWith({ runs: [{ startedAt: last - MIN, endedAt: last, outcome: 'ok', exitCode: 0, lastLine: '', workerId: null, sessionId: null }] }), NOW, true, false)
    expect(soon.start).toBe(false)
    expect(MIN_GAP_MS).toBe(15 * MIN)

    const later = NOW + 11 * MIN
    const after = judge(seenOf(status, { reading: r }), memWith({ runs: [{ startedAt: last - MIN, endedAt: last, outcome: 'ok', exitCode: 0, lastLine: '', workerId: null, sessionId: null }] }), later, true, false)
    expect(after.start).toBe(true)

    const manual = judge(seenOf(status, { reading: r }), memWith({ runs: [{ startedAt: last - MIN, endedAt: last, outcome: 'ok', exitCode: 0, lastLine: '', workerId: null, sessionId: null }] }), NOW, true, true)
    expect(manual.start).toBe(true)
  })

  test('a status that says off, or a broken file, is never started', () => {
    const status = entryOf('example-status', { status: ['x'], run: ['y'] })
    expect(judge(seenOf(status, { reading: reading({ off: true }) }), memWith(), NOW, true, true)).toMatchObject({ state: 'off', start: false })
    const broken: Entry = { id: 'example-bad', def: null, broken: 'its file does not check out' }
    expect(judge(seenOf(broken), memWith(), NOW, true, true)).toMatchObject({ state: 'broken', start: false })
  })
})

// ---------- the Windows task reading ----------

describe('Windows tasks (routines/wintask.ts)', () => {
  const canned = JSON.stringify([
    { path: '\\Example nightly job', found: true, state: 'Ready', lastRunTime: '2026-10-11T02:00:00', lastTaskResult: 0, nextRunTime: '2026-10-12T02:00:00' },
    { path: '\\Example stuck job', found: true, state: 'Disabled', lastRunTime: '1899-12-30T00:00:00', lastTaskResult: 267011, nextRunTime: null },
    { path: '\\Example failing job', found: true, state: 'Running', lastRunTime: '2026-10-12T08:00:00', lastTaskResult: 267009, nextRunTime: null },
  ])

  test('reads each named task from one canned answer; a task not in it is not found', () => {
    const paths = ['\\Example nightly job', '\\Example stuck job', '\\Example failing job', '\\Example missing job']
    const rows = parseTaskReadings(canned, paths)
    expect(rows.map((r) => r.path)).toEqual(paths)
    expect(rows[0]).toMatchObject({ found: true, state: 'Ready', lastTaskResult: 0, lastRunAt: Date.parse('2026-10-11T02:00:00'), nextRunAt: Date.parse('2026-10-12T02:00:00') })
    expect(rows[3]).toMatchObject({ found: false, state: null, lastRunAt: null, lastTaskResult: null, nextRunAt: null })
  })

  test('Windows says 1899 for a task that never ran: no run to record', () => {
    const row: TaskReading = parseTaskReadings(canned, ['\\Example stuck job'])[0]
    expect(row.lastRunAt).toBeNull()
    expect(row.state).toBe('Disabled')
  })

  test('a reply that is not JSON is an error, not an empty list', () => {
    expect(() => parseTaskReadings('Access denied', ['\\Example'])).toThrow()
  })

  // The real read on Windows PowerShell 5.1, which writes a parsed JSON list as one object: @(ConvertFrom-Json ...) once
  // made every path one item, the script exited 1, and every windowsTask routine read as broken while the canned tests
  // above passed. Tasks that do not exist: no real task is touched.
  test.skipIf(process.platform !== 'win32')('the read script answers one reading per path; a missing task is not found', async () => {
    const paths = ['\\Example missing task one', '\\Example missing task two']
    const rows = await readTasks(paths)
    expect(rows.map((r) => [r.path, r.found])).toEqual([[paths[0], false], [paths[1], false]])
  }, 60_000)
})

// ---------- the plugin ----------

const temps: string[] = []
const stops: (() => void | Promise<void>)[] = []
const prevHome = process.env.HYDRA_DESK_HOME
afterEach(async () => {
  for (const s of stops.splice(0)) await s()
  for (const d of temps.splice(0)) if (d) rmSync(d, { recursive: true, force: true })
  if (prevHome === undefined) delete process.env.HYDRA_DESK_HOME
  else process.env.HYDRA_DESK_HOME = prevHome
})

// The fake command: `tick` counts a line in its file and exits 0, `wait` exits 0 once <file>.go exists (or a minute passes),
// `busy` says so and exits 75.
const COMMAND = `const fs = require('node:fs')
const [mode, file] = process.argv.slice(2)
if (mode === 'tick') {
  fs.appendFileSync(file, 'tick\\n')
  console.log('first line of the run')
  console.log('done: 3 items checked')
  process.exit(0)
} else if (mode === 'wait') {
  const until = Date.now() + 60_000
  const poll = () => {
    if (fs.existsSync(file + '.go') || Date.now() > until) {
      console.log('done after the restart')
      process.exit(0)
    }
    setTimeout(poll, 50)
  }
  poll()
} else {
  console.log('busy: another run holds the lock')
  process.exit(75)
}
`

interface Desk {
  home: string
  app: Hono
  count: string
  settings: Record<string, unknown>
  /** The argv of the fake command in `mode`. */
  argv(mode: string): string[]
  /** Writes routines/<id>.json. */
  routine(id: string, body: Record<string, unknown>): void
  /** The clock the plugin reads: set it to move time on. */
  clock: { now: number }
  tasks: { read: string[][]; run: string[]; setEnabled: [string, boolean][] }
  /** Stops this Desk, as a restart does. */
  stop(): Promise<void>
}

/** A Desk over a temp home, or over `home` again: the Desk that starts after a restart. */
function desk(opts: Partial<RoutinesOptions> = {}, again?: string): Desk {
  const home = again ?? mkdtempSync(join(tmpdir(), 'desk-routines-'))
  if (!again) temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const dir = join(home, 'routines')
  mkdirSync(dir, { recursive: true })
  const script = join(home, 'command.cjs')
  writeFileSync(script, COMMAND)
  const count = join(home, 'ticks.txt')
  const settings: Record<string, unknown> = { routines: true }
  const app = new Hono()
  const own: (() => void | Promise<void>)[] = []
  const ctx = {
    home,
    settings: () => settings as unknown as DeskSettings,
    updateSettings: (patch: Partial<DeskSettings>) => Object.assign(settings, patch),
    onStop: (fn: () => void | Promise<void>) => {
      own.push(fn)
      stops.push(fn)
    },
    deps: {},
  } as unknown as ServerContext
  const clock = { now: at(2026, 10, 12, 9, 0) + 30_000 }
  const tasks = { read: [] as string[][], run: [] as string[], setEnabled: [] as [string, boolean][] }
  const fakeTasks: RoutineTasks = {
    read: async (paths) => {
      tasks.read.push(paths)
      return paths.map((path) => ({ path, found: true, state: 'Ready', lastRunAt: null, lastTaskResult: 0, nextRunAt: at(2026, 10, 12, 2, 0) }))
    },
    run: async (path) => {
      tasks.run.push(path)
    },
    setEnabled: async (path, enabled) => {
      tasks.setEnabled.push([path, enabled])
    },
  }
  plugin(app, ctx, { now: () => clock.now, tasks: fakeTasks, platform: 'win32', ...opts })
  return {
    home,
    app,
    count,
    settings,
    argv: (mode) => [process.execPath, script, mode, count],
    routine: (id, body) => writeFileSync(join(dir, `${id}.json`), JSON.stringify(body)),
    clock,
    tasks,
    stop: async () => {
      for (const fn of own.splice(0)) {
        stops.splice(stops.indexOf(fn), 1)
        await fn()
      }
    },
  }
}

const OWNER = { 'X-Desk-Caller': 'window' }
const post = (app: Hono, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/api/routines', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const get = async (app: Hono, fresh = false): Promise<RoutinesStatus> => (await (await app.request(fresh ? '/api/routines?fresh=1' : '/api/routines')).json()) as RoutinesStatus

/** Reads the status until `done` holds, or 20 seconds pass. */
async function settle(app: Hono, done: (s: RoutinesStatus) => boolean): Promise<RoutinesStatus> {
  const until = Date.now() + 20_000
  let s = await get(app)
  while (!done(s) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50))
    s = await get(app)
  }
  return s
}

const ticks = (file: string): number => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l === 'tick').length : 0)

/** A run's runner file, or null while there is none. */
const readRun = (file: string): RunFile | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RunFile
  } catch {
    return null
  }
}

describe('the plugin', () => {
  test('a run routine runs once on its slot, a second look does not run it again, and a run now runs it at once', async () => {
    const d = desk()
    d.routine('example-every-minute', { name: 'Example every minute', askedBy, schedule: '* * * * *', run: d.argv('tick'), timeoutMinutes: 5 })

    // The first look is a baseline: the 09:00 slot is already past, so nothing runs.
    const first = await get(d.app, true)
    expect(first.routines[0]).toMatchObject({ id: 'example-every-minute', state: 'idle' })
    expect(ticks(d.count)).toBe(0)

    // A minute later the 09:01 slot is due: it runs once.
    d.clock.now = at(2026, 10, 12, 9, 1) + 30_000
    await get(d.app, true)
    const ran = await settle(d.app, (s) => s.routines[0].runs.length === 1)
    expect(ran.routines[0].runs[0]).toMatchObject({ outcome: 'ok', exitCode: 0, lastLine: 'done: 3 items checked' })
    expect(ticks(d.count)).toBe(1)

    // The same slot, looked at again, runs nothing.
    await get(d.app, true)
    expect(ticks(d.count)).toBe(1)

    // Run now runs it at once, whatever the slot.
    const res = await post(d.app, { run: 'example-every-minute' })
    expect(res.status).toBe(200)
    await settle(d.app, (s) => s.routines[0].runs.length === 2)
    expect(ticks(d.count)).toBe(2)
    // Two real process starts: on a busy PC each takes seconds, past the 5 s default (it timed out at 6.6 and 8.2 s).
  }, 30_000)

  // Regression (2026-10-12): on Windows a process Desk starts dies with Desk, and the next Desk closed a command run it found
  // marked running as interrupted; another chat's restart killed an Archangel tick 16 minutes in. A run now has its own
  // runner outside Desk's process tree, and the Desk after a restart goes on watching it.
  test('a command run outlives a Desk restart: the next Desk goes on watching it and records how it ended', async () => {
    const a = desk()
    a.routine('example-long', { name: 'Example long', askedBy, schedule: '0 9 * * *', run: a.argv('wait'), timeoutMinutes: 5 })
    await get(a.app, true)
    expect((await post(a.app, { run: 'example-long' })).status).toBe(200)
    // Its runner is up: it named its pid.
    const up = await settle(a.app, (s) => typeof s.routines[0].running?.pid === 'number')
    expect(up.routines[0].state).toBe('running')
    await a.stop()

    const b = desk({}, a.home)
    const after = await get(b.app, true)
    expect(after.routines[0]).toMatchObject({ state: 'running', runs: [] })
    writeFileSync(`${a.count}.go`, '')
    const ended = await settle(b.app, (s) => s.routines[0].runs.length === 1)
    expect(ended.routines[0].runs[0]).toMatchObject({ outcome: 'ok', exitCode: 0, lastLine: 'done after the restart' })
    expect(ended.routines[0].running).toBeNull()
  }, 60_000)

  // On Windows Bun ends a killed runner's command with it; elsewhere the command leads its own process group, which the next
  // look ends once it finds the runner gone (2026-10-13). Off Windows this is unrun on the PC that wrote it.
  test('a runner killed hard leaves no command running, and its run is recorded interrupted', async () => {
    const d = desk()
    d.routine('example-killed', { name: 'Example killed', askedBy, schedule: '0 9 * * *', run: d.argv('wait'), timeoutMinutes: 5 })
    await get(d.app, true)
    expect((await post(d.app, { run: 'example-killed' })).status).toBe(200)
    const runFile = join(d.home, 'routines', 'runs', 'example-killed.run.json')
    const until = Date.now() + 20_000
    let said = readRun(runFile)
    while (!said?.commandPid && Date.now() < until) {
      await Bun.sleep(50)
      said = readRun(runFile)
    }
    const commandPid = said?.commandPid ?? 0
    expect(commandPid).toBeGreaterThan(0)
    process.kill(said!.pid, 'SIGKILL')

    const ended = await settle(d.app, (s) => s.routines[0].runs.length === 1)
    expect(ended.routines[0].runs[0]).toMatchObject({ outcome: 'interrupted', lastLine: 'its runner ended without saying how the run ended' })
    // Gone, or its number since taken by a process that started later.
    const stillIt = async () => pidAlive(commandPid) && (await recordedPidOwner(commandPid, said!.commandStartedAt!)) === 'ours'
    const gone = Date.now() + 10_000
    while ((await stillIt()) && Date.now() < gone) await Bun.sleep(50)
    expect(await stillIt()).toBe(false)
  }, 60_000)

  // A run is settled by the kind it started as (2026-10-13): a command run whose routine had become a prompt routine was
  // closed as a prompt run that never got its chat while its command ran on, so a second run could start beside it.
  test('a command run stays a command run when its routine is rewritten into a prompt routine meanwhile', async () => {
    const noChats: RoutineWorkers = { start: async () => Promise.reject(new Error('no chats in this test')), read: async () => null, cancel: async () => {} }
    const d = desk({ workers: noChats })
    const base = { name: 'Example changed', askedBy, schedule: '0 9 * * *', timeoutMinutes: 5 }
    d.routine('example-changed', { ...base, run: d.argv('wait') })
    await get(d.app, true)
    expect((await post(d.app, { run: 'example-changed' })).status).toBe(200)
    await settle(d.app, (s) => typeof s.routines[0].running?.pid === 'number')

    d.routine('example-changed', { ...base, prompt: 'Example task', cwd: d.home })
    const after = await get(d.app, true)
    expect(after.routines[0]).toMatchObject({ state: 'running', runs: [] })
    writeFileSync(`${d.count}.go`, '')
    const ended = await settle(d.app, (s) => s.routines[0].runs.length === 1)
    expect(ended.routines[0].runs[0]).toMatchObject({ outcome: 'ok', exitCode: 0 })
  }, 60_000)

  // Regression (2026-10-13): a launcher that could not start was ignored, so the run read "running" for a minute and then
  // "did not start within 60 seconds", its reason lost. Windows only: elsewhere the runner is started directly.
  test.skipIf(process.platform !== 'win32')("a run whose runner cannot be launched fails at once, with the launcher's reason", async () => {
    const d = desk()
    d.routine('example-unlaunched', { name: 'Example unlaunched', askedBy, schedule: '0 9 * * *', run: d.argv('tick'), timeoutMinutes: 5 })
    await get(d.app, true)
    // No powershell on the path: the launcher cannot start.
    const path = process.env.PATH
    process.env.PATH = join(d.home, 'no-programs-here')
    try {
      expect((await post(d.app, { run: 'example-unlaunched' })).status).toBe(200)
    } finally {
      process.env.PATH = path
    }
    const s = await settle(d.app, (x) => x.routines[0].runs.length === 1)
    expect(s.routines[0].runs[0]).toMatchObject({ outcome: 'failed' })
    expect(s.routines[0].runs[0].lastLine).toStartWith('its runner could not start: ')
    expect(s.routines[0].runs[0].lastLine).toContain('powershell')
    expect(existsSync(join(d.home, 'routines', 'runs', 'example-unlaunched.spec.json'))).toBe(false)
    expect(ticks(d.count)).toBe(0)
  }, 30_000)

  // A prompt run is marked running before its chat starts. When Desk stops in that moment, no chat id was kept: nothing
  // would ever watch it, so the routine read "running" for good (a review of the runner change, 2026-10-12).
  test('a prompt run whose chat had not started when Desk stopped is closed, and the routine runs again', async () => {
    const stuck: RoutineWorkers = { start: () => new Promise(() => {}), read: async () => null, cancel: async () => {} }
    const a = desk({ workers: stuck })
    a.routine('example-prompt', { name: 'Example prompt', askedBy, schedule: '0 9 * * *', prompt: 'Example task', cwd: a.home, timeoutMinutes: 5 })
    await get(a.app, true)
    expect((await post(a.app, { run: 'example-prompt' })).status).toBe(200)
    await a.stop()

    const b = desk({ workers: stuck }, a.home)
    const after = await get(b.app, true)
    expect(after.routines[0].running).toBeNull()
    expect(after.routines[0].runs[0]).toMatchObject({ outcome: 'interrupted', lastLine: 'AgentHydra restarted before its chat started' })
    expect((await post(b.app, { run: 'example-prompt' })).status).toBe(200)
  })

  // Regression (2026-10-12): the memory was a plain object, so a routine named "constructor" (a valid id) took Object's
  // own function as its memory and every read of the list failed.
  test('a routine whose id names an Object property lists like any other', async () => {
    const d = desk()
    d.routine('constructor', { name: 'Example constructor', askedBy, schedule: '0 9 * * *', run: d.argv('tick'), timeoutMinutes: 5 })
    const res = await d.app.request('/api/routines?fresh=1')
    expect(res.status).toBe(200)
    expect(((await res.json()) as RoutinesStatus).routines[0]).toMatchObject({ id: 'constructor', state: 'idle' })
  })

  test('a paused routine is refused a run now (409) and never starts on its own', async () => {
    const d = desk()
    d.routine('example-paused', { name: 'Example paused', askedBy, schedule: '* * * * *', run: d.argv('tick'), timeoutMinutes: 5 })
    await get(d.app, true)
    expect((await post(d.app, { pause: 'example-paused' })).status).toBe(200)
    d.clock.now = at(2026, 10, 12, 9, 5)
    const s = await get(d.app, true)
    expect(s.routines[0]).toMatchObject({ state: 'paused', paused: true })
    const refused = await post(d.app, { run: 'example-paused' })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain('paused')
    expect(ticks(d.count)).toBe(0)
  })

  test('the owner only: an agent gets 403 for resume, approve, discard and the switch; the window gets them', async () => {
    const d = desk()
    d.routine('example-owned', { name: 'Example owned', askedBy, schedule: '* * * * *', run: d.argv('tick'), timeoutMinutes: 5 })
    await get(d.app, true)
    for (const body of [{ resume: 'example-owned' }, { approve: 'example-owned' }, { discard: 'example-owned' }, { edit: { id: 'example-owned', set: { name: 'Example renamed' } } }, { enabled: false }]) {
      const res = await post(d.app, body)
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: string }).error).toBe('only the owner can do that, in Settings > Managers > Routines')
    }
    expect(d.settings.routines).toBe(true)

    expect((await post(d.app, { pause: 'example-owned' })).status).toBe(200)
    expect((await post(d.app, { resume: 'example-owned' }, OWNER)).status).toBe(200)
    expect((await post(d.app, { enabled: false }, OWNER)).status).toBe(200)
    expect(d.settings.routines).toBe(false)
  })

  test('a proposal is never run: it waits for the owner, approve moves it into routines without why, discard deletes it', async () => {
    const d = desk()
    const why = 'It checks the inbox each morning, which a background task would forget.'
    const proposal = { id: 'example-proposed', name: 'Example proposed', askedBy, schedule: '* * * * *', run: d.argv('tick'), timeoutMinutes: 5, why }

    // Propose is open to an agent. It waits as a proposal and runs nothing.
    const made = await post(d.app, { propose: proposal })
    expect(made.status).toBe(200)
    const waiting = (await made.json()) as RoutinesStatus
    expect(waiting.proposals).toHaveLength(1)
    expect(waiting.proposals[0]).toMatchObject({ id: 'example-proposed', why })
    expect(waiting.routines.some((r) => r.id === 'example-proposed')).toBe(false)
    d.clock.now = at(2026, 10, 12, 9, 5)
    await get(d.app, true)
    expect(ticks(d.count)).toBe(0)

    // An agent cannot approve it; the window can. The file keeps the contract and drops why.
    expect((await post(d.app, { approve: 'example-proposed' })).status).toBe(403)
    expect((await post(d.app, { approve: 'example-proposed' }, OWNER)).status).toBe(200)
    const file = JSON.parse(readFileSync(join(d.home, 'routines', 'example-proposed.json'), 'utf8')) as Record<string, unknown>
    expect(file.why).toBeUndefined()
    expect(file.name).toBe('Example proposed')
    const approved = await get(d.app, true)
    expect(approved.proposals).toHaveLength(0)
    expect(approved.routines.some((r) => r.id === 'example-proposed')).toBe(true)

    // A discarded proposal is gone, and proposing an id that exists refuses.
    expect((await post(d.app, { propose: { ...proposal, id: 'example-other' } })).status).toBe(200)
    expect((await post(d.app, { discard: 'example-other' }, OWNER)).status).toBe(200)
    expect(existsSync(join(d.home, 'routines', 'proposed', 'example-other.json'))).toBe(false)
    expect((await post(d.app, { propose: proposal })).status).toBe(409)
  })

  test('a proposal that does not check out is refused with the reason (400), one without why too', async () => {
    const d = desk()
    const base = { id: 'example-bad', name: 'Example', askedBy, schedule: '* * * * *', run: d.argv('tick'), timeoutMinutes: 5 }
    expect((await post(d.app, { propose: base })).status).toBe(400)
    expect((await post(d.app, { propose: { ...base, why: 'Because.', schedule: 'MON' } })).status).toBe(400)
  })

  test('the body takes one action per call, and anything else answers 400 with the shape', async () => {
    const d = desk()
    expect((await post(d.app, { run: 'a', pause: 'b' })).status).toBe(400)
    expect((await post(d.app, { nothing: true })).status).toBe(400)
    const res = await post(d.app, { run: 42 })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('"run"')
  })

  test('a Windows task routine: read in one call, paused by Windows Disabled, and off Windows it is broken', async () => {
    const d = desk()
    d.routine('example-task', { name: 'Example task', askedBy, windowsTask: '\\Example nightly job' })
    const s = await get(d.app, true)
    expect(s.routines[0]).toMatchObject({ id: 'example-task', kind: 'windowsTask', state: 'idle', windowsTask: '\\Example nightly job' })
    expect(d.tasks.read.length).toBeGreaterThan(0)

    // Pause and resume are Windows' Disabled state, through schtasks, one call each.
    expect((await post(d.app, { pause: 'example-task' })).status).toBe(200)
    expect((await post(d.app, { resume: 'example-task' }, OWNER)).status).toBe(200)
    expect(d.tasks.setEnabled).toEqual([['\\Example nightly job', false], ['\\Example nightly job', true]])
    expect((await post(d.app, { run: 'example-task' })).status).toBe(200)
    expect(d.tasks.run).toEqual(['\\Example nightly job'])

    // A run is recorded at the time Windows ran it, never at the time of the look (a 03:00 run read "21 min ago").
    const ran = at(2026, 10, 12, 3, 0)
    const nightly = desk({
      tasks: {
        read: async (paths) => paths.map((path) => ({ path, found: true, state: 'Ready', lastRunAt: ran, lastTaskResult: 1, nextRunAt: at(2026, 10, 13, 3, 0) })),
        run: async () => {},
        setEnabled: async () => {},
      },
    })
    nightly.routine('example-task', { name: 'Example task', askedBy, windowsTask: '\\Example nightly job' })
    const read = (await get(nightly.app, true)).routines[0]
    expect(read.runs[0]).toMatchObject({ startedAt: ran, endedAt: ran, outcome: 'failed', exitCode: 1 })
    expect(read.lastRunAt).toBe(ran)

    const elsewhere = desk({ platform: 'linux' })
    elsewhere.routine('example-task', { name: 'Example task', askedBy, windowsTask: '\\Example nightly job' })
    const off = await get(elsewhere.app, true)
    expect(off.routines[0]).toMatchObject({ state: 'broken' })
    expect(off.routines[0].reason).toContain('Windows')
  })

  // Owner, 2026-10-13: "every time they finish, to have a, like, AI description of what they did".
  test('a routine that describes its runs: a run that printed gets an account of its output, a failed ask keeps its reason, a busy run gets none', async () => {
    const asked: DescribeRequest[] = []
    let fail = false
    const d = desk({
      describer: async (req) => {
        asked.push(req)
        if (fail) throw new Error('no account has room to describe it')
        return 'It checked 3 items and changed nothing.'
      },
    })
    const body = { name: 'Example described', askedBy, schedule: '0 9 * * *', timeoutMinutes: 5, describe: true }
    d.routine('example-described', { ...body, run: d.argv('tick') })
    expect((await get(d.app, true)).routines[0].describe).toBe(true)
    expect((await post(d.app, { run: 'example-described' })).status).toBe(200)
    const done = await settle(d.app, (s) => s.routines[0].runs[0]?.description?.state === 'done')
    expect(done.routines[0].runs[0].description).toEqual({ state: 'done', text: 'It checked 3 items and changed nothing.' })
    expect(asked[0]).toMatchObject({ name: 'Example described', what: 'command', outcome: 'ok', exitCode: 0 })
    expect(asked[0].output).toContain('first line of the run')
    expect(asked[0].output).toContain('done: 3 items checked')

    fail = true
    d.clock.now += MIN
    expect((await post(d.app, { run: 'example-described' })).status).toBe(200)
    const failed = await settle(d.app, (s) => s.routines[0].runs.length === 2 && s.routines[0].runs[0].description?.state === 'failed')
    expect(failed.routines[0].runs[0].description).toEqual({ state: 'failed', text: 'no account has room to describe it' })

    // A busy run printed why it waited, and is not described: its last line says it.
    d.routine('example-described', { ...body, run: d.argv('busy') })
    d.clock.now += MIN
    expect((await post(d.app, { run: 'example-described' })).status).toBe(200)
    const busy = await settle(d.app, (s) => s.routines[0].runs.length === 3)
    expect(busy.routines[0].runs[0]).toMatchObject({ outcome: 'busy', lastLine: 'busy: another run holds the lock' })
    expect(busy.routines[0].runs[0].description).toBeUndefined()
    expect(asked).toHaveLength(2)
  }, 60_000)

  // Owner, 2026-10-13: "I need to be able to, like, edit them ... I can't rename them either".
  test("an edit writes the routine's own file: the keys it names, null removing one, the rest as it was; one that would not check out is refused and the file left alone", async () => {
    const d = desk()
    const body = { name: 'Example edit', askedBy, schedule: '0 9 * * *', run: d.argv('tick'), timeoutMinutes: 5, until: '2026-10-23' }
    d.routine('example-edit', body)
    await get(d.app, true)
    const res = await post(d.app, { edit: { id: 'example-edit', set: { name: 'Example renamed', describe: true, until: null } } }, OWNER)
    expect(res.status).toBe(200)
    expect(((await res.json()) as RoutinesStatus).routines[0]).toMatchObject({ name: 'Example renamed', describe: true, until: null })
    const file = join(d.home, 'routines', 'example-edit.json')
    const kept: Record<string, unknown> = { ...body, name: 'Example renamed', describe: true }
    delete kept.until
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(kept)

    const before = readFileSync(file, 'utf8')
    const refused = await post(d.app, { edit: { id: 'example-edit', set: { schedule: 'MON' } } }, OWNER)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toStartWith('"example-edit" was not saved: ')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  // Regression (2026-10-13): a Desk that did not know a new key read Archangel's file as broken and listed it by its file
  // name, "michaiel".
  test('a routine whose file does not check out keeps the name the file gives it', async () => {
    const d = desk()
    d.routine('example-broken', { name: 'Example broken', askedBy, schedule: '0 9 * * *', run: d.argv('tick'), notAKey: true })
    expect((await get(d.app, true)).routines[0]).toMatchObject({ id: 'example-broken', name: 'Example broken', state: 'broken' })
  })

  test('a description still being written when Desk stopped reads failed after the restart, never pending for good', async () => {
    const never: Describer = () => new Promise(() => {})
    const a = desk({ describer: never })
    a.routine('example-cut', { name: 'Example cut', askedBy, schedule: '0 9 * * *', run: a.argv('tick'), timeoutMinutes: 5, describe: true })
    await get(a.app, true)
    expect((await post(a.app, { run: 'example-cut' })).status).toBe(200)
    await settle(a.app, (s) => s.routines[0].runs[0]?.description?.state === 'pending')
    await a.stop()

    const b = desk({ describer: never }, a.home)
    const after = await get(b.app, true)
    expect(after.routines[0].runs[0].description).toEqual({ state: 'failed', text: 'AgentHydra restarted before it was described' })
  }, 30_000)
})

describe('describing a run (routines/describe.ts)', () => {
  test('the question keeps the end of a long output, where a run says what it did; an answer comes back as one plain paragraph', () => {
    const output = `${'x'.repeat(DESCRIBE_INPUT_CHARS)}\ntick 1: found 3, landed 1`
    const q = describePrompt({ name: 'Example', what: 'command', outcome: 'ok', exitCode: 0, minutes: 1.9, output })
    expect(q).toContain('tick 1: found 3, landed 1')
    expect(q.length).toBeLessThan(DESCRIBE_INPUT_CHARS + 300)
    expect(cleanDescription('**Summary:** It landed\n\none fix.')).toBe('It landed one fix.')
  })
})

describe('settings (a stale key from the manager\'s old name)', () => {
  test('a settings file that still holds the old key loads without an error, and routines defaults on', () => {
    // The manager's name before Routines, assembled so the old name appears nowhere in the source.
    const old = ['arch', 'aingel'].join('')
    const home = mkdtempSync(join(tmpdir(), 'desk-routines-settings-'))
    temps.push(home)
    writeFileSync(settingsPath(home), JSON.stringify({ [old]: true }))
    const settings = loadSettings(home) as unknown as Record<string, unknown>
    expect(settings.routines).toBe(true)
    expect(old in settings).toBe(false)
  })

  // A failed run opens its routine's incident (AgentHydra pings the owner); the routine's next ok run resolves it.
  // A busy run is not a failure and touches no incident. The incidents seam records the calls.
  test("a failed run opens the routine's incident, its next ok run resolves it, a busy run touches none", async () => {
    const sent: unknown[][] = []
    const d = desk({
      incidents: {
        record: async (body) => void sent.push(['record', body]),
        resolve: async (scope, key) => void sent.push(['resolve', scope, key]),
      },
    })
    d.routine('example-inbox', { name: 'Example inbox', askedBy, schedule: '0 9 * * *', run: [process.execPath, '-e', "console.log('boom'); process.exit(1)"], timeoutMinutes: 5 })
    await get(d.app, true)
    expect((await post(d.app, { run: 'example-inbox' })).status).toBe(200)
    const failed = await settle(d.app, (s) => s.routines[0].runs.length === 1)
    expect(failed.routines[0].runs[0]).toMatchObject({ outcome: 'failed' })
    expect(sent).toEqual([['record', { scope: 'routine', key: 'example-inbox', message: expect.stringMatching(/^Example inbox: /) }]])

    d.routine('example-inbox', { name: 'Example inbox', askedBy, schedule: '0 9 * * *', run: d.argv('tick'), timeoutMinutes: 5 })
    await get(d.app, true)
    expect((await post(d.app, { run: 'example-inbox' })).status).toBe(200)
    await settle(d.app, (s) => s.routines[0].runs.length === 2)
    expect(sent.at(-1)).toEqual(['resolve', 'routine', 'example-inbox'])

    sent.length = 0
    d.routine('example-inbox', { name: 'Example inbox', askedBy, schedule: '0 9 * * *', run: d.argv('busy'), timeoutMinutes: 5 })
    await get(d.app, true)
    expect((await post(d.app, { run: 'example-inbox' })).status).toBe(200)
    const busy = await settle(d.app, (s) => s.routines[0].runs.length === 3)
    expect(busy.routines[0].runs[0]).toMatchObject({ outcome: 'busy' })
    expect(sent).toEqual([])
  }, 60_000)

  // A routine whose file breaks opens one incident (not one per look), and checks out again: its incident resolves,
  // unless its last run failed, whose incident shares the key and stays open.
  test('a broken routine file opens one incident until it checks out; a failed last run keeps its incident open', async () => {
    const sent: unknown[][] = []
    const d = desk({
      incidents: {
        record: async (body) => void sent.push(['record', body]),
        resolve: async (scope, key) => void sent.push(['resolve', scope, key]),
      },
    })
    const body = { name: 'Example inbox', askedBy, schedule: '0 9 * * *', run: [process.execPath, '-e', "console.log('boom'); process.exit(1)"], timeoutMinutes: 5 }
    d.routine('example-inbox', body)
    await get(d.app, true)
    expect((await post(d.app, { run: 'example-inbox' })).status).toBe(200)
    await settle(d.app, (s) => s.routines[0].runs.length === 1)
    expect(sent.map((c) => c[0])).toEqual(['record'])

    d.routine('example-inbox', { ...body, notAKey: true })
    await get(d.app, true)
    await get(d.app, true)
    expect(sent.slice(1)).toEqual([['record', { scope: 'routine', key: 'example-inbox', message: expect.stringMatching(/^Example inbox: routine file is broken: .+\. Fix ~\/\.hydra-desk-2\/routines\/example-inbox\.json$/) }]])

    d.routine('example-inbox', body)
    await get(d.app, true)
    expect(sent.map((c) => c[0])).toEqual(['record', 'record'])
  }, 60_000)
})

describe('GET /api/routines/:id/details', () => {
  test('answers the whole history in pages with stats and the status extras, and 404s an unknown routine', async () => {
    const d = desk()
    d.routine('example-every-minute', { name: 'Example every minute', askedBy, schedule: '* * * * *', run: d.argv('tick'), timeoutMinutes: 5 })
    const runs = [3, 2, 1].map((n) => ({ startedAt: n * 1000, endedAt: n * 1000 + 500, outcome: 'ok', exitCode: 0, lastLine: `tick ${n}: landed ${n}`, workerId: null, sessionId: null }))
    writeFileSync(join(d.home, 'routines.json'), JSON.stringify({ routines: { 'example-every-minute': { ...emptyMemory(null), runs } } }))
    await d.stop()
    const again = desk({}, d.home)
    await get(again.app, true)
    const res = await again.app.request('/api/routines/example-every-minute/details?limit=2')
    const body = (await res.json()) as { runs: { startedAt: number }[]; nextBefore: number; stats: { total: number }; counters: Record<string, number> }
    expect(body.runs.map((r) => r.startedAt)).toEqual([3000, 2000])
    expect(body.nextBefore).toBe(2000)
    expect(body.stats.total).toBe(3)
    expect(body.counters).toEqual({ landed: 6 })
    const rest = (await (await again.app.request(`/api/routines/example-every-minute/details?before=${body.nextBefore}`)).json()) as { runs: unknown[]; nextBefore: number | null }
    expect(rest.runs).toHaveLength(1)
    expect(rest.nextBefore).toBeNull()
    expect((await again.app.request('/api/routines/nope/details')).status).toBe(404)
  })
})
