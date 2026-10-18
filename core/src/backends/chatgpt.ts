// The core's ChatGPT backend. A turn is one Free job on Desk 2 (desk2/server/src/engine/chatgpt/runtime.ts): Desk owns the
// Free browser runtime and its one-operation-per-account lock, so the core only talks to Desk's Free HTTP API.
import { randomUUID } from 'node:crypto'
import {
  type FreeJob,
  type FreeRequest,
  type FreeResult,
  isFreeChatgptModel,
} from '../../../desk2/shared/free-instances'
import type { Account, Backend, Task, Turn, TurnEnd, TurnSink } from '../types'

const DESK_URL = process.env.DESK_URL ?? 'http://127.0.0.1:7798'
/** The longest message Free instances take (runtime.ts PROMPT_MAX). */
const PROMPT_MAX = 100_000
const TOO_LONG = 'ChatGPT takes messages of up to 100,000 characters.'
const NO_PICTURES = 'ChatGPT here reads text only, so the pictures were not sent.'
/** How long an account that hit its limit is held out (runtime.ts LIMIT_HOLD_MS). */
const LIMIT_HOLD_MS = 60 * 60_000
const POLL_MS = 1000

/** The running turn of each chat, so release(chatId) can cancel its job. */
const running = new Map<string, { cancel: () => Promise<void> }>()

async function desk<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${DESK_URL}/api/free${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok)
    throw new DeskError(res.status, `Desk 2 answered ${res.status} to ${method} /api/free${path}`)
  return (await res.json()) as T
}

class DeskError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Desk runs one job per Free account and answers 409 while one runs (another chat's, or a person's). The chat's
 *  ChatGPT thread lives on that account, so the turn waits for it, up to this long (2026-10-14: two probe chats on
 *  one account, and the second failed at once). */
const BUSY_WAIT_MS = 3 * 60_000
const BUSY_POLL_MS = 3000

/** A ChatGPT chat's name: 1 to 100 printable characters, unique on its account (runtime.ts chatName; 2026-10-14: every
 *  account already had a chat named for the probe's prompt, so each refused it with name_conflict). */
const chatName = (title: string, id: string): string =>
  `${
    title
      .replace(/\p{Cc}/gu, ' ')
      .trim()
      .slice(0, 91) || 'Desk chat'
  } ${id.slice(0, 8)}`

function startTurn(task: Task, account: Account, sink: TurnSink): Turn {
  const started = Date.now()
  let jobId: string | null = null
  let over = false
  let settle!: (end: TurnEnd) => void
  const done = new Promise<TurnEnd>((resolve) => (settle = resolve))

  const end = (e: TurnEnd): void => {
    if (over) return
    over = true
    if (running.get(task.chatId)?.cancel === cancel) running.delete(task.chatId)
    settle(e)
  }
  const cancel = async (): Promise<void> => {
    if (over) return
    if (jobId) await desk('DELETE', `/jobs/${jobId}`).catch(() => undefined)
    end({ ok: false, error: 'Interrupted', durationMs: Date.now() - started })
  }

  const run = async (): Promise<void> => {
    try {
      if (task.text.length > PROMPT_MAX)
        return end({ ok: false, error: TOO_LONG, durationMs: Date.now() - started })
      if (task.images?.length)
        sink.item({
          kind: 'system',
          id: `chatgpt-pictures:${started}`,
          ts: Date.now(),
          level: 'info',
          text: NO_PICTURES,
        })
      const model = task.model && isFreeChatgptModel(task.model) ? task.model : null
      // A thread from another account cannot be continued here: the chat starts a new ChatGPT chat on this one.
      const bound = task.thread?.accountId === account.id ? task.thread.threadId : null
      const body: FreeRequest = {
        requestId: randomUUID(),
        instanceId: account.home,
        provider: 'chatgpt',
        prompt: task.text,
        ...(bound
          ? { command: 'resume', chatId: bound }
          : { command: 'chat', name: chatName(task.title, task.chatId) }),
        ...(model ? { model } : {}),
      } as FreeRequest
      sink.activity('Asking ChatGPT')
      let job: FreeJob | null = null
      for (const until = Date.now() + BUSY_WAIT_MS; !job; ) {
        try {
          job = await desk<FreeJob>('POST', '/jobs', { ...body, requestId: randomUUID() })
        } catch (err) {
          if (!(err instanceof DeskError) || err.status !== 409 || Date.now() > until) throw err
          sink.activity('Waiting for this ChatGPT account to finish another job')
          await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_MS))
          if (over) return
        }
      }
      jobId = job.id
      sink.activity('Waiting for ChatGPT')
      while (job.state !== 'done') {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        if (over) return
        job = await desk<FreeJob>('GET', `/jobs/${jobId}`)
      }
      if (over) return
      const result: FreeResult = job.result ?? {
        ok: false,
        error: { code: 'no_result', message: 'ChatGPT gave no answer.' },
      }
      const durationMs = Date.now() - started
      if (result.ok && result.chat_id) {
        sink.thread({ accountId: account.id, label: account.label, threadId: result.chat_id })
        const text = (result.response ?? '').trim()
        if (text)
          sink.item({ kind: 'assistant_text', id: `chatgpt:${jobId}`, ts: Date.now(), text })
        return end({ ok: true, durationMs })
      }
      const code = result.error?.code ?? ''
      if (code === 'rate_limited') {
        return end({
          ok: false,
          error: result.error?.message || 'ChatGPT hit its limit.',
          durationMs,
          limitedUntil: Date.now() + LIMIT_HOLD_MS,
        })
      }
      const why =
        code === 'login_required'
          ? `${account.label} is signed out of ChatGPT. Sign it in again on the Free page, then send again.`
          : result.error?.message || 'ChatGPT could not answer.'
      end({ ok: false, error: why, durationMs })
    } catch (err) {
      end({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      })
    }
  }

  running.set(task.chatId, { cancel })
  void run()
  return { done, interrupt: () => void cancel() }
}

export function chatgptBackend(): Backend {
  return {
    service: 'chatgpt',
    start: (task, account, sink) => startTurn(task, account, sink),
    async release(chatId) {
      await running.get(chatId)?.cancel()
    },
  }
}
