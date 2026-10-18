// Move to account > Unassigned reads AgentHydra's desktop-archive answer (session-header/ah.ts unassignSession). The
// sidebar says "Unassigned" only on a verdict that the chat left its account; a refused or unverified archive must
// not read as done (the chat would sit in Unassigned while its account still runs it), and a terminal chat no desktop
// account holds has nothing to take off.

import { afterEach, expect, test } from 'bun:test'
import { moveCodexSession, unassignCodexSession, unassignSession } from '@/components/session-header/ah'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function answer(status: number, body: unknown): { url: string; body: unknown }[] {
  const asked: { url: string; body: unknown }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    asked.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return asked
}

test('an archive its app confirmed, or one only a restart will show, is Unassigned; it names the account it was on', async () => {
  const asked = answer(200, { ok: true, verified: true })
  expect(await unassignSession('s-1', 'desktop:C:/p/72')).toEqual({ ok: true, stillShown: false })
  expect(asked[0]).toEqual({ url: '/ah/api/sessions/s-1/desktop-archive', body: { instance_ref: 'desktop:C:/p/72' } })
  answer(200, { ok: true, hits: [{ changed: true }], flagOnDisk: [{ isArchived: true }], flagStuck: true, stillOnScreen: true })
  expect(await unassignSession('s-1', null)).toEqual({ ok: true, stillShown: true })
})

test('a refusal, an unverified archive or a flag put back is not, with the reason AgentHydra gave', async () => {
  answer(409, { ok: false, error: 'session-live: refusing to archive a chat with a running engine' })
  expect(await unassignSession('s-1', null)).toEqual({ ok: false, error: 'session-live: refusing to archive a chat with a running engine' })
  answer(200, { ok: true, verified: false, reason: 'NATIVE_REFUSAL: busy' })
  expect(await unassignSession('s-1', null)).toEqual({ ok: false, error: 'NATIVE_REFUSAL: busy' })
  answer(200, { ok: true, hits: [{ changed: true }], flagOnDisk: [{ isArchived: false }], flagStuck: false })
  expect((await unassignSession('s-1', null)).ok).toBe(false)
})

test('a chat no desktop account holds has nothing to take off', async () => {
  answer(404, { ok: false, hits: [] })
  expect(await unassignSession('s-1', null)).toEqual({ ok: true, stillShown: false })
})

// A Codex chat in Unassigned is archived on the account it left (the mover takes only active chats). Moving it restores
// it there first; moved back to that account it is only restored; a duplicate, or a move that did not finish, archives
// it again, so it never ends up back on its old account's list while Desk shows it Unassigned.
function codexAnswers(moveOk: boolean): { url: string; body: unknown }[] {
  const asked: { url: string; body: unknown }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    asked.push({ url, body })
    const json = (status: number, x: unknown) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } })
    if (url.startsWith('/ah/api/sessions/')) return json(200, { session_id: 't-1', instance_ref: 'codex:home-a', title: 'Example chat' })
    if (url.includes('/archive-chat')) return json(200, { ok: true })
    if (url.includes('/move-chats')) return json(200, { chats: [{ id: 't-1', updatedAt: 5 }], sourceAccountId: 'acc-a', targetAccountId: 'acc-b' })
    if (url.includes('/move-chat')) return json(200, moveOk ? { ok: true, destinationThreadId: 't-2' } : { ok: false, error: 'The source changed during the copy.' })
    return json(404, { error: 'unexpected' })
  }) as typeof fetch
  return asked
}
const archiveCalls = (asked: { url: string; body: unknown }[]) =>
  asked.filter((a) => a.url.includes('/archive-chat')).map((a) => `${a.url.split('/')[4]}:${(a.body as { archived: boolean }).archived ? 'archive' : 'restore'}`)

test('an Unassigned Codex chat is restored on its old account, then moved; moved back there it is only restored', async () => {
  let asked = codexAnswers(true)
  expect(await moveCodexSession('t-1', 'codex:home-b', { unassigned: true })).toEqual({ ok: true, destinationThreadId: 't-2' })
  expect(archiveCalls(asked)).toEqual(['home-a:restore'])
  expect(asked.findIndex((a) => a.url.includes('/archive-chat'))).toBeLessThan(asked.findIndex((a) => a.url.includes('/move-chat?') || a.url.endsWith('/move-chat')))
  asked = codexAnswers(true)
  expect(await moveCodexSession('t-1', 'codex:home-a', { unassigned: true })).toEqual({ ok: true, restored: true })
  expect(archiveCalls(asked)).toEqual(['home-a:restore'])
  expect(asked.some((a) => a.url.includes('/move-chat'))).toBe(false)
})

test('a duplicate of an Unassigned Codex chat, or a move that did not finish, leaves it archived and Unassigned', async () => {
  let asked = codexAnswers(true)
  expect((await moveCodexSession('t-1', 'codex:home-b', { unassigned: true, keepSource: true })).ok).toBe(true)
  expect(archiveCalls(asked)).toEqual(['home-a:restore', 'home-a:archive'])
  expect((asked.find((a) => a.url.endsWith('/move-chat'))?.body as { keepSource?: boolean }).keepSource).toBe(true)
  asked = codexAnswers(false)
  expect(await moveCodexSession('t-1', 'codex:home-b', { unassigned: true })).toEqual({ ok: false, error: 'The source changed during the copy.' })
  expect(archiveCalls(asked)).toEqual(['home-a:restore', 'home-a:archive'])
  // A copy never goes to the account its original is on; Unassign archives it there.
  expect((await moveCodexSession('t-1', 'codex:home-a', { keepSource: true })).error).toContain('another Codex account')
  asked = codexAnswers(true)
  expect(await unassignCodexSession('t-1')).toEqual({ ok: true, stillShown: false })
  expect(archiveCalls(asked)).toEqual(['home-a:archive'])
})
