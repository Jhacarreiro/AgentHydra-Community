// The codex backend: one turn on one account's Codex app-server. The app-server, the thread's resume and start, the
// items and the picture cache are Desk 2's (desk2/server/src/engine/codex), imported the way Desk's runtime imports
// them. Codex lets one program write a thread at a time, so a turn holds its app-server and thread only while it runs:
// the end unsubscribes and releases them, and the chat's next turn resumes the thread.
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type AppServer,
  openAppServer,
  type ThreadListener,
} from '../../../desk2/server/src/engine/codex/app-server'
import {
  activityOf,
  type CodexItem,
  codexItems,
  planTodos,
} from '../../../desk2/server/src/engine/codex/items'
import { codexModel, isLimit, policy } from '../../../desk2/server/src/engine/codex/runtime'
import { createMediaCache, type MediaCache } from '../../../desk2/server/src/media/cache'
import type { PermissionMode } from '../../../desk2/shared/protocol'
import type { Account, Backend, Image, Task, Turn, TurnEnd, TurnSink } from '../types'

const STOP_GRACE_MS = 5_000
/** How long an account that hit its usage limit is held when Codex does not say (runtime.ts LIMIT_HOLD_MS). */
const LIMIT_HOLD_MS = 60 * 60_000

interface CodexTurn {
  id: string
  status: string
  error?: { message?: string; codexErrorInfo?: unknown } | null
  durationMs?: number | null
}

