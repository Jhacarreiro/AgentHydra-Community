// The chat host process (SPEC "Chat hosts"): `bun chat-host.ts --spec <file>`. The server starts it through
// launch.ts, outside its own process tree, so a server restart (or launcher/stop.ps1's tree kill) leaves it and
// the chat's Claude Code under it running. It serves one websocket on 127.0.0.1 (serve.ts) and writes
// <dir>/<chatId>.json to say where. It imports nothing of the server's but its own folder: a host keeps running
// the code it started with, so the less it holds, the less a server update has to stay compatible with.

import { appendFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { HostCore, type HostQueryImpl } from './core'
import { hostFilePath, writeHostFile } from './launch'
import { HOST_PROTOCOL, type HostFile, type HostSpec } from './protocol'
import { loadSdk } from './sdk'
import { serveHost } from './serve'

const at = process.argv.indexOf('--spec')
const specPath = at > 0 ? process.argv[at + 1] : undefined
if (!specPath) {
  console.error('usage: bun chat-host.ts --spec <file>')
  process.exit(2)
}

let spec: HostSpec
try {
  spec = JSON.parse(readFileSync(specPath, 'utf8')) as HostSpec
} finally {
  // The spec holds the chat's environment: off the disk the moment it is read, read or not.
  rmSync(specPath, { force: true })
}
if (spec.protocol !== HOST_PROTOCOL) process.exit(2)

const hostFile = hostFilePath(spec.dir, spec.chatId)
const logFile = join(spec.dir, `${spec.chatId}.host.log`)

function log(line: string): void {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${line}\n`)
  } catch {
    // the log is best effort
  }
}

// The SDK before anything else: a release fetches it the first time (sdk-package.ts), and the server has done that
// before it starts a host, so a failure here is one this host cannot get past; the log says why.
let sdkQuery: HostQueryImpl
try {
  sdkQuery = (await loadSdk()).query as HostQueryImpl
} catch (err) {
  log(`the Claude Agent SDK did not load: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const core = new HostCore({
  spec,
  queryImpl: sdkQuery,
  log,
  exit: (code) => {
    log(`exit ${code}`)
    try {
      // Only our own file: a newer host of the same chat may already have written its own.
      const file = JSON.parse(readFileSync(hostFile, 'utf8')) as HostFile
      if (file.pid === process.pid) rmSync(hostFile, { force: true })
    } catch {
      // gone already
    }
    server.stop(true)
    process.exit(code)
  },
})

const server = serveHost(core, spec.token)

const file: HostFile = { protocol: HOST_PROTOCOL, chatId: spec.chatId, pid: process.pid, port: server.port as number, token: spec.token, startedAt: core.startedAt }
writeHostFile(spec.dir, file)
log(`started on port ${file.port} for chat ${spec.chatId}`)

process.on('uncaughtException', (err) => log(`uncaught: ${err?.stack ?? err}`))
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${(err as Error)?.stack ?? err}`))

core.start()
