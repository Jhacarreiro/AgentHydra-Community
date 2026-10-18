// Runs child processes on one worker thread, so the server's event loop keeps serving while they start.
// Why: on Windows, process creation (Bun.spawn, node spawn) runs synchronously on the calling thread and takes
// seconds when the PC is busy. Desk's loop-stalls log (~/.hydra-desk-2/logs/loop-stalls.jsonl) showed, over 3 hours,
// 43 stalls that blocked the loop 138 s in total, up to 7.5 s each, 82% of the sampled stall time inside spawn.
// While the loop is blocked Desk serves nothing, so AgentHydra's pane (/ah/) loaded slowly (owner, 2026-10-10:
// "I clicked the Hydra tab to load Agent Hydra, and it took like a decade to load").
// Every call goes to spawn-off.worker.ts. There is no fallback to spawning here: a failing worker rejects the calls
// it held and the next call starts a new one, so the failure stays loud.

export interface SpawnOffOptions {
  cmd: string[]
  cwd?: string
  /** Defaults to a copy of this process's environment. */
  env?: Record<string, string | undefined>
  stdin?: string | Uint8Array
  /** stdout past this many bytes kills the process and the result says `capped`. Default: no cap. */
  maxBytes?: number
  /** Past this many milliseconds the process is killed and the result says `timedOut`. */
  timeoutMs?: number
  /** Default 'pipe'. 'ignore' leaves stderr empty. */
  stderr?: 'pipe' | 'ignore'
  /** Windows: stop the whole tree with `taskkill /pid <pid> /t /f`, as free-instances/runtime.ts terminate does. */
  killTree?: boolean
}

export interface SpawnOffResult {
  /** The exit code, or -1 when the signal was aborted before the process started. */
  code: number
  stdout: Uint8Array
  stderr: string
  capped: boolean
  timedOut: boolean
  aborted: boolean
}

/** The process could not be started (a missing program, a bad cwd). */
export class SpawnLaunchError extends Error {
  constructor(readonly detail: string) {
    super(`process could not start: ${detail}`)
  }
}

export type SpawnStop = 'capped' | 'timedOut' | 'aborted'

/** Main -> worker. */
export type WorkerRequest =
  | { type: 'spawn'; id: number; opts: SpawnOffOptions }
  | { type: 'abort'; id: number }

/** Worker -> main. `launch` and `failed` carry the error text; `result` is the answer. */
export type WorkerReply =
  | { type: 'result'; id: number; result: SpawnOffResult }
  | { type: 'launch'; id: number; detail: string }
  | { type: 'failed'; id: number; detail: string }

interface Pending {
  resolve: (result: SpawnOffResult) => void
  reject: (err: Error) => void
  detach: () => void
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function startWorker(): Worker {
  const started = new Worker(new URL('./spawn-off.worker.ts', import.meta.url))
  started.onmessage = (e: MessageEvent<WorkerReply>) => onReply(e.data)
  started.onerror = (e: unknown) => failAll(`spawn worker failed: ${String((e as { message?: unknown }).message ?? 'error')}`)
  started.onmessageerror = () => failAll('spawn worker sent a message it could not read')
  return started
}

/** Rejects every call the worker still holds and drops it: the next call starts a fresh one. */
function failAll(reason: string): void {
  const dead = worker
  worker = null
  dead?.terminate()
  for (const [id, call] of pending) {
    pending.delete(id)
    call.detach()
    call.reject(new Error(reason))
  }
}

function onReply(msg: WorkerReply): void {
  const call = pending.get(msg.id)
  if (!call) return
  pending.delete(msg.id)
  call.detach()
  if (msg.type === 'result') call.resolve(msg.result)
  else if (msg.type === 'launch') call.reject(new SpawnLaunchError(msg.detail))
  else call.reject(new Error(`spawn failed: ${msg.detail}`))
}

/**
 * Runs `cmd` on the spawn worker and resolves with its exit code, stdout bytes and stderr text. Launch failure
 * rejects with SpawnLaunchError; a dead worker rejects with an Error. The abort signal kills the process and
 * resolves with `aborted: true`.
 */
export function spawnOff(opts: SpawnOffOptions, signal?: AbortSignal): Promise<SpawnOffResult> {
  if (signal?.aborted) {
    return Promise.resolve({ code: -1, stdout: new Uint8Array(0), stderr: '', capped: false, timedOut: false, aborted: true })
  }
  return new Promise((resolve, reject) => {
    const id = nextId++
    const onAbort = () => worker?.postMessage({ type: 'abort', id } satisfies WorkerRequest)
    const detach = () => signal?.removeEventListener('abort', onAbort)
    try {
      worker ??= startWorker()
    } catch (err) {
      reject(new Error(`spawn worker could not start: ${(err as Error).message}`))
      return
    }
    pending.set(id, { resolve, reject, detach })
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.postMessage({
      type: 'spawn',
      id,
      opts: { ...opts, env: opts.env ?? { ...process.env } },
    } satisfies WorkerRequest)
  })
}