/** What a chat holds while its turn runs: stop it, and wait until it has let go of its app-server and thread. */
interface Live {
  stop(): void
  idle: Promise<void>
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** When a limit ends, from Codex's "...or try again at 2:48 AM." (local time): the next time the clock reads it, else
 *  LIMIT_HOLD_MS from now (2026-10-14: a login whose limit ended in minutes was held an hour). */
function limitEnds(message: string, now: number): number {
  const m = /try again at (\d{1,2}):(\d{2})\s*([AP]M)/i.exec(message)
  if (!m) return now + LIMIT_HOLD_MS
  const at = new Date(now)
  at.setHours((Number(m[1]) % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0), Number(m[2]), 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

/** A login OpenAI is throttling ('exceeded retry limit, last status: 429 Too Many Requests') is not at its usage limit:
 *  the turn moves to another account (README: a limit or a failure moves it to the next A). */
const throttled = (message: string): boolean => /\b429\b|too many requests/i.test(message)

let media: MediaCache | null = null

/** The task's pictures as Codex reads them: each cached as a local file, the way Desk's runtime sends them. */
function pictures(images: Image[] = []): Record<string, unknown>[] {
  media ??= createMediaCache(join(homedir(), '.agenthydra', 'core', 'media'))
  const cache = media
  return images.flatMap((img) => {
    const ref = cache.putBase64(img.dataBase64, img.name)
    const file = ref?.url?.split('/').pop()
    return file ? [{ type: 'localImage', path: join(cache.dir, file) }] : []
  })
}

export function codexBackend(): Backend {
  const live = new Map<string, Live>()

  return {
    service: 'codex',

    start(task: Task, account: Account, sink: TurnSink): Turn {
      let server: AppServer | null = null
      let threadId: string | null = null
      let turnId: string | null = null
      let unlisten: (() => void) | null = null
      let stopped = false
      let ended = false
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      const started = Date.now()
      const streams = new Map<
        string,
        { kind: 'assistant_text' | 'thinking'; ts: number; text: string }
      >()
      const running = new Map<string, { startedAt: number }>()

      let finish!: (result: TurnEnd) => void
      const done = new Promise<TurnEnd>((resolve) => (finish = resolve))

      const end = (result: TurnEnd): void => {
        if (ended) return
        ended = true
        clearTimeout(graceTimer)
        finish(result)
      }

      const stream = (itemId: string, kind: 'assistant_text' | 'thinking', delta: string): void => {
        if (!delta) return
        const s = streams.get(itemId)
        if (!s) {
          const ts = running.get(itemId)?.startedAt ?? Date.now()
          streams.set(itemId, { kind, ts, text: delta })
          sink.item({ kind, id: itemId, ts, text: delta, streaming: true })
          if (kind === 'assistant_text') sink.activity('Writing')
          return
        }
        s.text += delta
        sink.item({ kind, id: itemId, ts: s.ts, text: s.text, streaming: true })
      }

      const endTurn = (turn: CodexTurn): void => {
        if (ended) return
        const now = Date.now()
        for (const [id, s] of streams) sink.item({ kind: s.kind, id, ts: s.ts, text: s.text })
        streams.clear()
        running.clear()
        const info = turn.error?.codexErrorInfo
        if (turn.status === 'failed' && isLimit(info)) {
          const error = turn.error?.message || 'Codex hit its usage limit.'
          end({ ok: false, error, limitedUntil: limitEnds(error, now) })
          return
        }
        const ok = turn.status === 'completed'
        const error = ok
          ? undefined
          : turn.status === 'interrupted'
            ? 'Interrupted'
            : turn.error?.message || 'Codex could not finish the turn.'
        end({
          ok,
          durationMs: turn.durationMs ?? now - started,
          ...(error ? { error } : {}),
          ...(error && throttled(error) ? { throttled: true } : {}),
        })
      }

      const onNotify = (method: string, p: Record<string, unknown>): void => {
        if (ended) return
        const now = Date.now()
        switch (method) {
          case 'turn/started':
            turnId = (p.turn as { id: string }).id
            return
          case 'item/started': {
            const item = p.item as CodexItem
            const startedAt = typeof p.startedAtMs === 'number' ? p.startedAtMs : now
            running.set(item.id, { startedAt })
            if (item.type !== 'agentMessage' && item.type !== 'reasoning')
              for (const i of codexItems(item, { now, startedAt })) sink.item(i)
            const activity = activityOf(item)
            if (activity) sink.activity(activity)
            return
          }
          case 'item/agentMessage/delta':
            stream(String(p.itemId), 'assistant_text', String(p.delta ?? ''))
            return
          case 'item/reasoning/summaryTextDelta':
            stream(String(p.itemId), 'thinking', String(p.delta ?? ''))
            return
          case 'item/completed': {
            const item = p.item as CodexItem
            const s = streams.get(item.id)
            const startedAt = s?.ts ?? running.get(item.id)?.startedAt
            running.delete(item.id)
            streams.delete(item.id)
            const endedAt = typeof p.completedAtMs === 'number' ? p.completedAtMs : now
            for (const i of codexItems(item, { now, startedAt, endedAt })) sink.item(i)
            // A message that ended with no text (only its deltas were seen) keeps what streamed.
            if (s && !codexItems(item, { now }).length && s.text.trim())
              sink.item({ kind: s.kind, id: item.id, ts: s.ts, text: s.text })
            return
          }
          case 'turn/plan/updated':
            sink.item({
              kind: 'todos',
              id: 'todos',
              ts: now,
              todos: planTodos((p.plan as { step: string; status: string }[]) ?? []),
            })
            return
          case 'error': {
            // Codex retries a 429 or a dropped stream itself: the chat says so while it does (Desk 2's runtime does too).
            const e = p.error as { message?: string } | undefined
            if (p.willRetry && e?.message)
              sink.activity(`Codex is trying again: ${e.message.slice(0, 80)}`)
            return
          }
          case 'turn/completed':
            endTurn(p.turn as CodexTurn)
            return
        }
      }

      const listener: ThreadListener = {
        notify: (method, params) => onNotify(method, params),
        // The core answers no approval yet: a throw refuses the request.
        request: async (method) => {
          throw new Error(`Codex asked for ${method}, which the core does not answer yet`)
        },
        exited: (why) => {
          unlisten = null
          server = null
          threadId = null
          end({ ok: false, error: `Codex stopped while it was working (${why})` })
        },
      }

      /** Loads the task's thread on this app-server (resumed, else started); returns its id. */
      const bindThread = async (s: AppServer): Promise<string> => {
        const { approvalPolicy, sandbox } = policy(task.permissionMode as PermissionMode)
        const model = codexModel(task.model)
        const settings = { cwd: task.cwd, approvalPolicy, sandbox, ...(model ? { model } : {}) }
        const bind = (id: string): void => {
          unlisten = s.listen(id, listener)
          threadId = id
          sink.thread({ accountId: account.id, label: account.label, threadId: id })
        }
        if (task.thread) {
          try {
            await s.call('thread/resume', {
              threadId: task.thread.threadId,
              ...settings,
              excludeTurns: true,
            })
            bind(task.thread.threadId)
            return task.thread.threadId
          } catch (err) {
            const message = errorText(err)
            // Open in that account's Codex app, which alone may write the thread while it holds it: never a new thread for it.
            if (/active writer/i.test(message))
              throw new Error(
                `The Codex app on ${account.label} has this chat open, so only it can write to it now. Close the chat there, then send again.`,
              )
            // Gone from that account (archived there, deleted): the chat goes on in a new thread. Anything else is said.
            if (!/not found|no rollout|unknown thread|does not exist/i.test(message)) throw err
          }
        }
        const r = await s.call<{ thread: { id: string } }>('thread/start', settings)
        bind(r.thread.id)
        void s.call('thread/name/set', { threadId: r.thread.id, name: task.title }).catch(() => {})
        return r.thread.id
      }

      /** Lets go of the thread and the app-server: a finished or stopped turn holds neither. */
      const letGo = (): void => {
        if (threadId) void server?.call('thread/unsubscribe', { threadId }).catch(() => {})
        unlisten?.()
        unlisten = null
        server?.release()
        server = null
        threadId = null
      }

      const run = async (): Promise<void> => {
        try {
          const s = await openAppServer(account.home)
          server = s
          if (stopped) return
          const id = await bindThread(s)
          if (stopped) return
          const { approvalPolicy, sandboxPolicy } = policy(task.permissionMode as PermissionMode)
          const model = codexModel(task.model)
          const input = [
            { type: 'text', text: task.text, text_elements: [] },
            ...pictures(task.images),
          ]
          const { turn } = await s.call<{ turn: { id: string } }>('turn/start', {
            threadId: id,
            input,
            approvalPolicy,
            sandboxPolicy,
            ...(model ? { model } : {}),
          })
          // Stopped while Codex took the turn: it stops there too.
          if (stopped) {
            void s.call('turn/interrupt', { threadId: id, turnId: turn.id }).catch(() => {})
            return
          }
          turnId ??= turn.id
        } catch (err) {
          const message = errorText(err)
          end(
            /usage limit/.test(message)
              ? { ok: false, error: message, limitedUntil: limitEnds(message, Date.now()) }
              : throttled(message)
                ? { ok: false, error: message, throttled: true }
                : { ok: false, error: message },
          )
        } finally {
          // The thread stays held until the turn ends (Codex's notifications come while it runs), then it is let go.
          await done
          letGo()
        }
      }

      const interrupt = (): void => {
        if (ended) return
        stopped = true
        if (!turnId) {
          end({ ok: false, error: 'Interrupted' })
          return
        }
        if (server && threadId)
          void server.call('turn/interrupt', { threadId, turnId }).catch(() => {})
        // Codex ends the turn as interrupted; one that never says so is ended here.
        graceTimer = setTimeout(() => end({ ok: false, error: 'Interrupted' }), STOP_GRACE_MS)
        ;(graceTimer as { unref?: () => void }).unref?.()
      }

      const idle = run()
      live.set(task.chatId, { stop: interrupt, idle })
      void idle.then(() => {
        if (live.get(task.chatId)?.idle === idle) live.delete(task.chatId)
      })
      return { done, interrupt }
    },

    async release(chatId: string): Promise<void> {
      const l = live.get(chatId)
      if (!l) return
      l.stop()
      await l.idle
    },
  }
}
