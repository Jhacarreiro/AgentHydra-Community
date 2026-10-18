// server/tests/climayte-sendback.test.ts — a failed verdict sent back to its worker says who failed it.
// A check's fail is an automatic re-check, not a new instruction from the orchestrator (the wave of
// workers that broke their brief read it as an order); an orchestrator's or a person's fail keeps the
// wording it always had. Judged through climayteVerdict, the same boundary the orchestrator calls.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteRun,
  climayteVerdict,
  killsLanded,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  setCliMayteOwnerDir,
} from '../src/climayte'
import { workers } from '../src/climayte-core'

const scratch = mkdtempSync(join(tmpdir(), 'climayte-sendback-test-'))
const OWNER = join(scratch, 'home', '.claude')
const WORK = join(scratch, 'work')

beforeAll(() => {
  mkdirSync(OWNER, { recursive: true })
  mkdirSync(WORK, { recursive: true })
  writeFileSync(join(OWNER, 'CLAUDE.md'), 'Owner rules.')
  setCliMayteAccountsProvider(() => [])
  setCliMayteClaudeCommand(['claude'])
  setCliMayteOwnerDir(OWNER)
})
afterAll(async () => {
  climayteCancel({ group: 'sendback-test' })
  await killsLanded()
  setCliMayteOwnerDir(null)
  setCliMayteClaudeCommand(null)
  setCliMayteAccountsProvider(null)
  rmSync(scratch, { recursive: true, force: true })
})

// A stopped worker is judged; a fail on a non-top setting is sent back to it as a follow-up.
const stoppedWorker = (): string => {
  const reply = climayteRun({
    group: 'sendback-test',
    model: 'sonnet',
    effort: 'medium',
    ownerWords: 'fixed',
    tasks: [{ prompt: 'Make the list sorted', cwd: WORK }],
  })
  const id = reply.workers[0]?.id ?? ''
  climayteCancel({ id })
  return id
}

const NOTE = 'the example list is still unsorted'
const AUTO_LEAD = 'CliMayte re-ran the check command your task came with, and it failed'
const AUTO_TAIL =
  'Fix what you can within those rules, prove it with a command and what it printed, and report again.'
const OLD_LEAD = 'The orchestrator checked your result and it did not pass. What was wrong:'
const OLD_TAIL = 'Fix it, prove the fix with a command and what it printed, and report again.'

describe('a failed verdict sent back to its worker', () => {
  test('a check-sourced fail sends the automatic re-check text, not an order', () => {
    const id = stoppedWorker()
    const judged = climayteVerdict(id, { verdict: 'fail', note: NOTE, by: 'check' })
    expect(judged).toMatchObject({ ok: true })
    expect(judged.message).toContain('Sent back')
    const sent = workers.get(id)?.pending.at(-1) ?? ''
    expect(sent.startsWith(AUTO_LEAD)).toBe(true)
    expect(sent).toContain('This is an automatic re-check, not a new instruction')
    expect(sent).toContain(` ${NOTE}\n\n${AUTO_TAIL}`)
    expect(sent).not.toContain(OLD_LEAD)
  })

  test('an orchestrator-recorded fail keeps the old wording', () => {
    const id = stoppedWorker()
    const judged = climayteVerdict(id, { verdict: 'fail', note: NOTE, by: 'orchestrator' })
    expect(judged).toMatchObject({ ok: true })
    const sent = workers.get(id)?.pending.at(-1) ?? ''
    expect(sent).toBe(`${OLD_LEAD} ${NOTE}\n\n${OLD_TAIL}`)
    expect(sent).not.toContain('automatic re-check')
  })
})
