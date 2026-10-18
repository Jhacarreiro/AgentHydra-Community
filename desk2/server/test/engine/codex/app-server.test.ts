// The shared Codex app-server ends as soon as its last chat lets go (its exit frees a thread at once, where
// thread/unsubscribe frees it about a minute later), and a new one on the same home waits for the old one to be gone. A stand-in app-server, started the way
// CODEX_PATH starts a shim, logs when it starts, when its input closes and when it exits.

import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openAppServer } from '../../../src/engine/codex/app-server'

const dir = mkdtempSync(join(tmpdir(), 'desk-codex-app-'))
const before = process.env.CODEX_PATH
afterAll(async () => {
  if (before === undefined) delete process.env.CODEX_PATH
  else process.env.CODEX_PATH = before
  if (!dir) return
  // The stand-in logs 'exit' just before it exits, and on Windows it and the shim's shell hold the folder until they
  // are gone: EBUSY failed the suite on 2026-10-14. Bun's rmSync takes no maxRetries, so it is tried again here.
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EBUSY' || i >= 30) throw err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
})

// Answers every request; once its input closes it takes a moment (writing its threads) before it exits.
const FAKE = `import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const log = 'log.txt'
const n = (existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter((l) => l.startsWith('start')).length : 0) + 1
appendFileSync(log, 'start ' + n + '\\n')
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.id !== undefined && msg.method) process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n')
})
lines.on('close', () => {
  appendFileSync(log, 'eof ' + n + '\\n')
  setTimeout(() => {
    appendFileSync(log, 'exit ' + n + '\\n')
    process.exit(0)
  }, 300)
})
`

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

test("the last release ends the app-server at once, and the next one waits for it to be gone", async () => {
  const home = join(dir, 'home')
  const log = join(home, 'log.txt')
  const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
  mkdirSync(home, { recursive: true })
  const fake = join(dir, 'fake.ts')
  writeFileSync(fake, FAKE)
  // An npm-style shim on Windows (a shell starts it, so a kill would reach only the shell), a script elsewhere.
  const shim = join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  if (process.platform === 'win32') writeFileSync(shim, `@"${process.execPath}" "${fake}" %*\r\n`)
  else {
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
    chmodSync(shim, 0o755)
  }
  process.env.CODEX_PATH = shim

  const first = await openAppServer(home)
  await first.call('thread/read', { threadId: 't-1' })
  first.release()
  // A message sent straight after: a new app-server, started only once the old one has exited.
  const second = await openAppServer(home)
  await second.call('thread/read', { threadId: 't-1' })
  expect(lines()).toEqual(['start 1', 'eof 1', 'exit 1', 'start 2'])
  second.release()
  await waitFor(() => lines().includes('exit 2'))
  expect(lines()).toEqual(['start 1', 'eof 1', 'exit 1', 'start 2', 'eof 2', 'exit 2'])
}, 20_000)
