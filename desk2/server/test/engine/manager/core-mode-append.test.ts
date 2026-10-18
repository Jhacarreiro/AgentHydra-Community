// Core mode (the file <core dir>/ON) shrinks a Desk chat's appended prompt to its first sentence, the media
// sentence and the move line; the connector servers stay attached. Flag off is today's append.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatAddOns } from '../../../src/engine/desk-prompt'

const scratch = mkdtempSync(join(tmpdir(), 'desk-core-mode-'))
const CORE = join(scratch, 'core')
const CWD = join(scratch, 'repo')
const self = { id: 'chat-1', base: 'http://127.0.0.1:1' }
const savedCoreDir = process.env.AGENTHYDRA_CORE_DIR

const setFlag = (on: boolean) => {
  if (on) writeFileSync(join(CORE, 'ON'), '')
  else rmSync(join(CORE, 'ON'), { force: true })
}

beforeAll(() => {
  mkdirSync(CORE, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  process.env.AGENTHYDRA_CORE_DIR = CORE
})
afterAll(() => {
  if (savedCoreDir === undefined) delete process.env.AGENTHYDRA_CORE_DIR
  else process.env.AGENTHYDRA_CORE_DIR = savedCoreDir
  rmSync(scratch, { recursive: true, force: true })
})

describe('Desk append in core mode', () => {
  test('flag off keeps the orchestration paragraphs', () => {
    setFlag(false)
    const { append } = chatAddOns(CWD, true, self)
    expect(append).toContain('climayte_run')
    expect(append).toContain('dashboard_write')
  })

  test('flag on keeps the first sentence, the media sentence and the move line only', () => {
    setFlag(true)
    const { append, mcpServers } = chatAddOns(CWD, true, self)
    expect(append.startsWith("You are running inside Hydra Desk, the owner's own desktop for Claude Code. To show the person a picture")).toBe(true)
    expect(append).toContain('This is Desk chat chat-1.')
    expect(append).not.toContain('climayte_run')
    expect(append).not.toContain('browser_navigate')
    expect(append).not.toContain('dashboard_write')
    expect(mcpServers).toBeDefined()
    setFlag(false)
  })
})
