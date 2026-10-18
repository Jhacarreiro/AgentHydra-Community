// server/src/mcp-managers.ts - manager_open, manager_ask and manager_read: a Manager Hydra manager opens sub-manager chats
// under the Desk chat it runs in, and talks to them through the Desk window's own routes.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { coreModeOn } from './hydra-core-mode'
import { loadMerged, openTurnsOf, readDeskIndex, titlesOf } from './manager-analytics/collect'
import {
  list as rsiList,
  next as rsiNext,
  start as rsiStart,
  status as rsiStatus,
  settleTrials,
} from './manager-analytics/rsi'
import { buildStats } from './manager-analytics/stats'
import { readState } from './manager-analytics/store'
import { completionsApi, type HydraTool, JSON_HEADERS, S, str } from './mcp-client'
import { deskBase, pickDeskChat } from './mcp-find'

const CORE_MODE_REFUSAL =
  'Core mode: sub-manager chats are off. Use core_use { chat, id, mode: "consult" | "hire" } to ask or hire a hidden copy.'

const MANAGER_SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/
const DEFAULT_WAIT = 30
const MAX_WAIT = 35

export interface DeskChat {
  id: string
  sessionId?: string | null
  title?: string
  cwd?: string
  status?: string
  lastError?: string | null
}

interface TranscriptItem {
  kind?: string
  text?: string
}

/** A manager's display name from its persona.json (the same folder Manager Hydra keeps its managers in). */
export function managerName(slug: string): string {
  if (!MANAGER_SLUG.test(slug)) throw new Error(`"${slug}" is not a manager slug`)
  const dir =
    process.env.AGENTHYDRA_MANAGERS_DIR?.trim() || join(homedir(), '.agenthydra', 'managers')
  let persona: unknown
  try {
    persona = JSON.parse(readFileSync(join(dir, slug, 'persona.json'), 'utf8'))
  } catch {
    throw new Error(`no manager "${slug}": it has no persona.json`)
  }
  const name =
    persona && typeof persona === 'object' ? (persona as { name?: unknown }).name : undefined
  if (typeof name !== 'string' || !name.trim())
    throw new Error(`manager "${slug}" has no name in its persona.json`)
  return name.trim()
}

const UNREACHABLE = (base: string) =>
  `the Desk window does not answer at ${base}; is AgentHydra 2.0 open?`

export async function deskChats(): Promise<DeskChat[]> {
  const base = deskBase()
  const res = await fetch(`${base}/api/chats`).catch(() => null)
  if (!res?.ok) throw new Error(UNREACHABLE(base))
  const chats: unknown = await res.json().catch(() => null)
  if (!Array.isArray(chats))
    throw new Error(`unexpected answer from ${base}/api/chats (not a list of chats)`)
  return chats as DeskChat[]
}

export async function deskPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const base = deskBase()
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }).catch(() => null)
  if (!res) throw new Error(UNREACHABLE(base))
  const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(`Desk refused: ${String(answer.error ?? res.status)}`)
  return answer
}

