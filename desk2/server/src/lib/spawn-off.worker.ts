// The worker half of spawn-off.ts: starts each process and reads its output on this thread, so the server's
// main thread never waits on process creation. It knows nothing else about the server. Messages in and out
// are the WorkerRequest and WorkerReply types exported from spawn-off.ts.

import type { SpawnOffOptions, SpawnStop, WorkerReply, WorkerRequest } from './spawn-off'

type Subprocess = ReturnType<typeof Bun.spawn>

/** Stops a running process by call id, so an abort message can reach it. */
const stops = new Map<number, (why: SpawnStop) => void>()

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'abort') stops.get(msg.id)?.('aborted')
  else void run(msg.id, msg.opts)
}

function post(msg: WorkerReply, transfer: ArrayBuffer[] = []): void {
  self.postMessage(msg, transfer)
}

async function run(id: number, opts: SpawnOffOptions): Promise<void> {
  let proc: Subprocess
  try {
    proc = Bun.spawn(opts.cmd, {
      cwd: opts.cwd,
      env: definedEnv(opts.env),
      stdin: opts.stdin === undefined ? 'ignore' : new Blob([typeof opts.stdin === 'string' ? opts.stdin : new Uint8Array(opts.stdin)]),
      stdout: 'pipe',
      stderr: opts.stderr === 'ignore' ? 'ignore' : 'pipe',
      windowsHide: true,
    })
  } catch (err) {
    post({ type: 'launch', id, detail: (err as Error).message })
    return
  }
  const state: { stopped?: SpawnStop } = {}
  const stop = (why: SpawnStop) => {
    if (state.stopped) return
    state.stopped = why
    kill(proc, opts.killTree === true)
  }
  stops.set(id, stop)
  const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => stop('timedOut'), opts.timeoutMs)
  try {
    const [out, stderr, code] = await Promise.all([
      readStdout(proc.stdout as ReadableStream<Uint8Array>, opts.maxBytes ?? Number.POSITIVE_INFINITY, () => stop('capped')),
      opts.stderr === 'ignore' ? Promise.resolve('') : new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ])
    post(
      {
        type: 'result',
        id,
        result: {
          code,
          stdout: out.bytes,
          stderr: stderr.trim(),
          capped: out.capped,
          timedOut: state.stopped === 'timedOut',
          aborted: state.stopped === 'aborted',
        },
      },
      [out.bytes.buffer],
    )
  } catch (err) {
    post({ type: 'failed', id, detail: (err as Error).message })
  } finally {
    clearTimeout(timer)
    stops.delete(id)
  }
}

/** Windows kill-tree goes through taskkill, which must run before the root dies or its children are lost. */
function kill(proc: Subprocess, tree: boolean): void {
  if (tree && process.platform === 'win32') {
    try {
      Bun.spawn(['taskkill', '/pid', String(proc.pid), '/t', '/f'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true })
      return
    } catch {
      // taskkill itself could not start: fall back to killing the root process alone.
    }
  }
  proc.kill()
}

/** Reads stdout into one fresh buffer; past `max` bytes it keeps draining the stream and calls onCap once. */
async function readStdout(stream: ReadableStream<Uint8Array>, max: number, onCap: () => void): Promise<{ bytes: Uint8Array<ArrayBuffer>; capped: boolean }> {
  const chunks: Uint8Array[] = []
  let size = 0
  let capped = false
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (capped) continue
    if (size + value.length > max) {
      chunks.push(value.subarray(0, max - size))
      size = max
      capped = true
      onCap()
      continue
    }
    chunks.push(value)
    size += value.length
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return { bytes, capped }
}

function definedEnv(env?: Record<string, string | undefined>): Record<string, string> | undefined {
  if (!env) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  return out
}
