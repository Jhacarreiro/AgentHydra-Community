// E6: what an idle daemon sends out. Every proxy-aware outbound call goes to a counting listener
// that refuses it (HTTPS_PROXY, HTTP_PROXY), and on Linux the daemon runs under strace, which
// records every connect, sendto, sendmsg and sendmmsg the daemon and its children make as they
// happen, so a client that ignores the proxy is seen too, however short its connection, and so is
// a UDP datagram or a DNS query (tracedAttempts). Without a working
// strace the daemon's open TCP sockets are sampled from /proc every 250 ms of the idle window
// instead, which misses a connection opened and closed between two samples and every datagram;
// E2E_REQUIRE_STRACE=1 (CI) makes that a failure.
//
// A fresh store downloads one thing at boot, by design: the model price list
// (server/src/price-catalog.ts, raw.githubusercontent.com, when its cache is missing or a day old).
// That is the only destination a boot may reach. After boot nothing may: no update check, no
// download, nothing a new change starts in the background. Only what starts within the idle window
// is seen: a timer that first fires later is not, the update loop's among them (its first tick is
// hours out, and the harness switches auto-update off at boot).
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { type Daemon, hitHost, scenario, waitFor } from './harness'

const lane = scenario('E6')
const home = lane.home()
const STRACE = process.platform === 'linux' ? Bun.which('strace') : null
const TRACE = join(home.dir, 'logs', 'strace.log')
// -v prints a sendmmsg vector whole; without it strace stops after 32 messages and a later
// message's address would not be in the log.
const flags = ['-f', '--seccomp-bpf', '--kill-on-exit', '-qq', '-ttt', '-v']
const calls = ['-e', 'trace=connect,sendto,sendmsg,sendmmsg']
/** What the daemon runs under when strace can trace here (tried once on `true`), else null:
 *  the daemon and every thread and child it starts, each call timestamped, into TRACE. */
const TRACER =
  STRACE && Bun.spawnSync([STRACE, ...flags, ...calls, '-o', '/dev/null', 'true']).exitCode === 0
    ? [STRACE, ...flags, ...calls, '-o', TRACE]
    : null
/** CI wants the trace: with E2E_REQUIRE_STRACE=1 and none, the boot test fails and the idle
 *  test does not run. */
const REFUSED = !TRACER && process.env.E2E_REQUIRE_STRACE === '1'
if (!TRACER && !REFUSED && process.platform === 'linux')
  console.warn(
    '\n  E6: no working strace, so the idle window samples open TCP sockets every 250 ms: a short' +
      ' direct connection and any UDP datagram can slip through unseen\n',
  )
/** How long the daemon is left alone once its boot work has settled. */
const IDLE_MS = 10_000
/** Boot-time downloads a fresh store makes on purpose, and where each comes from. */
const BOOT_DOWNLOADS: Record<string, string> = {
  'raw.githubusercontent.com': 'the model price list, server/src/price-catalog.ts',
}

let daemon: Daemon
let settledAt = 0

test('E6: a fresh boot reaches only its documented download', async () => {
  if (REFUSED) throw new Error('E2E_REQUIRE_STRACE=1, and strace is missing or cannot trace here')
  daemon = await lane.boot(home, TRACER ? { prefix: TRACER } : {})
  // Boot work is settled once no new outbound attempt has appeared for 3 s.
  let seen = -1
  let quietSince = Date.now()
  await waitFor(
    'boot to go quiet',
    () => {
      if (home.egress.hits.length !== seen) {
        seen = home.egress.hits.length
        quietSince = Date.now()
      }
      return Date.now() - quietSince >= 3_000
    },
    30_000,
    250,
  )
  settledAt = home.egress.hits.length
  const hosts = [...new Set(home.egress.hits.map(hitHost))].sort()
  expect(hosts.filter((h) => !(h in BOOT_DOWNLOADS))).toEqual([])
  if (TRACER) expect(tracedAttempts()).toEqual([])
  expect((await daemon.api('/api/update/settings')).body.enabled).toBe(false)
}, 60_000)

