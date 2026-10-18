// The core's tasks (core/README.md, "Tasks"): POST /api/tasks runs one prompt on the cheapest route with room that can
// do its tools. An agent task (read, edit, all) runs on a Claude login, then a Codex login. A tool-free one runs on a
// Free ChatGPT login (Desk 2's Free API), then on HSwarm's own tool-free ask, which picks its model itself. Nothing
// here polls: a wait races the task's own promise against a timer.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accounts } from './accounts'
import { chatgptBackend } from './backends/chatgpt'
import { claudeBackend } from './backends/claude'
import { codexBackend } from './backends/codex'
import type { Account, Backend, Service, ServiceThread, Task, TurnEnd, TurnSink } from './types'

type Tools = 'none' | 'read' | 'edit' | 'all'
type Status = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/** A reviewer's pass or fail on a finished task, with the time it was given. */
export interface Verdict {
  pass: boolean
  note: string | null
  at: number
}

/** The row the API answers and tasks.jsonl appends on every change. */
export interface TaskRow {
  id: string
  status: Status
  kind: string | null
  backend: Service | 'hswarm' | null
  account: { service: string; label: string } | null
  result: string | null
  error: string | null
  startedAt: number
  endedAt: number | null
  verdict: Verdict | null
}

interface Spec {
  prompt: string
  cwd: string
  tools: Tools
  title: string
  kind: string | null
}

/** A task in memory: its spec, its row, the account it runs on and the thread that account gave it, the running turn's
 *  stop, and the promise a wait races. */
interface Live extends Spec {
  row: TaskRow
  picked: Account | null
  thread?: ServiceThread
  stop: (() => void) | null
  settled: Promise<void>
  settle: () => void
}

const CORE_HOME = process.env.CORE_HOME ?? join(homedir(), '.agenthydra-core')
const LOG = join(CORE_HOME, 'tasks.jsonl')
/** The folder that holds `hswarm/` (the daemon's AGENTHYDRA_HSWARM_DIR; default: the app folder beside core/). */
const HSWARM_HOME =
  process.env.AGENTHYDRA_HSWARM_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TOOLS: readonly string[] = ['none', 'read', 'edit', 'all']

const pool = accounts()
const backends: Record<Service, Backend> = {
  claude: claudeBackend(),
  codex: codexBackend(),
  chatgpt: chatgptBackend(),
}
const tasks = new Map<string, Live>()

function save(row: TaskRow): void {
  mkdirSync(CORE_HOME, { recursive: true })
  appendFileSync(LOG, `${JSON.stringify(row)}\n`)
}

function update(t: Live, patch: Partial<TaskRow>): void {
  Object.assign(t.row, patch)
  save(t.row)
}

/** Settles a task once: a later finish (the route after a cancel) changes nothing. */
function finish(t: Live, status: Status, patch: Partial<TaskRow>): void {
  if (t.row.endedAt !== null) return
  update(t, { status, endedAt: Date.now(), ...patch })
  t.settle()
}

/** Plan for read, acceptEdits for edit, bypassPermissions for all (the Claude and Codex permission modes). */
function permissionOf(tools: Tools): string {
  return tools === 'edit' ? 'acceptEdits' : tools === 'all' ? 'bypassPermissions' : 'plan'
}

/** One turn of the task on one account; its last assistant_text is the result. */
async function turnOn(
  t: Live,
  backend: Backend,
  account: Account,
  text = t.prompt,
): Promise<TurnEnd & { text?: string }> {
  const got: { text?: string } = {}
  const sink: TurnSink = {
    item: (item) => {
      if (item.kind === 'assistant_text') got.text = item.text
    },
    thread: (th) => {
      t.thread = th
    },
    activity: () => undefined,
  }
  const task: Task = {
    chatId: t.row.id,
    cwd: t.cwd,
    title: t.title,
    text,
    thread: t.thread,
    permissionMode: permissionOf(t.tools),
    model: null,
  }
  const turn = backend.start(task, account, sink)
  t.stop = () => turn.interrupt()
  if (t.row.status !== 'running') turn.interrupt() // cancelled while the account was being picked
  const end = await turn.done
  t.stop = null
  return { ...end, text: got.text }
}

