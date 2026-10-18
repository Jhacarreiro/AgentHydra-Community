// A chat's turn ending reports the chat finished, once per turn, to the completion registry. Streamed items in
// the middle of a turn report nothing, so a caller waiting on the chat is told once when the work is done.

import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AccountInfo, ServerEvent } from '@shared/protocol'
import { encodeProjectDir } from '../../../src/bridge/session-jsonl'
import { ChatManager, type ManagerBridge } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const SID = '8c8c8c8c-1111-4222-8333-444455556666'
let results = 0
const done = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], uuid: `61000000-0000-4000-8000-${String(++results).padStart(12, '0')}`, session_id: SID }) as unknown as SDKMessage
const line = (cwd: string): string => `${JSON.stringify({ type: 'user', uuid: 'u', parentUuid: null, cwd, message: { role: 'user', content: 'x' } })}\n`

async function setup() {
  const home = temp('desk-finished-home-')
  const cwd = temp('desk-finished-cwd-')
  process.env.HYDRA_DESK_HOME = home
  const configDir = temp('desk-finished-acct-')
  const account: AccountInfo = { id: 'acct-1', label: '#1 user (Pro)', configDir, number: 1, email: null, plan: 'Pro', signedIn: true, fiveHourPct: 10, weeklyPct: 10, fiveHourResetsAt: null, weeklyResetsAt: null, inUse: false }
  const file = join(configDir, 'projects', encodeProjectDir(cwd), `${SID}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, line(cwd))
  const roots = [join(configDir, 'projects')]
  const q = fakeQueries()
  const events: ServerEvent[] = []
  const fake = fakeBridge({ roots })
  const bridge: ManagerBridge = { ...fake.bridge, listAccounts: async () => [account] }
  const m = new ChatManager({ home, claudeHome: home, emit: (e) => events.push(e), settings: () => ({ ...DEFAULT_SETTINGS }), bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk' })
  managers.push(m)
  const chat = await m.importSession({ sessionId: SID, cwd, title: 'Finished', configDir })
  return { m, q, chat, file, finished: fake.state.finished }
}

test('a turn that ends reports its chat finished once, as done', async () => {
  const { m, q, chat, file, finished } = await setup()
  const n = q.all.length
  await m.send(chat.id, 'work')
  await waitFor(() => q.all.length > n || q.last().calls.close === 0)
  await waitFor(() => m.get(chat.id).status !== 'idle')
  appendFileSync(file, line(join(chat.cwd)))
  expect(finished).toEqual([])
  q.last().push(done())
  await waitFor(() => finished.length > 0)
  await new Promise((r) => setTimeout(r, 30))
  expect(finished).toEqual([{ ticket: `desk-chat:${chat.id}`, outcome: 'done' }])
})

test('streamed items in the middle of a turn report nothing', async () => {
  const { m, q, chat, file, finished } = await setup()
  const n = q.all.length
  await m.send(chat.id, 'work')
  await waitFor(() => q.all.length > n || q.last().calls.close === 0)
  await waitFor(() => m.get(chat.id).status !== 'idle')
  for (let i = 0; i < 3; i++) appendFileSync(file, line(join(chat.cwd)))
  await new Promise((r) => setTimeout(r, 30))
  expect(finished).toEqual([])
  q.last().push(done())
  await waitFor(() => finished.length > 0)
  expect(finished).toHaveLength(1)
})
