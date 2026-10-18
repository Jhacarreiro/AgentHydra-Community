// devservers/idle.ts: who is using a dev server. The idle pass counts each server's outside clients from `netstat`: a
// connection on one of its ports whose other end is not one of its own processes (a browser, another PC on the LAN).
// A server's own children (a preview and its workers) do not count, so a server nobody opens is still idle. netstat
// prints its states in the system's language, so output with no ESTABLISHED row at all is unknown (null), never idle.

import { execFile } from 'node:child_process'

export interface IdleServer {
  id: string
  ports: number[]
  treePids: Set<number>
}

/** Per server id, how many outside clients it has; null when the connections could not be read (every server counts as in use). */
export type ClientCounter = (servers: IdleServer[]) => Promise<Map<string, number> | null>

interface Row {
  local: string
  localPort: number
  remote: string
  remoteHost: string
  pid: number
}

/** `127.0.0.1:5173` or `[::1]:5173` split into its address and port. */
function split(endpoint: string): { host: string; port: number } {
  const i = endpoint.lastIndexOf(':')
  return { host: endpoint.slice(0, i).replace(/^\[|\]$/g, ''), port: Number(endpoint.slice(i + 1)) }
}

const loopback = (host: string): boolean => host.startsWith('127.') || host === '::1'

/** Counts the ESTABLISHED connections of `netstat -ano` output on each server's ports, from the server's side; null when it has none to read. */
export function countClients(netstatText: string, servers: IdleServer[]): Map<string, number> | null {
  const rows: Row[] = []
  for (const line of netstatText.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 5 || f[0] !== 'TCP' || f[3] !== 'ESTABLISHED') continue
    const local = split(f[1]!)
    const remote = split(f[2]!)
    const pid = Number(f[4])
    if (Number.isInteger(pid) && Number.isInteger(local.port)) rows.push({ local: f[1]!, localPort: local.port, remote: f[2]!, remoteHost: remote.host, pid })
  }
  if (!rows.length) return null
  const out = new Map<string, number>()
  for (const s of servers) {
    let n = 0
    for (const r of rows) {
      if (!s.ports.includes(r.localPort) || !s.treePids.has(r.pid)) continue
      // A loopback peer that is one of the server's own processes is the server talking to its child: not a client.
      if (loopback(r.remoteHost)) {
        const peer = rows.find((p) => p.local === r.remote)
        if (peer && s.treePids.has(peer.pid)) continue
      }
      n++
    }
    out.set(s.id, n)
  }
  return out
}

/** Windows only: one `netstat -ano` per call. Any failure, or another platform, answers null. */
export const netstatClients: ClientCounter = async (servers) => {
  if (process.platform !== 'win32') return null
  const text = await new Promise<string | null>((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? null : out))
  })
  return text === null ? null : countClients(text, servers)
}
