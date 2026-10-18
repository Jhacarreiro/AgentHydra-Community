// server/tests/helpers.test.ts - the always-on helpers the daemon owns (server/src/helpers.ts).
//
// The point of the list is one copy of each helper: one nobody runs is started, one already running is
// adopted and never doubled (not even when the process table cannot be read), one past its memory cap is
// restarted, one that keeps dying waits longer each time instead of being started every check, and
// stop-all holds across a daemon restart until start-all.

import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHelpers, type HelperDeps, type Lookup } from '../src/helpers'

const tmp = mkdtempSync(join(tmpdir(), 'helpers-test-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

let n = 0
function world(helpers: unknown[]) {
  const dir = join(tmp, String(++n))
  mkdirSync(dir)
  writeFileSync(join(dir, 'helpers.json'), JSON.stringify({ helpers }))
  const w = {
    clock: 1_000_000,
    ports: new Map<number, Lookup>(),
    commands: new Map<string, Lookup>(),
    memory: new Map<number, number>(),
    alive: new Set<number>(),
    spawned: [] as string[][],
    killed: [] as number[],
    nextPid: 100,
    deps: null as unknown as HelperDeps,
  }
  w.deps = {
    configPath: join(dir, 'helpers.json'),
    statePath: join(dir, 'state.json'),
    logDir: join(dir, 'logs'),
    appRoot: 'C:/apps/hydra',
    findByPort: (port) => w.ports.get(port) ?? 'none',
    findByCommand: (exe, match) => w.commands.get(`${exe}|${match}`) ?? 'none',
    memoryMB: (pid) => w.memory.get(pid) ?? 50,
    alive: (pid) => w.alive.has(pid),
    spawn: async (cmd) => {
      w.spawned.push(cmd)
      const pid = w.nextPid++
      w.alive.add(pid)
      return pid
    },
    kill: (pid) => {
      w.killed.push(pid)
      w.alive.delete(pid)
    },
    now: () => w.clock,
  }
  return w
}

test('a helper nobody runs is started; one already running is adopted and never doubled', async () => {
  const w = world([
    { id: 'mcp', label: 'An MCP server', command: ['python', '{APP_ROOT}/server.py'], port: 9001 },
    { id: 'watcher', command: ['pwsh', '-File', 'watch.ps1'], exe: 'pwsh.exe', match: 'watch.ps1' },
    { id: 'blind', command: ['node', 'blind.mjs'], port: 9002 },
  ])
  w.commands.set('pwsh.exe|watch.ps1', 500)
  w.ports.set(9002, 'unknown')
  const h = createHelpers(w.deps)

  await h.tick()
  expect(w.spawned).toEqual([['python', 'C:/apps/hydra/server.py']])
  const rows = Object.fromEntries(h.view().helpers.map((r) => [r.id, r]))
  expect(rows.watcher).toMatchObject({ state: 'running', pid: 500, adopted: true })
  expect(rows.mcp).toMatchObject({ state: 'starting', pid: 100 })
  expect(rows.blind).toMatchObject({
    state: 'waiting',
    lastError: 'could not read the process table',
  })

  // The one it started opens its port: it is running, as this daemon's own, and nothing else starts.
  w.ports.set(9001, 100)
  await h.tick()
  await h.tick()
  expect(w.spawned).toHaveLength(1)
  expect(h.view().helpers.find((r) => r.id === 'mcp')).toMatchObject({
    state: 'running',
    pid: 100,
    adopted: false,
  })
})

test('a helper past its memory cap is restarted; one that keeps dying waits longer each time', async () => {
  const w = world([
    {
      id: 'big',
      command: ['pwsh', '-File', 'big.ps1'],
      exe: 'pwsh.exe',
      match: 'big.ps1',
      memoryCapMB: 400,
    },
    { id: 'crashy', command: ['node', 'crashy.mjs'], port: 9003 },
  ])
  w.commands.set('pwsh.exe|big.ps1', 7)
  w.memory.set(7, 450)
  w.alive.add(7)
  const h = createHelpers(w.deps)

  await h.tick() // big is over its cap and ended; crashy is started
  expect(w.killed).toEqual([7])
  expect(h.view().helpers.find((r) => r.id === 'big')).toMatchObject({
    restarts: 1,
    lastError: expect.stringContaining('over its 400 MB cap'),
  })
  w.commands.set('pwsh.exe|big.ps1', 'none')
  w.alive.delete(100) // crashy (pid 100) died at once

  await h.tick() // big starts fresh; crashy is seen dead and waits
  expect(w.spawned.map((c) => c[1])).toEqual(['crashy.mjs', '-File'])
  await h.tick()
  expect(w.spawned).toHaveLength(2)

  w.clock += 31_000 // past the first 30 s wait
  w.alive.clear()
  await h.tick()
  expect(w.spawned.filter((c) => c[1] === 'crashy.mjs')).toHaveLength(2)
  w.alive.clear()
  await h.tick() // dead again: the second wait is 60 s, so 31 s more does not start it
  w.clock += 31_000
  await h.tick()
  expect(w.spawned.filter((c) => c[1] === 'crashy.mjs')).toHaveLength(2)
})

test('stop-all ends every helper and starts none, across a daemon restart, until start-all', async () => {
  const w = world([{ id: 'mcp', command: ['python', 'server.py'], port: 9001 }])
  w.ports.set(9001, 42)
  const h = createHelpers(w.deps)
  await h.tick()

  await h.stopAll()
  expect(w.killed).toEqual([42])
  w.ports.set(9001, 'none')
  await h.tick()
  const next = createHelpers(w.deps) // the daemon restarted
  await next.tick()
  expect(w.spawned).toHaveLength(0)
  expect(next.view()).toMatchObject({ paused: true, helpers: [{ id: 'mcp', state: 'stopped' }] })

  await next.startAll()
  expect(w.spawned).toEqual([['python', 'server.py']])
})
