// A Prime counts its running seats (its sub-chats) as it counts its drones (A4-F8): climayteActive holds them, and a
// Prime that already replied, read while a seat still ran, turns unread again when its last seat finishes.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ChatManager } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) if (d) rmSync(d, { recursive: true, force: true })
})

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const turn = (): SDKMessage[] =>
  readFileSync(join(import.meta.dir, '..', '..', 'fixtures', 'basic-turn.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SDKMessage)

let n = 0
const uuid = () => `20000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const SEAT_SESSION = '30000000-0000-4000-8000-000000000001'
const state = (s: 'running' | 'idle'): SDKMessage =>
  ({ type: 'system', subtype: 'session_state_changed', state: s, uuid: uuid(), session_id: SEAT_SESSION }) as unknown as SDKMessage
const result = (): SDKMessage =>
  ({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 1000, duration_api_ms: 900, num_turns: 1, total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], result: 'Seat done.', uuid: uuid(), session_id: SEAT_SESSION,
  }) as unknown as SDKMessage

test('a Prime read while its seat ran turns unread when that seat finishes, and counts the seat meanwhile', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-seat-settle-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const q = fakeQueries()
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge: fakeBridge().bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk' })
  managers.push(m)

  const prime = await m.create({ cwd: home, prompt: 'plan the invented launch', delegateToCliMayte: false })
  await waitFor(() => q.all.length === 1)
  q.all[0]!.push(...turn())
  await waitFor(() => m.get(prime.id).status === 'idle')

  const seat = await m.create({ cwd: home, prompt: 'review the invented plan', title: 'Bo Example · invented', parentId: prime.id, delegateToCliMayte: false })
  await waitFor(() => q.all.length === 2)
  q.all[1]!.push(state('running'))
  await waitFor(() => m.get(seat.id).status === 'working')
  expect(m.get(prime.id).climayteActive).toBe(1)

  await m.patch(prime.id, { unread: false })
  expect(m.get(prime.id).unread).toBe(false)

  q.all[1]!.push(result(), state('idle'))
  await waitFor(() => m.get(seat.id).status === 'idle')
  expect(m.get(prime.id).climayteActive).toBe(0)
  expect(m.get(prime.id).unread).toBe(true)
})
