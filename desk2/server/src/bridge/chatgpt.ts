// ChatGPT's conversations as outside sessions, listed with Claude's and Codex's (owner, 2026-10-22: "devia ter sido
// integrado como qualquer outra fonte"). They are read from the AgentHydra that holds the browser bridge: the hub
// named by AGENTHYDRA_CHATGPT_HUB_URL, else this PC's own (HYDRA_URL), with the hub's admin token from this PC's
// environment. Only fixed routes are asked, nothing read is stored, and a message goes only when a person sends it
// from the chat's composer. A hub without ChatGPT (off, unreachable, refused) lists none and is asked again later.

import type { ExternalSession, TranscriptItem } from '@shared/protocol'
import { DEFAULT_HYDRA_URL } from './client'

export const CHATGPT_PREFIX = 'chatgpt:'
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A ChatGPT row's session id, `chatgpt:<conversation id>`. */
export const isChatGptId = (id: string): boolean => id.startsWith(CHATGPT_PREFIX) && ID.test(id.slice(CHATGPT_PREFIX.length))
const conversationOf = (id: string): string => id.slice(CHATGPT_PREFIX.length)

/** How many of the newest conversations are listed. */
export const LIST_LIMIT = 30
/** The list is read again after this long. */
export const LIST_FRESH_MS = 30_000
/** A hub that did not answer the list is asked again after this long; meanwhile the last list stands for KEEP_MS. */
export const RETRY_MS = 5 * 60_000
const KEEP_MS = 2 * 60_000
/** A conversation sent to or seen running is read again on each list while it runs, for this long at most. */
const RUNNING_MS = 10 * 60_000

export class ChatGptError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export function chatGptHub(env: Record<string, string | undefined> = process.env): { base: URL; token: string } | null {
  try {
    const base = new URL((env.AGENTHYDRA_CHATGPT_HUB_URL?.trim() || env.HYDRA_URL || DEFAULT_HYDRA_URL).replace(/\/+$/, ''))
    if ((base.protocol !== 'http:' && base.protocol !== 'https:') || base.username || base.password) return null
    const token = (env.AGENTHYDRA_CHATGPT_HUB_TOKEN ?? env.AGENTHYDRA_CODEX_HUB_TOKEN ?? '').trim()
    return { base, token }
  } catch {
    return null
  }
}

type TurnState = 'idle' | 'thinking' | 'generating' | 'stopped'
interface Summary {
  id: string
  title: string
  updatedAt: string | null
}
interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number | null
}
interface Conversation {
  id: string
  title: string
  messages: Message[]
  state: TurnState
}

const running = (s: TurnState): boolean => s === 'thinking' || s === 'generating'
const WORDS: Record<TurnState, string | null> = { idle: null, stopped: null, thinking: 'Thinking', generating: 'Writing' }

/** A conversation's messages as the transcript draws them: the person's own bubbles and ChatGPT's replies. */
export function conversationItems(c: Pick<Conversation, 'messages'>, fallbackTs = 0): TranscriptItem[] {
  return c.messages.map((m): TranscriptItem => {
    const ts = typeof m.createdAt === 'number' ? Math.round(m.createdAt * 1000) : fallbackTs
    return m.role === 'user' ? { id: m.id, ts, kind: 'user', text: m.text } : { id: m.id, ts, kind: 'assistant_text', text: m.text }
  })
}

