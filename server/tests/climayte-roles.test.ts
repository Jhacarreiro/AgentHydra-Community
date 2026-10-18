// server/tests/climayte-roles.test.ts — every CliMayte worker is a prime, a seat or a drone, and a
// drone never dispatches. The refusal runs in the daemon (climayteRun, climayteWaveStart) from the
// caller the route resolved, so a drone cannot skip it by how it calls. Fixtures are invented.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteRun,
  climayteWaveStart,
  journalTooBig,
  killsLanded,
  setCliMayteAccountsProvider,
} from '../src/climayte'
import { JOURNAL_PATH, workers } from '../src/climayte-core'
import { readJournal } from '../src/climayte-journal'
import {
  type CliMayteWorker,
  DRONE_BRIEF,
  DRONE_REFUSAL,
  roleOf,
  tooBigOf,
  toReport,
  toView,
  WORKER_BRIEF,
} from '../src/climayte-lib'
import { addSeatChat } from '../src/hydra-core/seat-chats'

const scratch = mkdtempSync(join(tmpdir(), 'climayte-roles-'))
const CWD = join(scratch, 'repo')
const CORE = join(scratch, 'core')
const PERSONA = 'person:iris-design'
const GROUP = 'roles-test'
const prevCore = process.env.AGENTHYDRA_CORE_DIR

beforeAll(() => {
  mkdirSync(CWD, { recursive: true })
  mkdirSync(join(CORE, 'catalog'), { recursive: true })
  writeFileSync(
    join(CORE, 'catalog', 'hand-test.json'),
    JSON.stringify([
      {
        id: PERSONA,
        kind: 'person',
        name: 'Iris',
        title: 'UI designer',
        tier: 'employee',
        family: 'expert',
        modes: ['consult'],
        when: 'Reviews interface layouts for the example app.',
        tags: ['design'],
        cost: 'low',
        how: 'Looks at the screen and reports what is off.',
        load: { type: 'none' },
      },
    ]),
  )
  process.env.AGENTHYDRA_CORE_DIR = CORE
  setCliMayteAccountsProvider(() => [])
})

afterAll(async () => {
  for (const w of workers.values()) if (w.group === GROUP) climayteCancel({ group: GROUP })
  await killsLanded()
  setCliMayteAccountsProvider(null)
  if (prevCore === undefined) delete process.env.AGENTHYDRA_CORE_DIR
  else process.env.AGENTHYDRA_CORE_DIR = prevCore
  rmSync(scratch, { recursive: true, force: true })
})

/** A worker started with no origin, so its role comes only from its own task fields. */
function start(task: Record<string, unknown>): CliMayteWorker {
  const r = climayteRun({
    tasks: [{ prompt: 'Summarise the example notes.', cwd: CWD, title: 'Roles fixture', ...task }],
    group: GROUP,
  })
  const w = workers.get(r.workers[0].id)
  if (!w) throw new Error('fixture worker missing')
  return w
}

const originOf = (w: CliMayteWorker) => ({ kind: 'worker' as const, workerId: w.id })

describe('roleOf', () => {
  test('a worker without a role is a drone unless it is a chat', () => {
    expect(roleOf({})).toBe('drone')
    expect(roleOf({ chat: false })).toBe('drone')
    expect(roleOf({ chat: true })).toBe('prime')
    expect(roleOf({ chat: true, desk: { manager: 'mgr' } })).toBe('seat')
  })

  test('a stored role wins over the derivation', () => {
    expect(roleOf({ role: 'seat', chat: false })).toBe('seat')
    expect(roleOf({ role: 'drone', chat: true })).toBe('drone')
  })
})

describe('the refusal text and the briefs', () => {
  test('DRONE_REFUSAL is the exact sentence', () => {
    expect(DRONE_REFUSAL).toBe(
      'This session does not start workers. If this job is too big for one session, stop and end your report with a line starting TOO BIG: and a suggested split; whoever started you splits it.',
    )
  })

  test('the worker brief drops the identity line', () => {
    expect(WORKER_BRIEF).not.toContain('You are a CliMayte worker')
  })

  test('the drone brief carries the TOO BIG protocol', () => {
    expect(DRONE_BRIEF).toContain('TOO BIG:')
  })
})