/** Every connect, sendto, sendmsg and sendmmsg in the strace log that names an IPv4 or IPv6
 *  address other than loopback, or port 53 on any address (a DNS query, which a resolver on
 *  loopback such as systemd-resolved's 127.0.0.53 sends on), as `address:port  <the strace line>`.
 *  A failed attempt counts: the call was made. A call that another thread's output splits in two is
 *  read on both halves: sendmmsg's addresses are printed only on its `<... sendmmsg resumed>` half.
 *  AF_UNIX and AF_NETLINK calls, and sends on a connected socket, name none, so a lookup over a Unix
 *  socket (nscd, systemd-resolved's varlink) is not seen itself; a connection to its answer is. */
function tracedAttempts(): string[] {
  const out: string[] = []
  for (const line of readFileSync(TRACE, 'utf8').split('\n')) {
    if (!/^(\d+ +)?\d+\.\d+ (<\.\.\. )?(connect|sendto|sendmsg|sendmmsg)( resumed>|\()/.test(line))
      continue
    for (const [, port, ip = ''] of line.matchAll(
      /sa_family=AF_INET6?, sin6?_port=htons\((\d+)\)[^}]*?"([^"]+)"/g,
    )) {
      if (port !== '53' && /^(127\.|::1$|::ffff:127\.)/.test(ip)) continue
      out.push(`${ip.includes(':') ? `[${ip}]` : ip}:${port}  ${line}`)
    }
  }
  return out
}

/** Linux without strace: the remote ends of the TCP sockets held by `pid` and its descendants that
 *  are open (or opening) to anything other than this machine, read from /proc. */
function outboundSockets(pid: number): string[] {
  const kids = new Map<number, number[]>()
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue
    try {
      const stat = readFileSync(`/proc/${p}/stat`, 'latin1')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      kids.set(ppid, [...(kids.get(ppid) ?? []), Number(p)])
    } catch {
      // gone
    }
  }
  const inodes = new Set<string>()
  for (const queue = [pid]; queue.length; ) {
    const p = queue.pop() as number
    queue.push(...(kids.get(p) ?? []))
    try {
      for (const fd of readdirSync(`/proc/${p}/fd`)) {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${p}/fd/${fd}`))
        if (m) inodes.add(m[1] as string)
      }
    } catch {
      // gone, or not ours
    }
  }
  const out: string[] = []
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let rows: string[] = []
    try {
      rows = readFileSync(table, 'latin1').trim().split('\n').slice(1)
    } catch {
      continue
    }
    for (const row of rows) {
      const f = row.trim().split(/\s+/)
      const [remote = '', state = '', inode = ''] = [f[2], f[3], f[9]]
      // 01 established, 02 syn-sent: a connection out, made or being made.
      if (!inodes.has(inode) || (state !== '01' && state !== '02')) continue
      const addr = remote.split(':')[0] ?? ''
      const v4 =
        addr.length === 8 ? addr : addr.startsWith('0000000000000000FFFF0000') ? addr.slice(24) : ''
      const loopback = v4 ? v4.endsWith('7F') : addr === '00000000000000000000000001000000'
      if (loopback) continue
      // The kernel writes an IPv4 address as one little-endian hex word, the port as hex.
      const port = Number.parseInt(remote.split(':')[1] ?? '', 16)
      const ip = v4 ? (v4.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)).reverse() : null
      out.push(ip ? `${ip.join('.')}:${port}` : `[${addr}]:${port}`)
    }
  }
  return out
}

test.skipIf(REFUSED)(
  `E6: left idle for ${IDLE_MS / 1000} s, the daemon makes no outbound attempt at all`,
  async () => {
    const direct = new Set<string>()
    const until = Date.now() + IDLE_MS
    while (Date.now() < until) {
      if (!TRACER && process.platform === 'linux')
        for (const s of outboundSockets(daemon.proc.pid)) direct.add(s)
      await Bun.sleep(250)
    }
    expect(home.egress.hits.slice(settledAt)).toEqual([])
    // The trace runs from the daemon's start, and the boot left none in it (above).
    expect(TRACER ? tracedAttempts() : [...direct]).toEqual([])
  },
  IDLE_MS + 30_000,
)

lane.realHomeUntouched()