/** HSwarm's tool-free ask: `python -m hswarm ask <prompt> --json` answers {status, answer, error}. */
function hswarmAsk(t: Live): Promise<{ ok: boolean; text?: string; error?: string }> {
  return new Promise((resolveAsk) => {
    const child: ChildProcess = spawn(
      process.env.HSWARM_PYTHON ?? 'python',
      ['-m', 'hswarm', 'ask', t.prompt, '--profile', 'general', '--json'],
      {
        cwd: HSWARM_HOME,
        windowsHide: true,
      },
    )
    let out = ''
    t.stop = () => child.kill()
    if (t.row.status !== 'running') child.kill() // cancelled while the route was being chosen
    child.stdin?.end()
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.resume()
    child.on('error', (err) => resolveAsk({ ok: false, error: err.message }))
    child.on('close', () => {
      t.stop = null
      try {
        // `--json` prints the answer indented, after any notice lines: it starts at the last line opening with `{`.
        const at = out.lastIndexOf('\n{')
        const r = JSON.parse(at >= 0 ? out.slice(at) : out)
        resolveAsk(
          r.status === 'ok' && typeof r.answer === 'string'
            ? { ok: true, text: r.answer }
            : { ok: false, error: String(r.error ?? r.status ?? 'HSwarm failed.') },
        )
      } catch {
        resolveAsk({ ok: false, error: 'HSwarm gave no answer.' })
      }
    })
  })
}

/** The route: tool-free goes ChatGPT (Free), then HSwarm; an agent task goes Claude, then Codex. An account that hits
 *  its limit is held and the message goes on the next one; a failed turn moves on the same way. */
async function route(t: Live): Promise<void> {
  update(t, { status: 'running' })
  const avoid = new Set<string>()
  let last = 'No route has room for this task.'
  const steps: Array<Service | 'hswarm'> =
    t.tools === 'none' ? ['chatgpt', 'hswarm'] : ['claude', 'codex']
  for (const step of steps) {
    if (step === 'hswarm') {
      if (t.row.status !== 'running') return
      t.picked = null
      update(t, { backend: 'hswarm', account: { service: 'hswarm', label: 'HSwarm' } })
      const ask = await hswarmAsk(t)
      if (ask.ok) return finish(t, 'done', { result: ask.text ?? '', error: null })
      last = ask.error ?? last
      continue
    }
    for (;;) {
      if (t.row.status !== 'running') return
      const picked = await pool.pick(step, avoid)
      if ('why' in picked) {
        last = picked.why
        break
      }
      avoid.add(picked.id)
      t.picked = picked
      update(t, { backend: step, account: { service: picked.service, label: picked.label } })
      const end = await turnOn(t, backends[step], picked)
      if (end.limitedUntil !== undefined) pool.hold(picked.id, end.limitedUntil)
      if (end.ok) return finish(t, 'done', { result: end.text ?? '', error: null })
      if (t.row.status !== 'running') return
      last = end.error ?? 'The turn failed.'
      console.warn(`[core:tasks] ${t.row.id.slice(0, 8)} ${step} ${picked.id.slice(0, 8)}: ${last}`)
    }
  }
  finish(t, 'failed', { error: last })
}

/** A follow-up turn in the task's own thread, on the account and backend that ran it. The row goes back to running
 *  before the first await, so the answer already says so; its result is the new turn's last assistant_text. */
async function followUp(t: Live, account: Account, text: string): Promise<void> {
  const { settled, settle } = gate()
  t.settled = settled
  t.settle = settle
  update(t, { status: 'running', endedAt: null, result: null, error: null })
  const end = await turnOn(t, backends[account.service], account, text)
  if (end.limitedUntil !== undefined) pool.hold(account.id, end.limitedUntil)
  if (end.ok) return finish(t, 'done', { result: end.text ?? '', error: null })
  if (t.row.status !== 'running') return
  finish(t, 'failed', { error: end.error ?? 'The turn failed.' })
}

function cancel(t: Live): void {
  if (t.row.endedAt !== null) return
  finish(t, 'cancelled', { error: 'Cancelled.' })
  t.stop?.()
}

function parseSpec(body: unknown): Spec | string {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : ''
  if (!prompt) return 'prompt must be non-empty text'
  const cwd = typeof o.cwd === 'string' ? o.cwd : ''
  if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory())
    return 'cwd must be an existing absolute folder'
  if (typeof o.tools !== 'string' || !TOOLS.includes(o.tools))
    return 'tools must be none, read, edit or all'
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : prompt.slice(0, 60)
  const kind = typeof o.kind === 'string' && o.kind.trim() ? o.kind.trim() : null
  return { prompt, cwd, tools: o.tools as Tools, title, kind }
}

