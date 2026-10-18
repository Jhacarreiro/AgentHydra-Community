// GET /api/external/sessions/:id/older?limit pages an outside session's history; without limit it answers whole.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBridge } from '../src/bridge'
import { createServer, type DeskServer } from '../src/index'
import { OLDER_BEFORE_HEADER, OLDER_END_HEADER, type TranscriptItem } from '@shared/protocol'
import { TAIL_BYTES } from '../src/bridge/session-jsonl'

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


test('older pages down to the first item with no gap or duplicate; without limit it is unchanged', async () => {
  const lines = Array.from({ length: 3000 }, (_, i) => userLine(i, `m${i} ${FILLER}`))
  expect(JSON.stringify(lines).length).toBeGreaterThan(TAIL_BYTES)
  const desk = await bootWithSession(lines)
  const base = `${desk.url}/api/external/sessions/${SESSION}`
  const head = await fetch(`${base}/items`)
  const newest = (await head.json()) as TranscriptItem[]
  const before = Number(head.headers.get(OLDER_BEFORE_HEADER))
  expect(before).toBeGreaterThan(0)

  const whole = (await (await fetch(`${base}/older?before=${before}`)).json()) as TranscriptItem[]
  expect(whole.length + newest.length).toBe(3000)

  const pages: TranscriptItem[][] = []
  let end: string | null = null
  for (let n = 0; n < 100; n++) {
    const res: Response = await fetch(`${base}/older?before=${before}&limit=250${end === null ? '' : `&end=${end}`}`)
    const page = (await res.json()) as TranscriptItem[]
    expect(page.length).toBeLessThanOrEqual(250)
    pages.unshift(page)
    end = res.headers.get(OLDER_END_HEADER)
    if (end === '0') break
  }
  const joined = pages.flat()
  expect(joined.map((i) => i.id)).toEqual(whole.map((i) => i.id))
  expect(joined[0]!.id).toBe('u0')
  expect(new Set(joined.map((i) => i.id)).size).toBe(joined.length)
})
