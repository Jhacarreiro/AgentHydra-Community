// server/tests/port-owner.test.ts — reading the OS connection table (server/src/core/process.ts).
//
// This is how the daemon answers "who just called me?" for MCP over HTTP: the caller's peer port,
// looked up in the connection table, names the process that opened the socket - which is the
// Claude Code engine, under its own instance directory. The rule that picks the caller's row is
// pinned against rows shaped like a real table (Windows 11, 2026-09-11), and the table itself is read
// for real on Windows.

import { describe, expect, spyOn, test } from 'bun:test'
import { pidOwningLocalPort, tcpOwnerPid } from '../src/core/process'
import { TCP_STATE_ESTABLISHED, type TcpRow } from '../src/core/win-tcp-table'

const LISTEN = 2
const TIME_WAIT = 11
const TABLE: TcpRow[] = [
  { localPort: 135, state: LISTEN, pid: 1104 },
  { localPort: 7787, state: LISTEN, pid: 23152 },
  { localPort: 54321, state: TCP_STATE_ESTABLISHED, pid: 66800 }, // the caller's end
  { localPort: 7787, state: TCP_STATE_ESTABLISHED, pid: 23152 }, // the daemon's end of it
  { localPort: 54399, state: TIME_WAIT, pid: 0 },
]

describe('tcpOwnerPid', () => {
  test('names the process that opened the connection, not the one that accepted it', () => {
    // 54321 is the CALLER's own local port; 7787 is ours. The row we want is the caller's.
    expect(tcpOwnerPid(TABLE, 54321)).toBe(66800)
  })

  test('a port with no established row is null, never a guess', () => {
    expect(tcpOwnerPid(TABLE, 54399)).toBeNull() // TIME_WAIT: not a live caller
    expect(tcpOwnerPid(TABLE, 9999)).toBeNull()
    expect(tcpOwnerPid([], 54321)).toBeNull()
  })

  test('a LISTENING socket on the same port number is not an answer', () => {
    // 7787 appears as our own listener AND as the far end of the caller's row. Neither makes
    // the daemon the caller, and answering 23152 here would identify every agent as the tray.
    expect(tcpOwnerPid(TABLE, 7787)).toBe(23152)
    expect(tcpOwnerPid([{ localPort: 7787, state: LISTEN, pid: 23152 }], 7787)).toBeNull()
  })

  test('two processes claiming one local port answers null rather than picking one', () => {
    const ambiguous: TcpRow[] = [
      { localPort: 54321, state: TCP_STATE_ESTABLISHED, pid: 66800 },
      { localPort: 54321, state: TCP_STATE_ESTABLISHED, pid: 4242 },
    ]
    expect(tcpOwnerPid(ambiguous, 54321)).toBeNull()
  })
})

// 2026-10-11: the lookup was a `netstat` on the spawn worker, queued behind every other capture, and
// CliMayte's manager endpoint (which asks on every request, `initialize` included) left wave managers'
// CLIs at CONNECT_TIMEOUT 30 s. The table is now read in-process: no process is started for it.
describe.skipIf(process.platform !== 'win32')('pidOwningLocalPort', () => {
  test('a loopback caller is named from the live table, with no process started to ask', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const client = await Bun.connect({
      hostname: '127.0.0.1',
      port: server.port,
      socket: { data() {} },
    })
    const spawn = spyOn(Bun, 'spawn').mockImplementation((() => {
      throw new Error('no process may be started to name a caller')
    }) as unknown as typeof Bun.spawn)
    try {
      expect(await pidOwningLocalPort(client.localPort)).toBe(process.pid)
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      spawn.mockRestore()
      client.end()
      server.stop(true)
    }
  })
})
