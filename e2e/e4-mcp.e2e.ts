// E4: the MCP server over both transports against one live daemon: stdio (`bun server/src/mcp.ts`,
// a relay over HTTP) and HTTP (POST /api/mcp on the daemon). docs/REFERENCE.md says they share one
// dispatcher and cannot drift; this checks it from the client's side, on a seeded Claude transcript.
//
// add_queue_item is here on purpose. Its own description says the daemon refuses every call with
// HTTP 409 (server/src/mcp-session-tools.ts), and POST /api/queue does (server/src/routes/queue.ts,
// the no-headless refusal). Until 9a9581b, tests/mcp.test.ts stubbed fetch and asserted a success;
// it now hands the call to the daemon's routes on a copy of the shared app. This checks the same
// refusal over both transports on a live daemon.
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import { call, type Daemon, REPO, scenario, startPiped, tail } from './harness'

const lane = scenario('E4')
const home = lane.home()

// One invented Claude Code transcript, in the CLI's own JSONL shape, for list_sessions to find.
const SESSION = 'f0e2e000-0000-4000-8000-00000000e4e4'
const project = join(home.env.AGENTHYDRA_CLAUDE_PROJECTS_ROOT as string, '-work-e2e')
mkdirSync(project, { recursive: true })
const turn = (n: number, role: 'user' | 'assistant', text: string) =>
  `${JSON.stringify({
    type: role,
    uuid: `${SESSION}-${n}`,
    sessionId: SESSION,
    message: { role, content: text },
    cwd: '/work/e2e',
    timestamp: new Date(Date.now() - (10 - n) * 1000).toISOString(),
  })}\n`
writeFileSync(
  join(project, `${SESSION}.jsonl`),
  turn(1, 'user', 'e2e: list me') + turn(2, 'assistant', 'listed'),
)

let daemon: Daemon
let stdio: Subprocess<'pipe', 'pipe', number>
const pending = new Map<number, (msg: Rpc) => void>()
let nextId = 1

interface Rpc {
  id?: number
  /** Whatever the method answered. */
  result?: any
  error?: { code: number; message: string }
}

/** Read stdout as newline-delimited JSON-RPC (the MCP stdio framing) and settle requests by id. */
async function readStdio(out: ReadableStream<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of out) {
    buf += decoder.decode(chunk, { stream: true })
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line) as Rpc
      if (typeof msg.id === 'number') pending.get(msg.id)?.(msg)
    }
  }
}

function overStdio(method: string, params: object = {}): Promise<Rpc> {
  const id = nextId++
  const answer = new Promise<Rpc>((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => reject(new Error(`stdio ${method} answered nothing in 30 s`)), 30_000).unref()
  })
  stdio.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return answer
}

async function overHttp(method: string, params: object = {}): Promise<Rpc> {
  const r = await call(`${daemon.url}/api/mcp`, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })
  expect(r.status).toBe(200)
  return r.body
}

const both = (method: string, params: object = {}) =>
  Promise.all([overStdio(method, params), overHttp(method, params)])
const INIT = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'e2e', version: '1' },
}
const text = (r: Rpc): string => r.result?.content?.map((c: { text?: string }) => c.text).join('\n')

test('E4: both transports initialize as the same server', async () => {
  daemon = await lane.boot(home)
  const log = join(home.dir, 'logs', 'mcp-stdio.log')
  stdio = startPiped([process.execPath, 'server/src/mcp.ts'], {
    cwd: REPO,
    env: { ...home.env, AGENTHYDRA_URL: daemon.url },
    log,
  })
  void readStdio(stdio.stdout)
  const [s, h] = await both('initialize', INIT)
  expect(s.result?.serverInfo?.name).toBeTruthy()
  expect(s.result.serverInfo.name).toBe(h.result?.serverInfo?.name)
  expect(tail(log)).toContain('stdio server ready')
}, 60_000)

test('E4: both transports list the same tools, and neither lists add_queue_item', async () => {
  const [s, h] = await both('tools/list')
  const names = (r: Rpc) => (r.result.tools as Array<{ name: string }>).map((t) => t.name).sort()
  expect(names(s).length).toBeGreaterThan(5)
  expect(names(s)).toEqual(names(h))
  expect(names(s)).not.toContain('add_queue_item')
})

test('E4: list_sessions finds the seeded transcript over both transports', async () => {
  let found = ['', '']
  for (let i = 0; i < 20 && !found.every((t) => t.includes(SESSION)); i++) {
    const [s, h] = await both('tools/call', { name: 'list_sessions', arguments: { limit: 20 } })
    found = [text(s) ?? '', text(h) ?? '']
    if (!found.every((t) => t.includes(SESSION))) await Bun.sleep(250)
  }
  expect(found[0]).toContain(SESSION)
  expect(found[1]).toContain(SESSION)
}, 30_000)

test('E4: add_queue_item is refused with 409 over both transports, and nothing is queued', async () => {
  const args = { title: 'e2e', cwd: '/work/e2e', prompt: 'do the thing', new_chat: true }
  const [s, h] = await both('tools/call', { name: 'add_queue_item', arguments: args })
  for (const r of [s, h]) {
    expect(r.result.isError).toBe(true)
    expect(text(r)).toContain('409')
    expect(text(r)).toContain('no-headless')
  }
  const queue = await daemon.api('/api/queue')
  expect(queue.status).toBe(200)
  expect(queue.body).toEqual([])
})

test('E4: the stdio server ends when its client closes stdin', async () => {
  stdio.stdin.end()
  const code = await Promise.race([stdio.exited, Bun.sleep(10_000).then(() => null)])
  if (code === null) stdio.kill('SIGKILL')
  expect(code).toBe(0)
}, 20_000)

lane.realHomeUntouched()