describe('dispatch by role', () => {
  test('a drone caller is refused and the refusal is journaled', () => {
    const drone = start({ title: 'Drone fixture' })
    expect(roleOf(drone)).toBe('drone')
    expect(() =>
      climayteRun({
        tasks: [{ prompt: 'Start a sub-job.', cwd: CWD, title: 'Sub-job' }],
        group: GROUP,
        origin: originOf(drone),
      }),
    ).toThrow(DRONE_REFUSAL)
    const refused = readJournal(JOURNAL_PATH, { id: drone.id }).filter((e) => e.event === 'refused')
    expect(refused.length).toBeGreaterThan(0)
  })

  test('a drone may start sealed visitors, and each such dispatch is journaled', () => {
    const drone = start({ title: 'Drone visitor fixture' })
    const promptFile = join(scratch, 'visitor.md')
    const mcpConfig = join(scratch, 'visitor-mcp.json')
    writeFileSync(promptFile, 'You are an invented visitor.')
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }))
    const sealed = { systemPromptFile: promptFile, mcpConfig, allowedTools: ['mcp__hands__*'] }
    const r = climayteRun({
      tasks: [
        { prompt: 'Visit the page.', cwd: CWD, title: 'Visitor 1', sealed },
        { prompt: 'Visit the page.', cwd: CWD, title: 'Visitor 2', sealed },
      ],
      group: GROUP,
      origin: originOf(drone),
    })
    expect(r.workers.length).toBe(2)
    const logged = readJournal(JOURNAL_PATH, { id: drone.id }).filter((e) => e.event === 'visitors')
    expect(logged.map((e) => e.notice)).toEqual(['2'])
    // One unsealed task among them is still a drone dispatching work.
    expect(() =>
      climayteRun({
        tasks: [
          { prompt: 'Visit the page.', cwd: CWD, title: 'Visitor 3', sealed },
          { prompt: 'Start a sub-job.', cwd: CWD, title: 'Sub-job' },
        ],
        group: GROUP,
        origin: originOf(drone),
      }),
    ).toThrow(DRONE_REFUSAL)
  })

  test('a drone caller is refused by climayte_manage', async () => {
    const drone = start({ title: 'Drone manage fixture' })
    await expect(
      climayteWaveStart({
        plan: 'Split the notes.',
        cwd: CWD,
        tasks: [],
        origin: originOf(drone),
      }),
    ).rejects.toThrow(DRONE_REFUSAL)
  })

  test('a prime caller may dispatch', () => {
    const prime = start({ title: 'Prime fixture', chat: true })
    expect(roleOf(prime)).toBe('prime')
    const r = climayteRun({
      tasks: [{ prompt: 'Summarise the example notes.', cwd: CWD, title: 'From prime' }],
      group: GROUP,
      origin: originOf(prime),
    })
    expect(r.workers.length).toBe(1)
  })

  test('a seat task needs the role and a catalog persona', () => {
    const prime = start({ title: 'Prime for seat fixture', chat: true })
    const origin = originOf(prime)
    expect(() =>
      climayteRun({
        tasks: [{ prompt: 'Review it.', cwd: CWD, title: 'Seat', role: 'seat' }],
        group: GROUP,
        origin,
      }),
    ).toThrow('a seat needs a persona')
    expect(() =>
      climayteRun({
        tasks: [
          { prompt: 'Review it.', cwd: CWD, title: 'Seat', role: 'seat', persona: 'person:nobody' },
        ],
        group: GROUP,
        origin,
      }),
    ).toThrow('is not in the catalog')
    expect(() =>
      climayteRun({
        tasks: [{ prompt: 'Review it.', cwd: CWD, title: 'Seat', persona: PERSONA }],
        group: GROUP,
        origin,
      }),
    ).toThrow('a task names only the role "seat"')
  })

  test('a seat task with a catalog persona is dispatched with its role', () => {
    const prime = start({ title: 'Prime for valid seat', chat: true })
    const r = climayteRun({
      tasks: [{ prompt: 'Review it.', cwd: CWD, title: 'Seat ok', role: 'seat', persona: PERSONA }],
      group: GROUP,
      origin: originOf(prime),
    })
    const w = workers.get(r.workers[0].id)
    expect(w?.role).toBe('seat')
    expect(w?.persona).toBe(PERSONA)
  })
})

describe('the views carry the role', () => {
  test('toView and toReport return the role and persona', () => {
    const seat = start({ title: 'View fixture', role: 'seat', persona: PERSONA, chat: true })
    const view = toView(seat, Date.now())
    expect(view.role).toBe('seat')
    const report = toReport(view)
    expect(report.role).toBe('seat')
    expect(report.persona).toBe(PERSONA)
  })
})

describe('a seat opened by core_use', () => {
  test('a Desk chat listed in seat-chats.json runs as a seat of its persona, manager or not', () => {
    addSeatChat(CORE, 'chat-seat-board', PERSONA, 'chat-prime-example')
    const desk = { append: '', mcpServers: {}, chatId: 'chat-seat-board' }
    const seat = start({ title: 'Board seat', chat: true, desk })
    expect(seat.role).toBe('seat')
    expect(seat.persona).toBe(PERSONA)
    // Any other Desk chat stays the Prime it is.
    const prime = start({
      title: 'Plain chat',
      chat: true,
      desk: { ...desk, chatId: 'chat-other' },
    })
    expect(prime.role).toBe('prime')
  })
})

describe('TOO BIG', () => {
  test('tooBigOf finds the line a report ends with, markdown or not', () => {
    expect(tooBigOf('Done half.\n\nTOO BIG: split into the API and the UI')).toBe(
      'TOO BIG: split into the API and the UI',
    )
    expect(tooBigOf('- **TOO BIG:** two parts')).toBe('TOO BIG: two parts')
    expect(tooBigOf('All done; nothing was too big.')).toBeNull()
    expect(tooBigOf(null)).toBeNull()
  })

  test('a turn that ends on TOO BIG: is journaled too_big with the line; any other is not', () => {
    const big = start({ title: 'Too big fixture' })
    big.results = ['Read the code.\nTOO BIG: one part per service']
    journalTooBig(big)
    const fine = start({ title: 'Fine fixture' })
    fine.results = ['Done. Proof: 12 pass.']
    journalTooBig(fine)
    const lines = readJournal(JOURNAL_PATH, {}).filter((e) => e.event === 'too_big')
    expect(lines.filter((e) => e.id === big.id).map((e) => e.notice)).toEqual([
      'TOO BIG: one part per service',
    ])
    expect(lines.some((e) => e.id === fine.id)).toBe(false)
  })
})
