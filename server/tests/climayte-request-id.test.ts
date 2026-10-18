// server/tests/climayte-request-id.test.ts — a request sent again is taken once. Hydra Desk gave up on
// POST /api/corch/workers after 4 s while AgentHydra was busy (2026-10-13), said the message was not sent,
// and the owner sent it again: AgentHydra had started the first worker anyway, so two ran the same
// message. Desk now names each start and each message with a requestId and retries with the same one.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteList,
  climayteRun,
  climayteSend,
  setCliMayteAccountsProvider,
} from '../src/climayte'
import { workers } from '../src/climayte-core'

describe('a start or a message sent again with its requestId is taken once', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ah-climayte-request-id-'))
  const groups = new Set<string>()
  afterAll(() => {
    for (const group of groups) climayteCancel({ group })
    setCliMayteAccountsProvider(null)
    rmSync(cwd, { recursive: true, force: true })
  })
  const chat = (prompt: string, requestId?: string) => ({
    prompt,
    cwd,
    title: prompt,
    chat: true,
    ...(requestId ? { requestId } : {}),
  })

  test('a chat start sent again answers the worker it made, even with copies', () => {
    setCliMayteAccountsProvider(() => [])
    const first = climayteRun({
      group: 'request-id-start',
      tasks: [chat('hello there', 'desk-sent:1:a')],
      copies: true,
    })
    groups.add(first.group)
    const again = climayteRun({
      group: 'request-id-start',
      tasks: [chat('hello there', 'desk-sent:1:a')],
      copies: true,
    })
    expect(again.workers.map((w) => [w.id, w.repeat])).toEqual([[first.workers[0]?.id, true]])
    expect(climayteList({ group: 'request-id-start' })).toHaveLength(1)
    // The id is the request, not the words: another id with the same words is a new chat.
    const other = climayteRun({
      group: 'request-id-start',
      tasks: [chat('hello there', 'desk-sent:2:b')],
      copies: true,
    })
    expect(other.workers[0]?.repeat).toBeUndefined()
    expect(other.workers[0]?.id).not.toBe(first.workers[0]?.id)
    expect(climayteList({ group: 'request-id-start' })).toHaveLength(2)
  })

  test('still the same worker once it was cancelled: the request made it, so a retry never makes a second', () => {
    setCliMayteAccountsProvider(() => [])
    const first = climayteRun({
      group: 'request-id-cancelled',
      tasks: [chat('stop me', 'desk-sent:3:c')],
      copies: true,
    })
    groups.add(first.group)
    climayteCancel({ group: 'request-id-cancelled' })
    const again = climayteRun({
      group: 'request-id-cancelled',
      tasks: [chat('stop me', 'desk-sent:3:c')],
      copies: true,
    })
    expect(again.workers[0]?.id).toBe(first.workers[0]?.id)
    expect(climayteList({ group: 'request-id-cancelled' })).toHaveLength(1)
  })

  test('a message sent again is queued once, and its id stays off the worker views', () => {
    setCliMayteAccountsProvider(() => [])
    const run = climayteRun({
      group: 'request-id-send',
      tasks: [chat('first message', 'desk-sent:4:d')],
    })
    groups.add(run.group)
    const id = run.workers[0]?.id as string
    const sent = climayteSend(id, 'a follow-up', { requestId: 'desk-sent:5:e' })
    const again = climayteSend(id, 'a follow-up', { requestId: 'desk-sent:5:e' })
    expect(sent.ok).toBe(true)
    expect(again).toMatchObject({ ok: true, message: expect.stringContaining('Already taken') })
    expect(workers.get(id)?.pending).toEqual(['a follow-up'])
    // The same words under a new id are a new message (the owner typed them twice).
    expect(climayteSend(id, 'a follow-up', { requestId: 'desk-sent:6:f' }).ok).toBe(true)
    expect(workers.get(id)?.pending).toEqual(['a follow-up', 'a follow-up'])
    expect(climayteList({ id })[0]?.sendIds).toBeUndefined()
    expect(climayteList({ id })[0]?.requestId).toBe('desk-sent:4:d')
  })

  test('a request id that is not one is refused, and nothing is made or queued', () => {
    setCliMayteAccountsProvider(() => [])
    expect(() =>
      climayteRun({ group: 'request-id-bad', tasks: [{ ...chat('x'), requestId: '' }] }),
    ).toThrow(/requestId/)
    expect(() =>
      climayteRun({
        group: 'request-id-bad',
        tasks: [{ ...chat('x'), requestId: 'r'.repeat(201) }],
      }),
    ).toThrow(/requestId/)
    // Hydra Desk's probe (takesRequestIds): a task with nothing but an empty requestId is refused for its
    // requestId, not its empty prompt, so Desk can tell this AgentHydra from one that ignores the field.
    expect(() => climayteRun({ tasks: [{ prompt: '', cwd: '', requestId: '' }] })).toThrow(
      /requestId/,
    )
    expect(climayteList({ group: 'request-id-bad' })).toHaveLength(0)
    const run = climayteRun({ group: 'request-id-bad-send', tasks: [chat('first')] })
    groups.add(run.group)
    const id = run.workers[0]?.id as string
    expect(climayteSend(id, 'next', { requestId: 7 as unknown as string })).toMatchObject({
      ok: false,
      message: expect.stringContaining('requestId'),
    })
    expect(workers.get(id)?.pending).toEqual([])
  })
})