/** What a new conversation is called until ChatGPT names it: the start of its first message. */
const newTitle = (text: string): string => {
  const line = text.trim().split('\n')[0]!.trim()
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

/** One list row: ChatGPT keeps no folder, account or model Desk can use, and nothing here resumes it elsewhere. */
export function chatGptRow(s: Summary, state: TurnState | undefined, at: number | null): ExternalSession {
  const updated = s.updatedAt ? Date.parse(s.updatedAt) : Number.NaN
  const last = Math.max(Number.isFinite(updated) ? updated : 0, at ?? 0)
  return {
    id: `${CHATGPT_PREFIX}${s.id}`,
    title: s.title || 'New chat',
    cwd: null,
    source: 'chatgpt',
    app: 'chatgpt',
    instance: null,
    status: state && running(state) ? 'working' : 'idle',
    activity: state ? WORDS[state] : null,
    lastActivityAt: last || null,
    model: null,
    accountId: null,
    canResume: false,
    fromPc: null,
    pinned: false,
    archived: false,
    unread: false,
    group: null,
  }
}

export interface ChatGptSourceOptions {
  fetcher?: (url: string, init: RequestInit) => Promise<Response>
  hub?: () => { base: URL; token: string } | null
  now?: () => number
}

export function createChatGptSource(o: ChatGptSourceOptions = {}) {
  const fetcher = o.fetcher ?? ((url, init) => fetch(url, init))
  const hub = o.hub ?? (() => chatGptHub())
  const now = o.now ?? Date.now
  let listed: { at: number; rows: Summary[] } | null = null
  let failedAt = 0
  let reading: Promise<Summary[]> | null = null
  /** What each conversation was last seen doing, and when (a send counts as thinking). */
  const states = new Map<string, { state: TurnState; at: number; title?: string }>()

  async function ask<T>(path: string, init: { method?: 'GET' | 'POST'; body?: string; timeout: number }): Promise<T> {
    const h = hub()
    if (!h) throw new ChatGptError('No ChatGPT hub is configured', 503)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (h.token) headers.authorization = `Bearer ${h.token}`
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await fetcher(new URL(path, `${h.base.toString().replace(/\/+$/, '')}/`).toString(), {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        redirect: 'error',
        signal: AbortSignal.timeout(init.timeout),
      })
    } catch {
      throw new ChatGptError('The ChatGPT hub is not reachable', 503)
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null
    if (!res.ok || data === null) {
      const why = typeof data?.error === 'string' ? data.error : `The ChatGPT hub answered ${res.status}`
      throw new ChatGptError(why, res.status === 404 || res.status === 409 || res.status === 400 ? res.status : 503)
    }
    return data
  }

  function readList(): Promise<Summary[]> {
    reading ??= ask<{ conversations?: Summary[] }>(`api/chatgpt/conversations?limit=${LIST_LIMIT}&offset=0`, { timeout: 45_000 })
      .then((r) => {
        const rows = Array.isArray(r.conversations) ? r.conversations.filter((s) => s && typeof s.id === 'string' && ID.test(s.id)) : []
        listed = { at: now(), rows }
        failedAt = 0
        return rows
      })
      .catch(() => {
        failedAt = now()
        return listed && now() - listed.at < KEEP_MS ? listed.rows : []
      })
      .finally(() => {
        reading = null
      })
    return reading
  }

  async function read(id: string): Promise<Conversation> {
    const c = await ask<Conversation>(`api/chatgpt/conversations/${id}`, { timeout: 45_000 })
    if (!Array.isArray(c.messages)) throw new ChatGptError('The ChatGPT hub sent no messages', 503)
    states.set(id, { state: c.state, at: now(), title: c.title })
    return c
  }

  /** One read at a time per conversation. */
  const refreshing = new Set<string>()
  function refresh(id: string): void {
    if (refreshing.has(id)) return
    refreshing.add(id)
    read(id)
      .catch(() => null)
      .finally(() => refreshing.delete(id))
  }

  return {
    /**
     * The newest conversations as rows, from what was last read: a list past LIST_FRESH_MS, and each running
     * conversation, are read again behind this answer, so the poll never waits on the browser. Never throws.
     */
    sessions(): ExternalSession[] {
      const t = now()
      if (!(listed && t - listed.at < LIST_FRESH_MS) && !(failedAt && t - failedAt < RETRY_MS)) void readList()
      const rows = listed && (t - listed.at < KEEP_MS || !failedAt) ? listed.rows : []
      // A conversation the list has not caught up with is listed from what was last read of it.
      const all = [...rows]
      for (const [id, s] of states) if (!all.some((r) => r.id === id) && s.title !== undefined) all.unshift({ id, title: s.title, updatedAt: null })
      for (const [id, s] of states) if (running(s.state) && t - s.at < RUNNING_MS) void refresh(id)
      return all.map((r) => {
        const seen = states.get(r.id)
        return chatGptRow(r, seen && t - seen.at < RUNNING_MS ? seen.state : undefined, seen?.at ?? null)
      })
    },

    async items(sessionId: string): Promise<TranscriptItem[]> {
      return conversationItems(await read(conversationOf(sessionId)), now())
    },

    /** The person's message, typed into ChatGPT once. */
    async send(sessionId: string, text: string): Promise<void> {
      const id = conversationOf(sessionId)
      await ask(`api/chatgpt/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }), timeout: 120_000 })
      const seen = states.get(id)
      states.set(id, { ...seen, state: 'thinking', at: now() })
    },

    /**
     * A new conversation, started by the person's first message, typed into ChatGPT once. Its session id, or null when
     * ChatGPT took the message but did not show the new conversation in time; the list then catches up with it.
     */
    async start(text: string): Promise<string | null> {
      const r = await ask<{ id?: unknown }>('api/chatgpt/conversations', { method: 'POST', body: JSON.stringify({ text }), timeout: 120_000 })
      listed = null
      if (typeof r.id !== 'string' || !ID.test(r.id)) return null
      states.set(r.id, { state: 'thinking', at: now(), title: newTitle(text) })
      return `${CHATGPT_PREFIX}${r.id}`
    },

    async stop(sessionId: string): Promise<boolean> {
      const r = await ask<{ stopped?: boolean }>(`api/chatgpt/conversations/${conversationOf(sessionId)}/stop`, { method: 'POST', body: '{}', timeout: 45_000 })
      return r.stopped === true
    },
  }
}

export type ChatGptSource = ReturnType<typeof createChatGptSource>
