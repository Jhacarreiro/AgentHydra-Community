import { describe, expect, test } from 'bun:test'
import { SpawnLaunchError, spawnOff } from '../src/lib/spawn-off'

// Real processes that exist on every PC running Desk: this Bun binary, run with -e.
const bun = process.execPath
const decoder = new TextDecoder()

describe('spawnOff', () => {
  test('returns stdout and the exit code of the process', async () => {
    const out = await spawnOff({ cmd: [bun, '-e', "console.log('hello'); process.exit(3)"] })
    expect(out.code).toBe(3)
    expect(decoder.decode(out.stdout)).toBe('hello\n')
    expect(out.capped || out.timedOut || out.aborted).toBe(false)
  })

  test('sends stdin to the process', async () => {
    const out = await spawnOff({
      cmd: [bun, '-e', 'let s = ""; process.stdin.on("data", d => { s += d }); process.stdin.on("end", () => process.stdout.write(s))'],
      stdin: 'from stdin',
    })
    expect(out.code).toBe(0)
    expect(decoder.decode(out.stdout)).toBe('from stdin')
  })

  test('stdout past maxBytes kills the process and says capped', async () => {
    const out = await spawnOff({
      cmd: [bun, '-e', "setInterval(() => process.stdout.write('x'.repeat(65536)), 1)"],
      maxBytes: 1000,
      timeoutMs: 10_000,
    })
    expect(out.capped).toBe(true)
    expect(out.timedOut).toBe(false)
    expect(out.stdout.byteLength).toBe(1000)
  })

  test('a process still running at timeoutMs is killed and says timedOut', async () => {
    const out = await spawnOff({ cmd: [bun, '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 300 })
    expect(out.timedOut).toBe(true)
    expect(out.capped).toBe(false)
    expect(out.aborted).toBe(false)
  })

  test('an abort kills the process and says aborted', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const out = await spawnOff({ cmd: [bun, '-e', 'setInterval(() => {}, 1000)'] }, controller.signal)
    expect(out.aborted).toBe(true)
    expect(out.timedOut).toBe(false)
  })

  test('a program that does not exist rejects with a launch error', async () => {
    const err = await spawnOff({ cmd: ['no-such-program-for-spawn-off'] }).catch(e => e)
    expect(err).toBeInstanceOf(SpawnLaunchError)
    expect((err as Error).message).toContain('process could not start')
  })
})
