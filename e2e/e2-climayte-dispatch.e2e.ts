// E2: CliMayte from outside. A CLI instance made over HTTP and signed in the way a login leaves it,
// one task dispatched over POST /api/corch/workers to the fake CLI (server/tests/mocks/fake-claude.ts
// via AGENTHYDRA_CLAUDE_PATH), the same request sent again, the worker run to done, the daemon
// SIGKILLed and booted again: once after the store has the worker done, once at the moment the
// worker ends. What server/tests/climayte-request-id.test.ts and climayte-steering.test.ts check in
// process, with the instance store, the usage cache and HTTP in the path this time.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync, watch } from 'node:fs'
import { join, sep } from 'node:path'
import { type Answer, type Daemon, scenario, signIn, waitFor } from './harness'

const lane = scenario('E2')
const home = lane.home()

let daemon: Daemon
let instance: { id: string; configDir: string }
const task = {
  prompt: 'e2e: say hello',
  cwd: join(home.dir, 'work'),
  title: 'e2e task',
  model: 'sonnet',
  effort: 'medium',
  ownerWords: 'e2e',
  requestId: crypto.randomUUID(),
}
const dispatch = () =>
  daemon.api('/api/corch/workers', { method: 'POST', body: JSON.stringify({ tasks: [task] }) })
let first: Answer
let repeat: Answer

