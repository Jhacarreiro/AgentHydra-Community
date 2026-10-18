import { describe, expect, test } from 'bun:test'
import {
  CPU_BUSY_LIMIT,
  CPU_MIN_WORKERS,
  CPU_WINDOW_MS,
  type CpuSample,
  cpuBusyOver,
  cpuShort,
  recordCpu,
  resetCpuRing,
} from '../src/climayte-cpu'

const STEP = 3_000

/** Samples every STEP ms: each [seconds, busyPct] segment runs that long at that busy share. */
function timeline(segments: [number, number][]): CpuSample[] {
  const out: CpuSample[] = [{ at: 0, idle: 0, total: 0 }]
  let at = 0
  let idle = 0
  let total = 0
  for (const [seconds, busy] of segments)
    for (let i = 0; i < (seconds * 1000) / STEP; i++) {
      at += STEP
      total += STEP
      idle += STEP * (1 - busy / 100)
      out.push({ at, idle, total })
    }
  return out
}

describe('cpuShort: a start waits only for a busy machine with workers running', () => {
  test('holds at or above the busy limit with enough workers running', () => {
    expect(cpuShort(CPU_BUSY_LIMIT, CPU_MIN_WORKERS)).toContain('busy')
    expect(cpuShort(91, 12)).toBe(
      '91% busy over the last 30 s with 12 workers running; it starts when the machine drops under 85%',
    )
    expect(cpuShort(CPU_BUSY_LIMIT - 0.4, 12)).toBeNull()
  })

  test('never holds with fewer than the minimum workers running, however busy', () => {
    expect(cpuShort(100, CPU_MIN_WORKERS - 1)).toBeNull()
    expect(cpuShort(100, 0)).toBeNull()
  })

  test('never holds when the CPU cannot be read', () => {
    expect(cpuShort(null, 50)).toBeNull()
  })
})

describe('cpuBusyOver: the average is over the window, not one sample', () => {
  test('a busy stretch as long as the window holds the average at its busy share', () => {
    const samples = timeline([
      [90, 10],
      [30, 100],
    ])
    const now = samples.at(-1)!.at
    expect(now).toBe(CPU_WINDOW_MS + 90_000)
    expect(cpuBusyOver(samples, now)).toBeCloseTo(100, 5)
  })

  test('busy time before the window does not count', () => {
    const samples = timeline([
      [90, 100],
      [30, 10],
    ])
    expect(cpuBusyOver(samples, samples.at(-1)!.at)).toBeCloseTo(10, 5)
  })

  test('one hot sample among quiet ones does not make the window busy', () => {
    const samples = timeline([
      [117, 10],
      [3, 100],
    ])
    // the last 30 s: 27 s at 10% and one 3 s sample at 100% = (27 * 10 + 3 * 100) / 30 = 19%
    expect(cpuBusyOver(samples, samples.at(-1)!.at)).toBeCloseTo(19, 5)
    expect(cpuShort(cpuBusyOver(samples, samples.at(-1)!.at), 12)).toBeNull()
  })

  test('a single reading leaves no window to judge', () => {
    expect(cpuBusyOver([{ at: 0, idle: 0, total: 0 }], 0)).toBeNull()
    expect(cpuBusyOver([], 0)).toBeNull()
  })
})

describe('recordCpu: a caller reading often does not shrink the window', () => {
  test('reads 100 ms apart for 5 busy seconds after 30 quiet ones still average over the 30 s', () => {
    // Every tickState records, the capacity reads a chat polls included (review of 62e44c74).
    resetCpuRing()
    try {
      recordCpu(0, { idle: 0, total: 0 })
      recordCpu(30_000, { idle: 30_000, total: 30_000 })
      let busy: number | null = null
      for (let k = 1; k <= 50; k++)
        busy = recordCpu(30_000 + k * 100, { idle: 30_000, total: 30_000 + k * 100 })
      // 5 s busy in the last 30: 1/7 busy, not the 100% of the burst alone
      expect(busy).toBeCloseTo((5_000 / 35_000) * 100, 5)
    } finally {
      resetCpuRing()
    }
  })
})
