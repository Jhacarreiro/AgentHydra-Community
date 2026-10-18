// server/tests/mcp-restart-note.test.ts — which MCP answers carry the "daemon runs older code" note
// (server/src/mcp-restart-note.ts). Stub tools and a fixed status: no daemon is started.

import { expect, test } from 'bun:test'
import { type RunningCodeStatus, restartNeededMessage } from '../src/core/running-code'
import { mcpWithRestartNote } from '../src/mcp-restart-note'
import type { McpEngineTool } from '../src/mcp-stdio.mjs'

const STALE: RunningCodeStatus = {
  bootCommit: 'a'.repeat(40),
  diskCommit: 'b'.repeat(40),
  restartNeeded: true,
}
const FRESH: RunningCodeStatus = {
  bootCommit: 'a'.repeat(40),
  diskCommit: 'a'.repeat(40),
  restartNeeded: false,
}
const NOTE = restartNeededMessage(STALE) as string

function tool(name: string, run: McpEngineTool['run']): McpEngineTool {
  return { name, description: name, inputSchema: {}, run }
}
function wrapped(status: RunningCodeStatus, t: McpEngineTool): McpEngineTool {
  return mcpWithRestartNote([t], () => status)[0]
}

test('hydra_find carries the note on a stale daemon', async () => {
  const out = (await wrapped(
    STALE,
    tool('hydra_find', async () => ({ tools: [] })),
  ).run({})) as Record<string, unknown>
  expect(out.daemonRestartNeeded).toBe(NOTE)
  expect(out.tools).toEqual([])
})

test('an ordinary successful answer comes back as the tool returned it', async () => {
  const value = { chats: [1] }
  const out = await wrapped(
    STALE,
    tool('climayte_status', async () => value),
  ).run({})
  expect(out).toBe(value)
})

test('a failed answer (ok false, or an error field) carries the note', async () => {
  const okFalse = (await wrapped(
    STALE,
    tool('x', async () => ({ ok: false })),
  ).run({})) as Record<string, unknown>
  expect(okFalse.daemonRestartNeeded).toBe(NOTE)
  const errField = (await wrapped(
    STALE,
    tool('x', async () => ({ error: 'boom' })),
  ).run({})) as Record<string, unknown>
  expect(errField.daemonRestartNeeded).toBe(NOTE)
})

test('a thrown error (an unknown hydra_run tool, say) carries the note in its message', async () => {
  const t = wrapped(
    STALE,
    tool('hydra_run', async () => {
      throw new Error('no AgentHydra tool named nope')
    }),
  )
  const error = await Promise.resolve(t.run({})).then(
    () => null,
    (e: Error) => e,
  )
  expect(error?.message).toBe(`no AgentHydra tool named nope\n\n${NOTE}`)
})

test('nothing is added while the daemon runs the folder code', async () => {
  const value = { ok: false, error: 'x' }
  expect(
    await wrapped(
      FRESH,
      tool('hydra_find', async () => value),
    ).run({}),
  ).toBe(value)
  const thrown = await Promise.resolve(
    wrapped(
      FRESH,
      tool('hydra_run', async () => {
        throw new Error('no AgentHydra tool named nope')
      }),
    ).run({}),
  ).catch((e: Error) => e.message)
  expect(thrown).toBe('no AgentHydra tool named nope')
})

test('the note names both commits and no longer points an agent at daemon_restart', () => {
  expect(NOTE).toContain('a'.repeat(7))
  expect(NOTE).toContain('b'.repeat(7))
  expect(NOTE).toContain('app header')
  expect(NOTE).not.toContain('daemon_restart')
  expect(NOTE).not.toContain('/api/daemon/restart')
})
