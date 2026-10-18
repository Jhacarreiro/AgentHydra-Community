// GET /api/external/sessions/:id/search.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBridge } from '../src/bridge'
import { createServer, type DeskServer } from '../src/index'
import { searchItems } from '@shared/find'
import type { TranscriptItem } from '@shared/protocol'

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


test('a term only in the oldest page is found, and the total equals the matches over the full array', async () => {
  const lines: object[] = [userLine(0, 'quokka quokka at the start')]
  for (let i = 1; i < 2200; i++) lines.push(userLine(i, `m${i} ${FILLER}`))
  const desk = await bootWithSession(lines)
  const base = `${desk.url}/api/external/sessions/${SESSION}`
  const newest = (await (await fetch(`${base}/items`)).json()) as TranscriptItem[]
  expect(searchItems(newest, 'quokka')).toEqual([])
  const found = (await (await fetch(`${base}/search?q=quokka`)).json()) as { hits: unknown[]; total: number }
  expect(found.total).toBe(2)
  expect(found.hits).toEqual([{ itemId: 'u0', position: 0, nth: 0 }, { itemId: 'u0', position: 0, nth: 1 }])
  const everyM = (await (await fetch(`${base}/search?q=m2`)).json()) as { total: number }
  expect(everyM.total).toBe(searchItems(lines.map((l, i) => ({ kind: 'user', id: `u${i}`, ts: 0, text: i === 0 ? 'quokka quokka at the start' : `m${i} ${FILLER}` })) as TranscriptItem[], 'm2').length)
  expect((await (await fetch(`${base}/search?q=`)).json()) as object).toEqual({ hits: [], total: 0 })
})