/** The fake CLI's own record of every launch on this instance (one JSON line each). */
function launches(): Array<{ session: string; resume: boolean; prompt: string }> {
  const file = join(instance.configDir, 'fake-launches.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

/** CliMayte's store in the temp home (server/src/climayte-core.ts ROOT, `corch` under
 *  AGENTHYDRA_HOME): workers.json holds the workers still in flight, done/<id>.json each finished
 *  one, and logs/ each attempt's output beside its runner's pid and exit files. */
const corch = join(home.env.AGENTHYDRA_HOME as string, 'corch')

/** Whether the worker's end has fully reached the disk: filed under done/ as done, and gone from
 *  workers.json, whose copy wins over done/'s when both have it (climayte-core.ts mergeDone). */
function storedDone(id: string): boolean {
  const filed = JSON.parse(readFileSync(join(corch, 'done', `${id}.json`), 'utf8'))
  const hot: Array<{ id: string }> = JSON.parse(
    readFileSync(join(corch, 'workers.json'), 'utf8'),
  ).workers
  return filed.status === 'done' && !hot.some((w) => w.id === id)
}

/** A worker as GET /api/corch/workers/:id answers it. */
async function workerNow(id: string): Promise<{ status?: string; attempts?: unknown[] }> {
  const r = await daemon.api(`/api/corch/workers/${encodeURIComponent(id)}`)
  return r.body.worker ?? r.body
}

test('E2: a CLI instance made over HTTP lives in the temp home and reads as signed in', async () => {
  daemon = await lane.boot(home)
  const made = await daemon.api('/api/cli-instances', {
    method: 'POST',
    body: JSON.stringify({ name: 'e2e-a' }),
  })
  expect(made.status).toBe(200)
  instance = made.body.data
  expect(instance.configDir.startsWith(home.dir + sep)).toBe(true)
  signIn(home, instance)
  const listed = (await daemon.api('/api/cli-instances')).body
  const rows: Array<{ id: string; loggedIn: boolean }> = listed.instances ?? listed.data ?? listed
  expect(rows.find((r) => r.id === instance.id)?.loggedIn).toBe(true)
}, 60_000)

test('E2: a task dispatches, and the same request sent again answers the same worker', async () => {
  first = await dispatch()
  expect(first.status).toBe(200)
  expect(first.body.workers[0].id).toMatch(/^w-/)
  repeat = await dispatch()
  expect(repeat.status).toBe(200)
  expect(repeat.body.workers[0]).toMatchObject({ id: first.body.workers[0].id, repeat: true })
})

// Until fa5f5e3 an unnamed repeat answered under a fresh g-<6 hex> group that held none of
// its workers (climayteRun named the group `named || g-<6 hex>` even when every task repeated).
test('E2: a repeat answers in the group of the worker it repeats', () => {
  expect(repeat.body.group).toBe(repeat.body.workers[0].group)
})

test('E2: the worker reaches done on the fake CLI, launched once', async () => {
  const id = first.body.workers[0].id
  let worker: { status?: string; account?: string } = {}
  for (let i = 0; i < 12 && worker.status !== 'done' && worker.status !== 'failed'; i++) {
    const r = await daemon.api(`/api/corch/workers/${encodeURIComponent(id)}?wait=5`)
    worker = r.body.worker ?? r.body
  }
  expect(worker.status).toBe('done')
  expect(worker.account).toContain('e2e-a')
  const seen = launches()
  expect(seen).toHaveLength(1)
  expect(seen[0]?.prompt).toContain(task.prompt)
}, 90_000)

test('E2: once the store has the worker done, a SIGKILL and a reboot keep it done, and the request still repeats', async () => {
  const id = first.body.workers[0].id
  await waitFor('the worker to be done on disk', () => storedDone(id), 15_000, 50)
  await daemon.stop('SIGKILL')
  daemon = await lane.boot(home, { port: daemon.port })
  expect((await workerNow(id)).status).toBe('done')
  const again = await dispatch()
  expect(again.status).toBe(200)
  expect(again.body.workers[0]).toMatchObject({ id, repeat: true })
  expect(launches()).toHaveLength(1)
}, 90_000)

test('E2: a SIGKILL the moment a worker ends never launches it again, and its request still repeats', async () => {
  // The daemon is killed as the runner's exit file goes, which finish() does on the thread before the
  // worker's end is queued to the disk (server/src/climayte.ts finish, cleanUpRunner). Either side
  // of that race is allowed here; what may never happen is a second launch or a second worker.
  const crashTask = { ...task, prompt: 'e2e: say hello again', requestId: crypto.randomUUID() }
  const logs = join(corch, 'logs')
  let exitFile = ''
  let killedAtExit = false
  const watcher = watch(logs, (_event, name) => {
    if (!exitFile || name !== exitFile || existsSync(join(logs, exitFile))) return
    if (daemon.proc.exitCode === null && daemon.proc.signalCode === null) {
      daemon.proc.kill('SIGKILL')
      killedAtExit = true
    }
  })
  try {
    const sent = await daemon.api('/api/corch/workers', {
      method: 'POST',
      body: JSON.stringify({ tasks: [crashTask] }),
    })
    expect(sent.status).toBe(200)
    const id: string = sent.body.workers[0].id
    exitFile = `${id}-0.jsonl.exit.json`
    // The exit file may already be gone, or the watcher may miss it: then the end is awaited over
    // HTTP and the kill follows it as closely as this side can.
    await waitFor(
      'the worker to end',
      async () => killedAtExit || (await workerNow(id)).status === 'done',
      60_000,
      20,
    )
    watcher.close()
    await daemon.stop('SIGKILL')
    daemon = await lane.boot(home, { port: daemon.port })
    const after = await workerNow(id)
    console.log(
      `  E2 crash at the end: killed ${killedAtExit ? 'as the exit file went' : 'after done over HTTP'}, the reboot reads it ${after.status}`,
    )
    // done: the end reached the disk first. running: it did not, and the reboot cannot tell the
    // runner ended (README, known findings). Never queued again, failed, or on a second attempt.
    expect(['done', 'running']).toContain(after.status as string)
    expect(after.attempts).toHaveLength(1)
    const again = await daemon.api('/api/corch/workers', {
      method: 'POST',
      body: JSON.stringify({ tasks: [crashTask] }),
    })
    expect(again.status).toBe(200)
    expect(again.body.workers[0]).toMatchObject({ id, repeat: true })
    // A few ticks of the rebooted daemon, then still one launch of each task and one attempt.
    await Bun.sleep(3_000)
    expect((await workerNow(id)).attempts).toHaveLength(1)
    expect(launches().filter((l) => l.prompt.includes(crashTask.prompt))).toHaveLength(1)
    expect(launches()).toHaveLength(2)
  } finally {
    watcher.close()
  }
}, 120_000)

lane.realHomeUntouched()
