// devservers/idle.ts and the idle pass: a server AgentHydra started stops once no client has used it for its idle time,
// through the public stop; a client, a counter that cannot read the connections, a zero setting and an outside server
// keep it up. The netstat parser is checked on its own.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DevServers } from '../../src/devservers/contract'
import { createDevServers } from '../../src/devservers/manager'
import { type ClientCounter, countClients } from '../../src/devservers/idle'
import { killHostTree, pidAlive } from '../../src/host/launch'
import type { Listener, ProcInfo, Scan } from '../../src/localhost/ports'

const dirs: string[] = []
const made: DevServers[] = []

const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'devs-idle-'))
  dirs.push(d)
  return d
}

afterEach(async () => {
  for (const ds of made.splice(0)) await ds.stopAll()
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // a child still letting go of its folder: the temp folder is the OS's to clean
    }
  }
})

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await sleep(50)
  }
}

const MIN = 60_000

/** The machine as the manager sees it, with the outside clients a test sets. */
class World {
  open = new Set<number>()
  listeners: Listener[] = []
  procs = new Map<number, ProcInfo>()
  killed: number[] = []
  clients: ClientCounter = async () => new Map()
  scanError: string | null = null
  t = 1_000_000

  listen(port: number, pid: number, name: string, command: string): void {
    this.open.add(port)
    this.listeners.push({ address: '127.0.0.1', port, pid })
    this.procs.set(pid, { pid, ppid: 1, name, command, created: 1_700_000_000_000 })
  }

  make(home: string): DevServers {
    const ds = createDevServers({
      home,
      importFrom: null,
      watch: false,
      deskPid: 1,
      deskPort: 7798,
      now: () => this.t,
      portListening: async (p) => this.open.has(p),
      alive: (pid) => (this.procs.has(pid) ? this.listeners.some((l) => l.pid === pid) : pidAlive(pid)),
      scan: async (): Promise<Scan> => ({ listeners: [...this.listeners], procs: new Map(this.procs), error: this.scanError }),
      findProjects: async () => ({ files: [], detected: [], scannedDirs: 0, truncated: false, timedOut: false, ms: 0, roots: [] }),
      kill: (pid) => {
        this.killed.push(pid)
        // A server the manager spawned is a real bun child: end it, or every stop waits out the grace time.
        if (!this.procs.has(pid)) void killHostTree(pid)
      },
      clients: (servers) => this.clients(servers),
    })
    made.push(ds)
    return ds
  }
}

const LONG = 'bun -e "setTimeout(()=>{},30000)"'

/** A project with one server on 4173; the server is started and its port answers, so it is `running`. */
async function startedServer(w: World): Promise<{ ds: DevServers; id: string }> {
  const dir = tmp()
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, '.devwebui'), JSON.stringify({ name: 'Example', processes: [{ id: 'web', name: 'Web', command: LONG, port: 4173 }] }))
  const ds = w.make(tmp())
  const res = await ds.load(dir)
  if (!('ok' in res)) throw new Error('expected a loaded project')
  const id = res.project.processes[0]!.id
  await ds.start(id)
  w.open.add(4173)
  await until(async () => (await ds.process(id))?.status === 'running')
  return { ds, id }
}

