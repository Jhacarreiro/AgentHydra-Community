// GET /api/external/sessions/:id/index and /items/:itemId.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBridge } from '../src/bridge'
import { createServer, type DeskServer } from '../src/index'
import type { TranscriptIndex, TranscriptItem } from '@shared/protocol'

const at = (n: number) => new Date(Date.UTC(2026, 9, 3, 10, 0, 0) + n * 1000).toISOString()

const FILLER = 'x'.repeat(4000)
const PLUGIN = join(import.meta.dir, '..', 'src', 'plugins', '10-bridge.ts')
const SESSION = 'aaaaaaaa-1111-4222-8333-444444444444'
const temps: string[] = []
const servers: DeskServer[] = []
const savedHome = process.env.HYDRA_DESK_HOME
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env.HYDRA_DESK_HOME
  else process.env.HYDRA_DESK_HOME = savedHome
})

/** A desk (only the bridge plugin) whose one outside session is the given transcript lines. */
async function bootWithSession(lines: object[]): Promise<DeskServer> {
  const home = mkdtempSync(join(tmpdir(), 'desk-ext-home-'))
  const plugins = mkdtempSync(join(tmpdir(), 'desk-ext-plugins-'))
  temps.push(home, plugins)
  const root = join(home, 'projects')
  mkdirSync(join(root, 'C--Users-me-proj'), { recursive: true })
  writeFileSync(join(root, 'C--Users-me-proj', `${SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  writeFileSync(join(plugins, '10-bridge.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  process.env.HYDRA_DESK_HOME = home
  const bridge = createBridge({ url: 'http://127.0.0.1:9', home, projectRoots: () => [root] })
  const desk = await createServer({ port: 0, home, pluginsDir: plugins, deps: { bridge, bridgePollMs: 60_000 } })
  servers.push(desk)
  return desk
}

const userLine = (n: number, text: string) => ({
  type: 'user',
  uuid: `u${n}`,
  timestamp: new Date(Date.UTC(2026, 9, 3, 10, 0, 0) + n * 1000).toISOString(),
  message: { role: 'user', content: text },
})


test('the index lists user messages, and a running task older than the newest 200 items', async () => {
  const lines: object[] = [userLine(0, '\n  first ask\nsecond line')]
  lines.push({ type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'bun run dev', run_in_background: true } }] } })
  lines.push({ type: 'user', uuid: 'r1', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Command running in background with ID: bg1' }] } })
  for (let i = 2; i < 2200; i++) lines.push(userLine(i, `m${i} ${FILLER}`))
  const desk = await bootWithSession(lines)
  const base = `${desk.url}/api/external/sessions/${SESSION}`
  const newest = (await (await fetch(`${base}/items`)).json()) as TranscriptItem[]
  const index = (await (await fetch(`${base}/index`)).json()) as TranscriptIndex
  const users = index.userMessages
  expect(index.total).toBeGreaterThan(newest.length)
  expect(users[0]).toMatchObject({ id: 'u0', position: 0, firstLine: 'first ask', images: 0 })
  expect(users.at(-1)!.firstLine.startsWith('m2199')).toBe(true)
  expect(index.lastUserText.startsWith('m2199')).toBe(true)
  expect(index.latestTodos).toBeNull()
  const one = (await (await fetch(`${base}/items/${users[3]!.id}`)).json()) as TranscriptItem
  expect(one.id).toBe(users[3]!.id)
  expect(index.runningTasks.map((t) => (t as { taskId: string }).taskId)).toEqual(['bg1'])
  expect((await fetch(`${base}/items/nope`)).status).toBe(404)
})
