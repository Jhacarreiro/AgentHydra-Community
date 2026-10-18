// plugins/60-update.ts: the window hears when the server's code changed after it started, and Restart to update
// starts launcher/restart.ps1 only for a server the launcher started.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { logRestartAsk } from '../../src/caller'
import { HOST_PROTOCOL } from '../../src/host/protocol'
import { codeStamp, startedByLauncher, type CodeStamp, type UpdateDeps } from '../../src/plugins/60-update'
import { createServer, type DeskServer } from '../../src/index'

const PLUGIN = join(import.meta.dir, '..', '..', 'src', 'plugins', '60-update.ts')
const ENGINE_PLUGIN = join(import.meta.dir, '..', '..', 'src', 'plugins', '20-engine.ts')
const temps: string[] = []
const stops: (() => unknown)[] = []

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function boot(over: Partial<UpdateDeps> & { stamp?: () => CodeStamp } = {}) {
  const home = temp('desk-update-home-')
  const plugins = temp('desk-update-plugins-')
  writeFileSync(join(plugins, '60-update.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  const started: string[][] = []
  const deps: UpdateDeps = { bootedAt: 1000, stamp: () => ({ newest: 900, count: 3 }), platform: 'win32', pid: 4242, ppid: 4100, port: 7899, start: (argv) => started.push(argv), ...over }
  const desk: DeskServer = await createServer({ port: 0, home, pluginsDir: plugins, deps: { update: deps } })
  stops.push(() => desk.stop())
  return { desk, home, started }
}

/** server.pid as start.ps1 writes it: Set-Content -Encoding UTF8 on Windows PowerShell puts a BOM first. */
const pidFile = (home: string, serverPid: number, wrapperPid = 1) =>
  writeFileSync(join(home, 'server.pid'), `﻿${JSON.stringify({ serverPid, wrapperPid, port: 7798 })}`)

test('stale once a file of the server is newer than its start, or one was added or removed', async () => {
  let stamp: CodeStamp = { newest: 900, count: 3 }
  const { desk } = await boot({ stamp: () => stamp })
  const read = async () => (await fetch(`${desk.url}/api/server/update`)).json()
  expect(await read()).toEqual({ stale: false, restartable: false })
  stamp = { newest: 1500, count: 3 }
  expect((await read()).stale).toBe(true)
  stamp = { newest: 900, count: 2 }
  expect((await read()).stale).toBe(true)
})

test('restart starts launcher/restart.ps1, logging to the data home, only on a server the launcher started', async () => {
  const { desk, home, started } = await boot()
  const restart = (headers: Record<string, string> = {}) => fetch(`${desk.url}/api/server/restart`, { method: 'POST', headers })
  const windowAsk = { 'X-Desk-Caller': 'window', 'X-Desk-Chat': 'chat-1', 'User-Agent': 'Desk2Window/1' }
  // No pid file: started some other way (bun run dev), so nothing would bring it back.
  expect((await restart(windowAsk)).status).toBe(409)
  pidFile(home, 1)
  expect((await restart(windowAsk)).status).toBe(409)
  expect(started).toEqual([])

  pidFile(home, 4242)
  expect((await (await fetch(`${desk.url}/api/server/update`)).json()).restartable).toBe(true)
  const ok = await restart(windowAsk)
  expect(ok.status).toBe(202)
  expect(started).toHaveLength(1)
  const log = readFileSync(join(home, 'logs', 'restart.log'), 'utf8')
  expect(log).toContain('restart asked: caller=window chat=chat-1 user-agent="Desk2Window/1" -> accepted')
  expect(log).toContain('refused (not started by the launcher)')
  const command = started[0]!.at(-1)!
  expect(command).toContain(join('launcher', 'restart.ps1'))
  // The script starts with none of this server's environment: it is told which Desk to restart, never the default one.
  expect(command).toContain(`$env:HYDRA_DESK_HOME = '${home}'; $env:HYDRA_DESK_PORT = '7899'; & `)
  expect(command).toContain(`-FilePath '${join(home, 'logs', 'restart-run.log')}'`)
  expect(command).not.toContain(`'${join(home, 'logs', 'restart.log')}'`)
})

test('logRestartAsk drops a line its file cannot take instead of throwing', () => {
  const home = temp('desk-update-home-')
  mkdirSync(join(home, 'logs', 'restart.log'), { recursive: true })
  expect(() => logRestartAsk(home, 'restart asked: caller=window -> accepted')).not.toThrow()
})

test('a restart and a shutdown are still answered when restart.log cannot be written', async () => {
  const { desk, home, started } = await boot()
  mkdirSync(join(home, 'logs', 'restart.log'), { recursive: true })
  pidFile(home, 4242)
  const windowAsk = { 'X-Desk-Caller': 'window', 'User-Agent': 'Desk2Window/1' }
  expect((await fetch(`${desk.url}/api/server/restart`, { method: 'POST', headers: windowAsk })).status).toBe(202)
  expect(started).toHaveLength(1)

  const engine = temp('desk-update-engine-')
  writeFileSync(join(engine, '20-engine.ts'), `export { default } from ${JSON.stringify(pathToFileURL(ENGINE_PLUGIN).href)}\n`)
  let shutdowns = 0
  const engineDesk = await createServer({ port: 0, home, pluginsDir: engine, deps: { shutdown: () => void shutdowns++ } })
  stops.push(() => engineDesk.stop())
  const res = await fetch(`${engineDesk.url}/api/server/shutdown`, { method: 'POST', headers: { 'X-Desk-Caller': 'launcher', 'Content-Type': 'application/json' }, body: '{}' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, chats: false })
  await new Promise((r) => setTimeout(r, 100))
  expect(shutdowns).toBe(1)
})

test('a plain shutdown is answered while a chat host that never answers is still being taken over', async () => {
  const home = temp('desk-update-home-')
  const sockets: net.Socket[] = []
  const mute = net.createServer((s) => void sockets.push(s))
  await new Promise<void>((r) => mute.listen(0, '127.0.0.1', r))
  stops.push(() => {
    for (const s of sockets) s.destroy()
    mute.close()
  })
  mkdirSync(join(home, 'hosts'), { recursive: true })
  const port = (mute.address() as net.AddressInfo).port
  writeFileSync(join(home, 'hosts', 'chat-mute.json'), JSON.stringify({ protocol: HOST_PROTOCOL, chatId: 'chat-mute', pid: process.pid, port, token: 'x', startedAt: 1 }))

  const engine = temp('desk-update-engine-')
  writeFileSync(join(engine, '20-engine.ts'), `export { default } from ${JSON.stringify(pathToFileURL(ENGINE_PLUGIN).href)}\n`)
  let shutdowns = 0
  const desk = await createServer({ port: 0, home, pluginsDir: engine, deps: { shutdown: () => void shutdowns++ } })
  stops.push(() => desk.stop())
  const began = Date.now()
  const res = await fetch(`${desk.url}/api/server/shutdown`, { method: 'POST', headers: { 'X-Desk-Caller': 'launcher', 'Content-Type': 'application/json' }, body: '{}' })
  expect(res.status).toBe(200)
  expect(Date.now() - began).toBeLessThan(2_000)
})

test("an agent's restart is refused while the server runs the code on disk and accepted once that code changed, each ask logged", async () => {
  let stamp: CodeStamp = { newest: 900, count: 3 }
  const { desk, home, started } = await boot({ stamp: () => stamp })
  pidFile(home, 4242)
  const agentAsk = () => fetch(`${desk.url}/api/server/restart`, { method: 'POST', headers: { 'User-Agent': 'curl/8.4', 'X-Desk-Chat': 'chat-7' } })
  const refused = await agentAsk()
  expect(refused.status).toBe(409)
  expect((await refused.json()).error).toContain('nothing to restart onto')
  expect(started).toEqual([])

  stamp = { newest: 1500, count: 3 }
  expect((await agentAsk()).status).toBe(202)
  expect(started).toHaveLength(1)
  expect(started[0]!.at(-1)!).toContain(join('launcher', 'restart.ps1'))
  const log = readFileSync(join(home, 'logs', 'restart.log'), 'utf8')
  expect(log).toContain('restart asked: caller=other chat=chat-7 user-agent="curl/8.4" -> refused (nothing to update)')
  expect(log).toContain('restart asked: caller=other chat=chat-7 user-agent="curl/8.4" -> accepted')
})

test('one restart at a time: once one is accepted, the next ask is refused, the window\'s too', async () => {
  const { desk, home, started } = await boot({ stamp: () => ({ newest: 1500, count: 3 }) })
  pidFile(home, 4242)
  const ask = (headers: Record<string, string>) => fetch(`${desk.url}/api/server/restart`, { method: 'POST', headers })
  expect((await ask({ 'User-Agent': 'agent-a' })).status).toBe(202)
  const second = await ask({ 'User-Agent': 'agent-b' })
  expect(second.status).toBe(409)
  expect((await second.json()).error).toContain('already under way')
  expect((await ask({ 'X-Desk-Caller': 'window' })).status).toBe(409)
  expect(started).toHaveLength(1)
})

test('a restart whose start threw does not hold off the next ask', async () => {
  let fail = true
  const started: string[][] = []
  const { desk, home } = await boot({
    stamp: () => ({ newest: 1500, count: 3 }),
    start: (argv) => {
      if (fail) throw new Error('spawn failed')
      started.push(argv)
    },
  })
  pidFile(home, 4242)
  const ask = () => fetch(`${desk.url}/api/server/restart`, { method: 'POST', headers: { 'User-Agent': 'agent-a' } })
  expect((await ask()).status).toBe(500)
  fail = false
  expect((await ask()).status).toBe(202)
  expect(started).toHaveLength(1)
})

test('a restart whose start failed after the answer frees the route at once and logs why', async () => {
  const failures: ((err: Error) => void)[] = []
  const { desk, home } = await boot({ stamp: () => ({ newest: 1500, count: 3 }), start: (_argv, failed) => void failures.push(failed) })
  pidFile(home, 4242)
  const ask = () => fetch(`${desk.url}/api/server/restart`, { method: 'POST', headers: { 'User-Agent': 'agent-a' } })
  expect((await ask()).status).toBe(202)
  expect((await ask()).status).toBe(409)
  failures[0]!(new Error('spawn powershell ENOENT'))
  expect((await ask()).status).toBe(202)
  expect(readFileSync(join(home, 'logs', 'restart.log'), 'utf8')).toContain('-> did not start (spawn powershell ENOENT)')
})

test('an agent or script may not stop the server: shutdown answers 409 and stops nothing', async () => {
  const home = temp('desk-update-home-')
  const engine = temp('desk-update-engine-')
  writeFileSync(join(engine, '20-engine.ts'), `export { default } from ${JSON.stringify(pathToFileURL(ENGINE_PLUGIN).href)}\n`)
  let shutdowns = 0
  const desk = await createServer({ port: 0, home, pluginsDir: engine, deps: { shutdown: () => void shutdowns++ } })
  stops.push(() => desk.stop())
  const res = await fetch(`${desk.url}/api/server/shutdown`, { method: 'POST', headers: { 'User-Agent': 'curl/8.4', 'Content-Type': 'application/json' }, body: '{}' })
  expect(res.status).toBe(409)
  expect((await res.json()).error).toContain("Stopping this server is the owner's")
  await new Promise((r) => setTimeout(r, 100))
  expect(shutdowns).toBe(0)
})

// 2026-10-14: start.ps1 writes the pid file with its cmd wrapper's pid at once and bun's own only after the server
// answers and the tray is checked, so a server restart.ps1 had just started read restartable:false for a second or two.
test('a server whose pid file so far names only its parent, the cmd wrapper, is restartable', async () => {
  const { desk, home, started } = await boot({ stamp: () => ({ newest: 1500, count: 3 }) })
  const agentAsk = () => fetch(`${desk.url}/api/server/restart`, { method: 'POST', headers: { 'User-Agent': 'curl/8.4' } })
  pidFile(home, 0, 4999)
  expect((await (await fetch(`${desk.url}/api/server/update`)).json()).restartable).toBe(false)
  expect((await agentAsk()).status).toBe(409)
  pidFile(home, 0, 4100)
  expect(await (await fetch(`${desk.url}/api/server/update`)).json()).toEqual({ stale: true, restartable: true })
  expect((await agentAsk()).status).toBe(202)
  expect(started).toHaveLength(1)
})

test('not restartable off Windows: the launcher scripts are PowerShell', async () => {
  const { desk, home } = await boot({ platform: 'linux' })
  pidFile(home, 4242)
  expect((await fetch(`${desk.url}/api/server/restart`, { method: 'POST' })).status).toBe(409)
})

test('codeStamp counts .ts files and finds the newest; startedByLauncher reads a BOM pid file', () => {
  const dir = temp('desk-update-code-')
  mkdirSync(join(dir, 'a'))
  writeFileSync(join(dir, 'a', 'x.ts'), '')
  writeFileSync(join(dir, 'y.ts'), '')
  writeFileSync(join(dir, 'notes.md'), '')
  utimesSync(join(dir, 'a', 'x.ts'), 2000, 2000)
  utimesSync(join(dir, 'y.ts'), 1000, 1000)
  expect(codeStamp([dir, join(dir, 'missing')])).toEqual({ count: 2, newest: 2_000_000 })
  pidFile(dir, 77)
  expect(startedByLauncher(dir, 77, 0)).toBe(true)
  expect(startedByLauncher(dir, 78, 0)).toBe(false)
  expect(startedByLauncher(join(dir, 'missing'), 77, 0)).toBe(false)
})
