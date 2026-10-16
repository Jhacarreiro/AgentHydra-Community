import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectCodexRpc } from '../src/core/codex-rpc'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'codex-rpc-'))
  roots.push(home)
  const script = join(home, 'server.ts')
  writeFileSync(
    script,
    `
    import {createInterface} from 'node:readline'
    const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
    let initialized = false
    createInterface({input: process.stdin}).on('line', (line) => {
      const message = JSON.parse(line)
      if (message.method === 'initialized') { initialized = true; return }
      if (message.method === 'initialize') { send({id:message.id,result:{}}); return }
      if (message.method === 'hang') return
      if (message.method === 'exit') { process.stderr.write('session text\\n'); process.exit(0); return }
      if (message.method === 'fail') { send({id:message.id,error:{code:1,message:'Request rejected'}}); return }
      send({method:'notification',params:{}})
      send({id:message.id,result:{initialized,home:process.env.CODEX_HOME}})
    })
  `,
  )
  return { home, command: [process.execPath, script] }
}

test('Codex RPC handshakes and scopes the child to the selected home', async () => {
  const f = fixture()
  const rpc = await connectCodexRpc(f.home, { command: f.command })
  try {
    expect(await rpc.call<{ initialized: boolean; home: string }>('read')).toEqual({
      initialized: true,
      home: f.home,
    })
    const error = await rpc.call('fail').then(
      () => '',
      (error: Error) => error.message,
    )
    expect(error).toBe('Request rejected')
  } finally {
    await rpc.close()
  }
  // A child bun's start, then its handshake: 1.4-5.1 s in four suite runs on a box at ~90% CPU (2026-10-11).
}, 20_000)

test('Codex RPC rejects pending work when the child exits', async () => {
  const f = fixture()
  const rpc = await connectCodexRpc(f.home, { command: f.command })
  try {
    const error = await rpc.call('exit').then(
      () => '',
      (error: Error) => error.message,
    )
    expect(error).toContain('exited')
    // Once it has started, what app-server writes to stderr can be a chat's, and never reaches the error.
    expect(error).not.toContain('session text')
  } finally {
    await rpc.close()
  }
}, 20_000) // a child bun's start: 0.6-4.2 s in four suite runs on a box at ~90% CPU (2026-10-11)

test('a Codex app-server that exits before it starts says why', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-rpc-'))
  roots.push(home)
  const script = join(home, 'broken.ts')
  writeFileSync(
    script,
    "for (let i = 1; i <= 7; i++) console.error('line ' + i)\nprocess.exit(3)\n",
  )
  const error = await connectCodexRpc(home, { command: [process.execPath, script] }).then(
    () => '',
    (error: Error) => error.message,
  )
  expect(error).toBe(
    'Codex app-server exited before it started (exit code 3): line 3 / line 4 / line 5 / line 6 / line 7',
  )
}, 20_000)

// A process app-server starts (a tool, an MCP server) can inherit its stdout or stderr and outlive it. These stand-ins
// start one that sleeps `holdMs` holding one of the two, and write its pid where the test can stop it. Measured on
// Linux only, so the Windows leg skips them.
const posixOnly = test.skipIf(process.platform === 'win32')
function holdingFixture(pipe: 'stdout' | 'stderr', holdMs: number, body: string) {
  const home = mkdtempSync(join(tmpdir(), 'codex-rpc-'))
  roots.push(home)
  const script = join(home, 'server.ts')
  const pidFile = join(home, 'holder.pid')
  const stdio =
    pipe === 'stdout' ? ['ignore', 'inherit', 'ignore'] : ['ignore', 'ignore', 'inherit']
  writeFileSync(
    script,
    `
    import {spawn} from 'node:child_process'
    import {writeFileSync} from 'node:fs'
    import {createInterface} from 'node:readline'
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${holdMs})'], {stdio: ${JSON.stringify(stdio)}})
    writeFileSync(${JSON.stringify(pidFile)}, String(holder.pid))
    holder.unref()
    ${body}
  `,
  )
  const stopHolder = () => {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')))
    } catch {
      // Gone already, or never started.
    }
  }
  return { home, command: [process.execPath, script], stopHolder }
}
const ANSWERS_INITIALIZE = `createInterface({input: process.stdin}).on('line', (line) => {
      const message = JSON.parse(line)
      if (message.id !== undefined) process.stdout.write(JSON.stringify({id: message.id, result: {}}) + '\\n')
    })`