describe('idle dev servers stop themselves', () => {
  test('a server with no client is stopped once its idle time has passed, through the public stop, and its log says why', async () => {
    const w = new World()
    const { ds, id } = await startedServer(w)

    w.t += 29 * MIN
    expect(await ds.checkIdle()).toEqual([])
    w.t += 2 * MIN
    expect(await ds.checkIdle()).toEqual([id])
    expect(await ds.process(id)).toMatchObject({ status: 'stopped' })
    expect((await ds.logs(id)).some((l) => l.line.includes('stopped: no one used it for 30 min'))).toBe(true)
  })

  test('a client keeps it up and resets its idle time: stopped at minute 51, not at 49', async () => {
    const w = new World()
    const { ds, id } = await startedServer(w)

    w.t += 20 * MIN
    w.clients = async () => new Map([[id, 1]])
    expect(await ds.checkIdle()).toEqual([])
    w.clients = async () => new Map([[id, 0]])

    w.t += 29 * MIN
    expect(await ds.checkIdle()).toEqual([])
    expect(await ds.process(id)).toMatchObject({ status: 'running' })

    w.t += 2 * MIN
    expect(await ds.checkIdle()).toEqual([id])
  })

  test('idleStopMinutes 0 never stops a server', async () => {
    const w = new World()
    const { ds, id } = await startedServer(w)
    await ds.saveSettings({ idleStopMinutes: 0 })

    w.t += 600 * MIN
    expect(await ds.checkIdle()).toEqual([])
    expect(await ds.process(id)).toMatchObject({ status: 'running' })
  })

  test('a counter that cannot read the connections (null) never stops a server', async () => {
    const w = new World()
    const { ds, id } = await startedServer(w)
    w.clients = async () => null

    w.t += 600 * MIN
    expect(await ds.checkIdle()).toEqual([])
    expect(await ds.process(id)).toMatchObject({ status: 'running' })
  })

  test('a failed process scan judges nothing idle', async () => {
    const w = new World()
    const { ds, id } = await startedServer(w)
    w.scanError = 'netstat failed'

    w.t += 600 * MIN
    expect(await ds.checkIdle()).toEqual([])
    expect(await ds.process(id)).toMatchObject({ status: 'running' })
  })

  test('a linked group stays up while one member is in use, and stops together once none is', async () => {
    const w = new World()
    const dir = tmp()
    mkdirSync(dir, { recursive: true })
    const processes = [
      { id: 'web', name: 'Web', command: LONG, port: 4173, links: ['api'] },
      { id: 'api', name: 'Api', command: LONG, port: 4174 },
    ]
    writeFileSync(path.join(dir, '.devwebui'), JSON.stringify({ name: 'Example', processes }))
    const ds = w.make(tmp())
    const res = await ds.load(dir)
    if (!('ok' in res)) throw new Error('expected a loaded project')
    const [web, api] = res.project.processes.map((p) => p.id) as [string, string]
    await ds.start(web)
    w.open.add(4173)
    w.open.add(4174)
    await until(async () => (await ds.process(web))?.status === 'running' && (await ds.process(api))?.status === 'running')

    w.t += 31 * MIN
    w.clients = async () => new Map([[web, 0], [api, 1]])
    expect(await ds.checkIdle()).toEqual([])
    expect(await ds.process(web)).toMatchObject({ status: 'running' })

    w.clients = async () => new Map([[web, 0], [api, 0]])
    w.t += 31 * MIN
    expect((await ds.checkIdle()).sort()).toEqual([api, web].sort())
  })

  test('an outside server answering on the port is never stopped nor killed', async () => {
    const w = new World()
    const dir = tmp()
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, '.devwebui'), JSON.stringify({ name: 'Example', processes: [{ id: 'web', name: 'Web', command: LONG, port: 4173 }] }))
    w.listen(4173, 900, 'node', 'node C:/Users/me/app/node_modules/vite/bin/vite.js')
    const ds = w.make(tmp())
    const res = await ds.load(dir)
    if (!('ok' in res)) throw new Error('expected a loaded project')
    const id = res.project.processes[0]!.id
    await ds.start(id)

    w.t += 600 * MIN
    expect(await ds.checkIdle()).toEqual([])
    expect(w.killed).toEqual([])
    expect(await ds.process(id)).toMatchObject({ status: 'running', owner: 'outside', pid: 900 })
  })
})

describe('countClients', () => {
  const servers = [{ id: 'a', ports: [5173], treePids: new Set([100, 101]) }]
  const count = (text: string, s = servers) => countClients(text, s)?.get('a')

  test('a browser on the port counts; a server talking only to its own child does not; IPv6 and LAN peers are read', () => {
    const browser = [
      '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       100',
      '  TCP    127.0.0.1:5173         127.0.0.1:50001        ESTABLISHED     100',
      '  TCP    127.0.0.1:50001        127.0.0.1:5173         ESTABLISHED     7000',
    ].join('\n')
    expect(count(browser)).toBe(1)

    const ownChild = [
      '  TCP    127.0.0.1:5173         127.0.0.1:50002        ESTABLISHED     100',
      '  TCP    127.0.0.1:50002        127.0.0.1:5173         ESTABLISHED     101',
    ].join('\n')
    expect(count(ownChild)).toBe(0)

    const ipv6 = [
      '  TCP    [::1]:5173             [::1]:50003            ESTABLISHED     100',
      '  TCP    [::1]:50003            [::1]:5173             ESTABLISHED     7001',
    ].join('\n')
    expect(count(ipv6)).toBe(1)

    const lan = '  TCP    192.168.1.20:5173      192.168.1.30:55555     ESTABLISHED     100'
    expect(count(lan)).toBe(1)
  })

  test('output with no ESTABLISHED row (netstat in another language) is unknown, never zero clients', () => {
    const german = '  TCP    127.0.0.1:5173         127.0.0.1:50001        HERGESTELLT     100'
    expect(countClients(german, servers)).toBeNull()
    expect(countClients('', servers)).toBeNull()
  })
})
