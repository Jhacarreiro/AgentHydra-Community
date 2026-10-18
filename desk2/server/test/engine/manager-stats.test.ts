import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgetManagerStats, managerStats } from '../../src/engine/manager-stats'

const realNow = Date.now
const oldManagersDir = process.env.AGENTHYDRA_MANAGERS_DIR
let dir = ''
let clock = 0

beforeEach(() => {
  clock = realNow()
  Date.now = () => clock
  dir = mkdtempSync(join(tmpdir(), 'desk-manager-stats-'))
  process.env.AGENTHYDRA_MANAGERS_DIR = dir
  forgetManagerStats()
})

afterEach(() => {
  Date.now = realNow
  if (oldManagersDir === undefined) delete process.env.AGENTHYDRA_MANAGERS_DIR
  else process.env.AGENTHYDRA_MANAGERS_DIR = oldManagersDir
  if (dir) rmSync(dir, { recursive: true, force: true })
  forgetManagerStats()
})

function writeSummary(managers: unknown): void {
  mkdirSync(join(dir, 'analytics'), { recursive: true })
  writeFileSync(
    join(dir, 'analytics', 'summary.json'),
    JSON.stringify({ v: 1, at: clock, days: 7, managers }),
  )
}

test('a full row reads its numbers and the stored line', () => {
  writeSummary({
    'alpha-ui': {
      turns: 41,
      responseRate: 0.98,
      judgeAvg: 7.6,
      owner: { correction: 3 },
      line: '41 turns · 98% answered · judge 7.6 · 3 corrections',
    },
  })
  expect(managerStats('alpha-ui')).toEqual({
    turns: 41,
    responseRate: 0.98,
    judgeAvg: 7.6,
    corrections: 3,
    line: '41 turns · 98% answered · judge 7.6 · 3 corrections',
  })
})

test('without a stored line the stats line is built from the parts that exist', () => {
  writeSummary({ 'alpha-ui': { turns: 41, responseRate: 0.98, judgeAvg: 7.6, owner: { correction: 3 } } })
  expect(managerStats('alpha-ui')?.line).toBe('41 turns · 98% answered · judge 7.6')
  expect(managerStats('alpha-ui')?.corrections).toBe(3)
})

test('a row with nulls keeps them null and leaves the missing parts out of the line', () => {
  writeSummary({ 'alpha-ui': { turns: 2, responseRate: null, judgeAvg: null, owner: {} } })
  expect(managerStats('alpha-ui')).toEqual({
    turns: 2,
    responseRate: null,
    judgeAvg: null,
    corrections: 0,
    line: '2 turns',
  })
})

test('a missing summary file answers null', () => {
  expect(managerStats('alpha-ui')).toBeNull()
})

test('a malformed summary file answers null', () => {
  mkdirSync(join(dir, 'analytics'), { recursive: true })
  writeFileSync(join(dir, 'analytics', 'summary.json'), '{"managers": {"alpha-ui": ')
  expect(managerStats('alpha-ui')).toBeNull()
})

test('an unknown slug answers null', () => {
  writeSummary({ 'alpha-ui': { turns: 1, responseRate: 1, judgeAvg: null, owner: {} } })
  expect(managerStats('nobody')).toBeNull()
})

test('a slug failing the manager slug rule answers null without reading the file', () => {
  writeSummary({ 'alpha-ui': { turns: 1, responseRate: 1, judgeAvg: null, owner: {} } })
  expect(managerStats('../alpha-ui')).toBeNull()
  expect(managerStats('Alpha_Two')).toBeNull()
})

test('the summary is cached for 5 seconds, then read again', () => {
  writeSummary({ 'alpha-ui': { turns: 5, responseRate: null, judgeAvg: null, owner: {} } })
  expect(managerStats('alpha-ui')?.turns).toBe(5)
  writeSummary({ 'alpha-ui': { turns: 9, responseRate: null, judgeAvg: null, owner: {} } })
  clock += 4999
  expect(managerStats('alpha-ui')?.turns).toBe(5)
  clock += 1
  expect(managerStats('alpha-ui')?.turns).toBe(9)
})

test('forgetManagerStats drops the cached summary at once', () => {
  writeSummary({ 'alpha-ui': { turns: 5, responseRate: null, judgeAvg: null, owner: {} } })
  expect(managerStats('alpha-ui')?.turns).toBe(5)
  writeSummary({ 'alpha-ui': { turns: 9, responseRate: null, judgeAvg: null, owner: {} } })
  forgetManagerStats()
  expect(managerStats('alpha-ui')?.turns).toBe(9)
})
