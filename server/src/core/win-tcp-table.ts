// server/src/core/win-tcp-table.ts - the Windows IPv4 TCP connection table, read in-process.
//
// ⛔ WHY (2026-10-11). "Who is calling?" (pidOwningLocalPort in process.ts) ran `netstat -ano` on the
// spawn worker for every MCP request that needed its caller. CliMayte's manager endpoint needs it on
// EVERY request, `initialize` included, and from 06:10 to 08:00 UTC that netstat sat in the spawn
// queue behind hand-offs, git and taskkills: wave managers' CLIs gave up connecting with
// CONNECT_TIMEOUT at 30 s (wave wv-d63d84, 07:25), and a lookup bounded in time instead answers null,
// which the endpoint refuses just the same. iphlpapi's GetExtendedTcpTable answers the same question
// in-process in a few milliseconds: no child, no queue, and a table read at the moment it is asked.
//
// Null is "could not look" (not Windows, no bun:ffi, a call refused), never "no connections".

import { createRequire } from 'node:module'

/** One IPv4 TCP connection: its local port, its MIB_TCP_STATE and the pid that owns it. */
export interface TcpRow {
  localPort: number
  state: number
  pid: number
}

/** MIB_TCP_STATE_ESTAB: a live connection, as opposed to a listener or one closing down. */
export const TCP_STATE_ESTABLISHED = 5

const AF_INET = 2
const TCP_TABLE_OWNER_PID_ALL = 5
const NO_ERROR = 0
const ERROR_INSUFFICIENT_BUFFER = 122
// MIB_TCPTABLE_OWNER_PID: dwNumEntries, then MIB_TCPROW_OWNER_PID rows of six DWORDs: state, local
// address, local port, remote address, remote port, owning pid. A port is in network byte order in
// the low 16 bits of its DWORD.
const ROW_BYTES = 24
/** Connections opened between asking the size and reading the table: room for this many more. */
const SLACK_ROWS = 256

type TableCall = (buf: Uint8Array | null, size: Uint32Array) => number
let tableCall: TableCall | null | undefined

function load(): TableCall | null {
  if (tableCall !== undefined) return tableCall
  tableCall = null
  if (process.platform !== 'win32') return null
  try {
    const { dlopen, FFIType, ptr } = createRequire(import.meta.url)('bun:ffi')
    const ip = dlopen('iphlpapi.dll', {
      GetExtendedTcpTable: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.u32, FFIType.u32],
        returns: FFIType.u32,
      },
    }).symbols
    tableCall = (buf, size) =>
      ip.GetExtendedTcpTable(
        buf ? ptr(buf) : null,
        ptr(size),
        0,
        AF_INET,
        TCP_TABLE_OWNER_PID_ALL,
        0,
      )
  } catch {
    tableCall = null
  }
  return tableCall
}

const swapPort = (raw: number): number => ((raw & 0xff) << 8) | ((raw >> 8) & 0xff)

/** Every IPv4 TCP connection on this machine with its owning pid, or null when it cannot be read. */
export function windowsTcpTable(): TcpRow[] | null {
  const call = load()
  if (!call) return null
  try {
    const size = new Uint32Array(1)
    if (call(null, size) !== ERROR_INSUFFICIENT_BUFFER) return null
    // The table can grow between the two calls: a short buffer is asked again at the new size.
    for (let tries = 0; tries < 4; tries++) {
      const buf = new Uint8Array(size[0]! + SLACK_ROWS * ROW_BYTES)
      size[0] = buf.byteLength
      const rc = call(buf, size)
      if (rc === ERROR_INSUFFICIENT_BUFFER) continue
      if (rc !== NO_ERROR) return null
      const view = new DataView(buf.buffer)
      const n = view.getUint32(0, true)
      if (4 + n * ROW_BYTES > buf.byteLength) return null
      const rows: TcpRow[] = new Array(n)
      for (let i = 0; i < n; i++) {
        const at = 4 + i * ROW_BYTES
        rows[i] = {
          state: view.getUint32(at, true),
          localPort: swapPort(view.getUint32(at + 8, true)),
          pid: view.getUint32(at + 20, true),
        }
      }
      return rows
    }
  } catch {
    // a refused call: could not look
  }
  return null
}