posixOnly(
  'a process app-server started that holds its stderr does not hold close()',
  async () => {
    const f = holdingFixture('stderr', 30_000, ANSWERS_INITIALIZE)
    try {
      const rpc = await connectCodexRpc(f.home, { command: f.command })
      const started = performance.now()
      await rpc.close()
      // The holder sleeps 30 s; close() waits for app-server only.
      expect(performance.now() - started).toBeLessThan(10_000)
    } finally {
      f.stopHolder()
    }
  },
  30_000,
)

posixOnly(
  'a start that fails says why at once, though a process it started holds stderr',
  async () => {
    const f = holdingFixture('stderr', 30_000, "console.error('bad config'); process.exit(2)")
    try {
      const started = performance.now()
      const error = await connectCodexRpc(f.home, { command: f.command }).then(
        () => '',
        (error: Error) => error.message,
      )
      expect(error).toBe('Codex app-server exited before it started (exit code 2): bad config')
      // A child bun's start is most of it (see above); the holder sleeps 30 s.
      expect(performance.now() - started).toBeLessThan(15_000)
    } finally {
      f.stopHolder()
    }
  },
  30_000,
)

// readline pauses stdout as it closes, and on Bun 1.4.3 a paused pipe of a process that has exited never reports its
// end when that comes later: close() waited forever, the CPU spinning, while a process app-server started held stdout.
posixOnly(
  'a start that fails returns once a process holding stdout has gone',
  async () => {
    const f = holdingFixture('stdout', 3_000, "console.error('bad config'); process.exit(2)")
    try {
      const error = await connectCodexRpc(f.home, { command: f.command }).then(
        () => '',
        (error: Error) => error.message,
      )
      expect(error).toBe('Codex app-server exited before it started (exit code 2): bad config')
    } finally {
      f.stopHolder()
    }
  },
  30_000,
)

// The per-call timeout also bounds the initialize handshake, which waits on the child bun starting:
// about 0.3 s here (2026-10-04), but 0.3-4.4 s on a box at ~90% CPU (2026-10-11), where 2 s failed in
// connect, before the hang this test is about was ever sent. The hang then takes this long to time out.
const RPC_TIMEOUT_MS = 8_000

test('Codex RPC times out and closes the connection', async () => {
  const f = fixture()
  const rpc = await connectCodexRpc(f.home, { command: f.command, timeoutMs: RPC_TIMEOUT_MS })
  try {
    const error = await rpc.call('hang').then(
      () => '',
      (error: Error) => error.message,
    )
    expect(error).toContain('timed out')
    const closedError = await rpc.call('read').then(
      () => '',
      (error: Error) => error.message,
    )
    expect(closedError).toContain('closed')
  } finally {
    await rpc.close()
  }
}, 40_000) // the child's start, then RPC_TIMEOUT_MS for the hang, then the kill

// A Codex refresh token rotates: two app-servers refreshing one home can sign the account out. The
// daemon's own connections to a home take turns; other homes never wait.
test('connections to one Codex home take turns, other homes do not wait', async () => {
  const a = fixture()
  const b = fixture()
  const first = await connectCodexRpc(a.home, { command: a.command })
  let secondOpen = false
  const second = connectCodexRpc(a.home, { command: a.command }).then((rpc) => {
    secondOpen = true
    return rpc
  })
  const other = await connectCodexRpc(b.home, { command: b.command })
  await Bun.sleep(300)
  expect(secondOpen).toBe(false)
  await first.close()
  const rpc = await second
  expect(secondOpen).toBe(true)
  await rpc.close()
  await other.close()
}, 20_000)