/** A promise that settles once, and the function that settles it: what a wait races. */
function gate(): Pick<Live, 'settled' | 'settle'> {
  let settle!: () => void
  const settled = new Promise<void>((resolveSettled) => (settle = resolveSettled))
  return { settled, settle }
}

function newTask(spec: Spec): Live {
  const row: TaskRow = {
    id: randomUUID(),
    status: 'queued',
    kind: spec.kind,
    backend: null,
    account: null,
    result: null,
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    verdict: null,
  }
  const t: Live = { ...spec, row, picked: null, stop: null, ...gate() }
  tasks.set(row.id, t)
  save(row)
  return t
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The request's JSON object; null when the body is not JSON. */
async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await req.json()
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return null
  }
}

/** The newest tasks first, for the window: `limit` is 1 to 500, 50 by default. */
function listRows(raw: string | null): TaskRow[] {
  const n = Number(raw ?? 50)
  const limit = Number.isFinite(n) ? Math.min(500, Math.max(1, Math.floor(n))) : 50
  return [...tasks.values()]
    .map((t) => t.row)
    .reverse()
    .slice(0, limit)
}

/** The /api/tasks routes; null for any other path, so the server goes on to its own routes. */
export function taskRoutes(): (req: Request, url: URL) => Promise<Response | null> {
  return async (req, url) => {
    const m = /^\/api\/tasks(?:\/([^/]+)(?:\/(wait|cancel|send|verdict))?)?$/.exec(url.pathname)
    if (!m) return null
    const [, id, action] = m
    if (!id) {
      if (req.method === 'GET') return json(listRows(url.searchParams.get('limit')))
      if (req.method !== 'POST') return json({ error: 'Use GET or POST.' }, 405)
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return json({ error: 'The body must be JSON.' }, 400)
      }
      const spec = parseSpec(body)
      if (typeof spec === 'string') return json({ error: spec }, 400)
      const t = newTask(spec)
      void route(t).catch((err) =>
        finish(t, 'failed', { error: err instanceof Error ? err.message : String(err) }),
      )
      return json({ id: t.row.id, status: 'queued' }, 201)
    }
    const t = tasks.get(id)
    if (!t) return json({ error: 'No such task.' }, 404)
    if (!action) return req.method === 'GET' ? json(t.row) : json({ error: 'Use GET.' }, 405)
    if (action === 'wait' && req.method === 'GET') {
      const raw = Number(url.searchParams.get('seconds') ?? 30)
      const seconds = Number.isFinite(raw) ? Math.min(50, Math.max(1, raw)) : 30
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        t.settled,
        new Promise<void>((resolveTimer) => (timer = setTimeout(resolveTimer, seconds * 1000))),
      ])
      clearTimeout(timer)
      return json(t.row)
    }
    if (action === 'cancel' && req.method === 'POST') {
      cancel(t)
      return json(t.row)
    }
    if (action === 'send' && req.method === 'POST') {
      const o = await jsonBody(req)
      if (!o) return json({ error: 'The body must be JSON.' }, 400)
      const text = typeof o.text === 'string' ? o.text.trim() : ''
      if (!text) return json({ error: 'text must be non-empty text' }, 400)
      if (t.row.status === 'queued' || t.row.status === 'running')
        return json({ error: 'The task is still running: send once it has settled.' }, 409)
      if (!t.picked)
        return json({ error: 'This task ran on HSwarm, which keeps no thread to continue.' }, 409)
      void followUp(t, t.picked, text).catch((err) =>
        finish(t, 'failed', { error: err instanceof Error ? err.message : String(err) }),
      )
      return json(t.row, 202)
    }
    if (action === 'verdict' && req.method === 'POST') {
      const o = await jsonBody(req)
      if (!o) return json({ error: 'The body must be JSON.' }, 400)
      if (typeof o.pass !== 'boolean') return json({ error: 'pass must be true or false' }, 400)
      if (o.note !== undefined && typeof o.note !== 'string')
        return json({ error: 'note must be text' }, 400)
      if (t.row.status !== 'done' && t.row.status !== 'failed')
        return json({ error: 'A verdict needs a task that is done or failed.' }, 409)
      const pass = o.pass
      update(t, {
        verdict: { pass, note: typeof o.note === 'string' ? o.note : null, at: Date.now() },
      })
      return json(t.row)
    }
    return json({ error: 'Use GET or POST on this path.' }, 405)
  }
}
