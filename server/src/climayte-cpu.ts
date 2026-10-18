// server/src/climayte-cpu.ts — a CliMayte worker starts only when the machine is not already busy
// with the workers running (owner, 2026-10-12: "whatever it is, it's killing my computer").
//
// Measured 2026-10-12 06:55Z on the owner's PC (32 threads, 63.2 GB): about 60 workers dispatched by
// one chat's script ran at once. System CPU sat at 90%, 4.4 GB of RAM was free, and 105 claude.exe
// processes held ~20 GB. The memory gate (climayte-memory.ts) was holding new starts at its 8% RAM
// floor, but nothing looked at CPU, so the machine stayed pegged and every process on it slowed.
//
// So a start waits while the machine's CPU, averaged over the last CPU_WINDOW_MS, is at or above
// CPU_BUSY_LIMIT AND at least CPU_MIN_WORKERS workers are already running on this PC. Below that
// count it never holds: CliMayte must always make progress and never starve behind the owner's own
// load. The average is over a window, not one sample, so a single spike does not hold work and a
// single quiet sample does not start it. Nothing running is stopped or slowed. A machine whose CPU
// cannot be read never holds work.
//
// Two kinds of worker never wait here: a chat (the owner's own) and a `light` worker, which only
// reads and edits files, with no shell and no MCP server but CliMayte's (climayte-launch.ts). On
// 2026-10-13 43 workers sat in this queue for about 50 minutes while a bare screenshot fleet (40
// headless Chromes) held the CPU, builders that would only have edited files among them.
//
// Each scheduler tick takes os.cpus() counters (cumulative idle and total ms per core, no subprocess)
// and keeps a small ring of them; the busy share is read from the counter deltas across the window.

import { cpus } from 'node:os'

/** The window the CPU is averaged over. */
export const CPU_WINDOW_MS = 30_000
/** Busy share at or above which a start waits (owner, 2026-10-12: 90% CPU with 60 workers). */
export const CPU_BUSY_LIMIT = 85
/** Fewer workers than this running on the PC never hold a start: the owner's own load alone does not
 *  stop CliMayte. */
export const CPU_MIN_WORKERS = 4
/** Samples kept, at least CPU_SAMPLE_GAP_MS apart: at least 100 s, enough to span the window. */
const CPU_RING_MAX = 40
/** A reading this soon after the last kept one is not kept. Every tickState records (the scheduler's
 *  tick and the capacity reads alike), so without a gap a fast poller would fill the ring in seconds
 *  and shrink the window to them. */
const CPU_SAMPLE_GAP_MS = 2_500

/** Cumulative CPU time across every core, in ms, as os.cpus() reports it. */
export interface CpuCounters {
  idle: number
  total: number
}

/** One CPU reading at `at` (ms). The counters only grow, so a window's busy share is the deltas. */
export interface CpuSample extends CpuCounters {
  at: number
}

/** The machine's cumulative CPU counters now, or null where os.cpus() gives nothing. */
export function readCpuCounters(): CpuCounters | null {
  try {
    const list = cpus()
    if (!list.length) return null
    let idle = 0
    let total = 0
    for (const c of list) {
      const t = c.times
      idle += t.idle
      total += t.user + t.nice + t.sys + t.irq + t.idle
    }
    return total > 0 ? { idle, total } : null
  } catch {
    // unreadable: no gate rather than a held queue
    return null
  }
}

/** The busy share (0-100) over the window ending at `now`, from the samples in time order: the
 *  deltas between the newest sample and the last one at or before the window's start (the oldest
 *  sample while the window is not yet full). null with fewer than two samples or no time between. */
export function cpuBusyOver(
  samples: CpuSample[],
  now: number,
  windowMs: number = CPU_WINDOW_MS,
): number | null {
  const last = samples.at(-1)
  if (!last || samples.length < 2) return null
  let base = samples[0]!
  for (const s of samples) if (s.at <= now - windowMs) base = s
  if (base === last) return null
  const total = last.total - base.total
  if (total <= 0) return null
  const busy = total - (last.idle - base.idle)
  return Math.min(100, Math.max(0, (busy / total) * 100))
}

const ring: CpuSample[] = []

/** Record this tick's reading (null: unreadable, which leaves the ring as it is) and return the
 *  busy share over the window, or null when there is not yet a window to judge. */
export function recordCpu(now: number, counters: CpuCounters | null): number | null {
  const kept = ring.at(-1)
  if (counters && (!kept || now - kept.at >= CPU_SAMPLE_GAP_MS)) {
    ring.push({ at: now, idle: counters.idle, total: counters.total })
    if (ring.length > CPU_RING_MAX) ring.splice(0, ring.length - CPU_RING_MAX)
  }
  return cpuBusyOver(ring, now)
}

/** Tests: forget the recorded samples. */
export function resetCpuRing(): void {
  ring.length = 0
}

/** Why another worker may not start now, or null when it may. `busyPct`: the busy share over the
 *  window (null when unread: never holds), `running`: workers running on this PC now. */
export function cpuShort(busyPct: number | null, running: number): string | null {
  if (busyPct === null || running < CPU_MIN_WORKERS || busyPct < CPU_BUSY_LIMIT) return null
  return `${Math.round(busyPct)}% busy over the last ${CPU_WINDOW_MS / 1000} s with ${running} workers running; it starts when the machine drops under ${CPU_BUSY_LIMIT}%`
}