export async function transcriptItems(chatId: string): Promise<TranscriptItem[]> {
  const base = deskBase()
  const res = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}/transcript`).catch(
    () => null,
  )
  if (!res?.ok) throw new Error(UNREACHABLE(base))
  const items: unknown = await res.json().catch(() => null)
  if (!Array.isArray(items))
    throw new Error(`unexpected transcript from ${base} (not a list of items)`)
  return items as TranscriptItem[]
}

function waitSeconds(a: Record<string, unknown>): number {
  const n = Number(a.wait_seconds)
  return Math.min(MAX_WAIT, Math.max(0, Number.isFinite(n) ? n : DEFAULT_WAIT))
}

/** The completion registry the manager tools register with (tests replace its methods). */
export const managerCompletions: Pick<typeof completionsApi, 'waitFor' | 'seen'> = {
  waitFor: (input) => completionsApi.waitFor(input),
  seen: (ticket) => completionsApi.seen(ticket),
}

/** Tells this process's caller when a sub-manager chat's turn ends. A failed registration never fails the tool. */
async function tellWhenChatDone(
  chat: { id: string; title?: string | null },
  after: number,
): Promise<void> {
  try {
    await managerCompletions.waitFor({
      ticket: `desk-chat:${chat.id}`,
      label: `Manager chat "${chat.title ?? chat.id}"`,
      read: `manager_read { chat: "${chat.id}" }`,
      after,
    })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    process.stderr.write(`manager chat ${chat.id}: no completion wait registered (${why})\n`)
  }
}

/** Waits for the chat's turn to end and answers its final reply. `sentAfter` is the transcript length before a message
 *  this call sent (null for a read): only items after it count, and the turn must have taken that message. */
export async function replyWhenDone(
  chat: DeskChat,
  sentAfter: number | null,
  seconds: number,
): Promise<{ chat: string; title?: string; status: 'done' | 'working'; reply?: string }> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const current = (await deskChats()).find((c) => c.id === chat.id)
    const items = await transcriptItems(chat.id)
    const fresh = sentAfter === null ? items : items.slice(sentAfter)
    const working = current?.status === 'working' || current?.status === 'starting'
    // A sent message is answered only once the assistant spoke after it (or the chat errored): Desk
    // flips a new or idle chat to working a beat after the prompt lands in the transcript.
    const lastUser = fresh.map((i) => i.kind).lastIndexOf('user')
    const answered =
      sentAfter === null ||
      (lastUser >= 0 &&
        (fresh.slice(lastUser).some((i) => i.kind === 'assistant_text') || !!current?.lastError))
    if (!working && answered) {
      const reply = fresh.filter((i) => i.kind === 'assistant_text').at(-1)?.text ?? ''
      return { chat: chat.id, title: chat.title, status: 'done', reply }
    }
    if (Date.now() >= deadline) return { chat: chat.id, title: chat.title, status: 'working' }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

export const MANAGER_TOOLS: HydraTool[] = [
  {
    name: 'manager_open',
    callerChat: 'deskChat',
    description:
      "MUTATES: opens a sub-manager chat for a manager (a Manager Hydra manager, named by its slug) under THIS Hydra Desk chat, which the sidebar nests directly below it, and sends it the first prompt. The chat runs with that manager's persona. Its title is '<Name> · <title>' (the manager's name, then the topic); cwd defaults to this chat's folder. Answers the new chat's id and title; then use manager_ask or manager_read to follow it. Refused outside a Desk chat, or for a slug with no persona.json.",
    inputSchema: S(
      {
        manager: {
          type: 'string',
          description: 'The manager: its slug, the name of its folder under the managers folder.',
        },
        prompt: { type: 'string', description: 'The first message the sub-manager chat gets.' },
        title: { type: 'string', description: 'The topic, shown after the manager name.' },
        cwd: {
          type: 'string',
          description: "The folder the chat works in. Default: this chat's folder.",
        },
      },
      ['manager', 'prompt'],
    ),
    run: async (a: Record<string, unknown>) => {
      if (coreModeOn()) throw new Error(CORE_MODE_REFUSAL)
      const parentRef = str(a.deskChat).trim() || process.env.HYDRA_DESK_CHAT_ID?.trim() || ''
      if (!parentRef)
        throw new Error(
          'this process is not a Desk chat (no HYDRA_DESK_CHAT_ID): manager_open opens a chat under the calling Desk chat',
        )
      const slug = str(a.manager).trim()
      const name = managerName(slug)
      const prompt = str(a.prompt).trim()
      if (!prompt) throw new Error('prompt is required: the first message the new chat gets')
      const parent = pickDeskChat(await deskChats(), parentRef)
      const cwd = str(a.cwd).trim() || parent.cwd || ''
      if (!cwd) throw new Error('no folder: pass cwd, the calling chat has none')
      const topic = str(a.title).trim()
      const title = (topic ? `${name} · ${topic}` : name).slice(0, 200)
      const sentAt = Date.now()
      const created = await deskPost('/api/chats', {
        cwd,
        title,
        prompt,
        parentId: parent.id,
        managerSlug: slug,
      })
      const id = String(created.id)
      const shown = String(created.title ?? title)
      await tellWhenChatDone({ id, title: shown }, sentAt)
      return { chat: id, title: shown }
    },
  },
  {
    name: 'manager_ask',
    description:
      'MUTATES: sends a message to a sub-manager chat (a Hydra Desk chat, named by its Desk id, session id or title fragment) and waits up to wait_seconds (at most 35) for its turn to end. Answers {status: "done", reply} with the chat\'s final reply text, or {status: "working"} when it is still going: call manager_read later for the reply.',
    inputSchema: S(
      {
        chat: {
          type: 'string',
          description: 'The chat: Desk chat id, Claude session id, or part of its title.',
        },
        message: { type: 'string', description: 'The message to send.' },
        wait_seconds: {
          type: 'number',
          description: 'How long to wait for the reply, up to 35. Default 30.',
        },
      },
      ['chat', 'message'],
    ),
    run: async (a: Record<string, unknown>) => {
      if (coreModeOn()) throw new Error(CORE_MODE_REFUSAL)
      const message = str(a.message).trim()
      if (!message) throw new Error('message is required')
      const chat = pickDeskChat(await deskChats(), str(a.chat))
      const sentAfter = (await transcriptItems(chat.id)).length
      const sentAt = Date.now()
      await deskPost(`/api/chats/${encodeURIComponent(chat.id)}/messages`, { text: message })
      const r = await replyWhenDone(chat, sentAfter, waitSeconds(a))
      if (r.status === 'working') await tellWhenChatDone(chat, sentAt)
      return r
    },
  },
  {
    name: 'manager_read',
    description:
      'Reads a sub-manager chat (a Hydra Desk chat, named by its Desk id, session id or title fragment) without sending anything: waits up to wait_seconds (at most 35) for its turn to end, then answers {status: "done", reply} with its latest reply text, or {status: "working"} while it is still going. Read-only.',
    inputSchema: S(
      {
        chat: {
          type: 'string',
          description: 'The chat: Desk chat id, Claude session id, or part of its title.',
        },
        wait_seconds: {
          type: 'number',
          description: 'How long to wait for the turn to end, up to 35. Default 30.',
        },
      },
      ['chat'],
    ),
    run: async (a: Record<string, unknown>) => {
      if (coreModeOn()) throw new Error(CORE_MODE_REFUSAL)
      const chat = pickDeskChat(await deskChats(), str(a.chat))
      const r = await replyWhenDone(chat, null, waitSeconds(a))
      if (r.status === 'done') {
        try {
          await managerCompletions.seen(`desk-chat:${chat.id}`)
        } catch {
          // the wait stays until it expires: the reply was still answered
        }
      }
      return r
    },
  },
  {
    name: 'manager_stats',
    description:
      'Manager Hydra turn statistics from the collector: per manager, answered rate, latency, judge score, owner corrections, sub-manager asks, CliMayte worker verdicts, tokens and cost, facets, router picks by source, the worst turns with their Desk chat titles, and the open turns (open, stuckNow, openTurns). Read-only; answers from the collector output as of its last pass.',
    inputSchema: S({
      manager: { type: 'string', description: 'Only this manager slug.' },
      facet: { type: 'string', description: 'Only turns that read this facet.' },
      days: { type: 'string', description: 'Look-back in days, or "all". Default 7.' },
      worst: {
        type: 'number',
        description: 'How many worst turns to list per manager. Default 5.',
      },
    }),
    run: async (a: Record<string, unknown>) => {
      const days = a.days === 'all' ? 'all' : Number(a.days) > 0 ? Number(a.days) : 7
      const worst = Number(a.worst) > 0 ? Number(a.worst) : 5
      return buildStats(loadMerged(), {
        now: Date.now(),
        days,
        worst,
        manager: str(a.manager) || undefined,
        facet: str(a.facet) || undefined,
        open: openTurnsOf(readState()),
        titles: titlesOf(readDeskIndex()),
      })
    },
  },
  {
    name: 'manager_rsi',
    description:
      'Recursive self-improvement of Manager Hydra managers. action "next" picks the weakest manager and its failing pattern (read-only). action "list" shows every trial and its status (read-only). action "status" shows whether the daily automatic run is on, when it last ran and what it did, and every trial (read-only). action "settle" checks open trials now. action "start" MUTATES: it backs up the manager\'s brief and weakest facet, dispatches a docs worker to edit them, and records a trial; pass manager and optionally facet. Refused while a trial for that manager is still open.',
    inputSchema: S({
      action: {
        type: 'string',
        description: 'next | start | settle | list | status. Default next.',
      },
      manager: { type: 'string', description: 'Manager slug, required for start.' },
      facet: {
        type: 'string',
        description: 'Playbook facet file to improve, for start. Default the weakest.',
      },
    }),
    run: async (a: Record<string, unknown>) => {
      const action = str(a.action) || 'next'
      if (action === 'next') return rsiNext()
      if (action === 'list') return rsiList()
      if (action === 'status') return rsiStatus()
      if (action === 'settle') return settleTrials()
      if (action === 'start') {
        return rsiStart({ manager: str(a.manager), facet: str(a.facet) || undefined })
      }
      return { ok: false, reason: `unknown action "${action}"; use next, start, settle or list` }
    },
  },
]
