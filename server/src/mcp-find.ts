// server/src/mcp-find.ts - how an agent reaches all of AgentHydra through a short tool list, and drives its own Desk chat.
//
// AgentHydra has over a hundred tools, about 35k tokens of schemas (measured 2026-10-11), and a client that loads
// them all pays that on every chat. So only the tools agents actually use are listed (mcp.ts LISTED_TOOLS, picked
// from the calls in every transcript on the PC), and the rest are reached the way the Connections MCP reaches its
// catalog: hydra_find searches every tool in plain words, hydra_run runs any of them by name.
//
// desk_chat moves and renames a Hydra Desk chat (the AgentHydra 2.0 window). Until 2026-10-11 that was only a
// sentence in the Desk system prompt (PATCH /api/chats/:id), and an agent asked to switch its workspace opened a
// second chat instead, because no tool it could see said "folder". Desk puts the chat's own id in this server's
// environment (HYDRA_DESK_CHAT_ID), so a chat changes itself without knowing its id.
//
// daemon_restart is the tool for the restart the daemon's "running older code" note asks for (POST /api/daemon/restart).
import { statSync } from 'node:fs'
import { api, type HydraTool, JSON_HEADERS, S, str } from './mcp-client'
import type { McpEngineTool } from './mcp-stdio.mjs'

/** Words an agent says, mapped to the words the tool texts use. */
export const SYNONYMS: Record<string, string[]> = {
  workspace: ['folder', 'cwd', 'project'],
  folder: ['workspace', 'cwd', 'project'],
  project: ['folder', 'workspace'],
  directory: ['folder', 'cwd'],
  switch: ['move', 'change'],
  change: ['move', 'switch', 'set'],
  rename: ['title', 'name'],
  title: ['rename', 'name'],
  account: ['instance'],
  instance: ['account'],
  dashboard: ['site', 'website', 'page', 'html'],
  website: ['dashboard', 'site', 'page', 'html'],
  site: ['dashboard', 'website', 'page', 'html'],
  page: ['dashboard', 'website', 'site', 'html'],
  pages: ['dashboard', 'website', 'site', 'html'],
  html: ['dashboard', 'website', 'site', 'page'],
  quota: ['usage', 'limit'],
  usage: ['quota', 'limit'],
  conversation: ['chat', 'session'],
  chat: ['session'],
  session: ['chat'],
  delete: ['remove', 'archive'],
  spawn: ['fan', 'launch', 'start'],
  parallel: ['fan'],
  server: ['dev'],
  restart: ['relaunch', 'daemon'],
}

const STOP = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'in',
  'on',
  'and',
  'or',
  'for',
  'my',
  'this',
  'that',
  'it',
  'is',
  'i',
  'me',
  'with',
  'how',
  'do',
  'can',
])

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
}

/** English function words plus the filler of a chat message ("what", "into", "start", "keep going"): words that
 *  say nothing about which entry or which field a message needs. */
export const CONTENT_STOP = new Set([
  ...STOP,
  ...`about above after again against all almost also am among any anyone anything are aren around as ask asked at
  away back be because been before being below best better between both but by came cannot could couldn did didn
  does doesn doing don done down during each else enough etc even ever every everything few first from further
  get gets getting give go goes going gone good got great had hasn has have haven having he her here hers him his
  however if into isn its itself just keep kind know last left let lets like ll made make makes making many
  may maybe might mine more most much must need needs new next no nor not now off ok okay old once one only onto
  other others our ours out over own please put quite rather re really right said same say see seem seems she
  should shouldn since so some something soon still such sure take tell than thank thanks that's their theirs them
  then there these they thing things think those though through thus till too try two under until up upon us use
  used using ve very via want wants was wasn way we well went were weren what whats when where whether which while
  who whom whose why will won would wouldn yes yet you your yours yourself start started work working works find
  found run running stuff continue proceed lot lots time today tomorrow yesterday week day hour long already again`.split(
    /\s+/,
  ),
])

/** The content words of a text: `words` without CONTENT_STOP. */
export function contentWords(text: string): string[] {
  return words(text).filter((w) => !CONTENT_STOP.has(w))
}

/** The first sentence of a description, without the MUTATES: tag, for a one-line summary. */
function summary(description: string): string {
  const d = description.replace(/^MUTATES:\s*/, '').replace(/^READ-ONLY:\s*/, '')
  const end = d.search(/[.!?](\s|$)/)
  const s = end > 0 ? d.slice(0, end + 1) : d
  return s.length > 220 ? `${s.slice(0, 217)}...` : s
}

export interface FoundTool {
  name: string
  score: number
  mutates: boolean
  listed: boolean
  summary: string
  required: string[]
}

/** Ranks tools for a plain-words ask: a word in the name counts most, then in the first sentence, then anywhere. */
/** `desk`: the caller is a Hydra Desk chat, so the Desk tools (desk_*) outrank the Claude Desktop ones that share their words. */
export function rankTools(
  tools: McpEngineTool[],
  query: string,
  limit = 8,
  listed?: ReadonlySet<string>,
  desk = false,
): FoundTool[] {
  const terms = new Map<string, number>()
  for (const w of words(query)) {
    terms.set(w, Math.max(terms.get(w) ?? 0, 1))
    for (const s of SYNONYMS[w] ?? []) terms.set(s, Math.max(terms.get(s) ?? 0, 0.6))
  }
  const out: FoundTool[] = []
  for (const t of tools) {
    const name = new Set(words(t.name.replace(/_/g, ' ')))
    const desc = t.description ?? ''
    const first = new Set(words(summary(desc)))
    const all = new Set(words(desc))
    let score = 0
    for (const [w, weight] of terms) {
      if (name.has(w)) score += 5 * weight
      else if (first.has(w)) score += 2 * weight
      else if (all.has(w)) score += 0.5 * weight
    }
    if (score <= 0) continue
    if (desk && t.name.startsWith('desk_')) score *= 1.5
    const schema = t.inputSchema as { required?: string[] } | undefined
    out.push({
      name: t.name,
      score: Math.round(score * 10) / 10,
      mutates: /^MUTATES:/.test(desc),
      listed: listed ? listed.has(t.name) : true,
      summary: summary(desc),
      required: schema?.required ?? [],
    })
  }
  return out
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, limit))
}

/** The Desk window's address on this PC. */
export function deskBase(): string {
  return `http://127.0.0.1:${Number(process.env.HYDRA_DESK_PORT) || 7798}`
}

interface DeskChat {
  id: string
  sessionId?: string | null
  title?: string
  cwd?: string
}

/** One Desk chat from its Desk id, its Claude session id, or a title fragment (refuses an empty or ambiguous one). */
export function pickDeskChat(chats: DeskChat[], ref: string): DeskChat {
  const r = ref.trim()
  if (!r)
    throw new Error('chat is required: pass the Desk chat id, its session id, or part of its title')
  const exact = chats.find((c) => c.id === r || c.sessionId === r)
  if (exact) return exact
  const low = r.toLowerCase()
  const hits = chats.filter((c) => (c.title ?? '').toLowerCase().includes(low))
  if (hits.length === 1) return hits[0]
  if (!hits.length)
    throw new Error(
      `no Desk chat matches "${r}" (pass its Desk chat id, its session id, or part of its title)`,
    )
  throw new Error(
    `"${r}" matches ${hits.length} Desk chats: ${hits
      .slice(0, 6)
      .map((c) => `${c.id} "${c.title}"`)
      .join('; ')}; pass the id`,
  )
}

/** What desk_chat sends: the folder and/or the title, each checked; refuses a call that changes nothing. */
export function deskChatPatch(a: Record<string, unknown>): { cwd?: string; title?: string } {
  const patch: { cwd?: string; title?: string } = {}
  const cwd = str(a.cwd).trim()
  if (cwd) {
    let isFolder = false
    try {
      isFolder = statSync(cwd).isDirectory()
    } catch {} // floor-ok: a stat that throws means there is no folder there, reported just below
    if (!isFolder) throw new Error(`no folder at ${cwd}`)
    patch.cwd = cwd
  }
  const title = str(a.title).trim()
  if (title) patch.title = title.slice(0, 200)
  if (!patch.cwd && !patch.title)
    throw new Error('pass cwd (a folder to move the chat to), title (a new name), or both')
  return patch
}

/** Tools that are never run through hydra_run: itself, and the search. */
const NOT_RUNNABLE = new Set(['hydra_run', 'hydra_find'])

/** How an agent calls a tool: a listed one by its own name, any other through hydra_run. */
const callOf = (name: string, listed: boolean): string =>
  listed ? `${name} { ... }` : `hydra_run { tool: "${name}", args: { ... } }`

export function findTools(
  getTools: () => HydraTool[],
  getListed: () => ReadonlySet<string>,
): HydraTool[] {
  return [
    {
      name: 'hydra_find',
      callerChat: 'deskChat',
      listed: true,
      description:
        "Searches every AgentHydra tool by what you want done, in plain words, such as 'rename this chat', 'which account " +
        "has quota left' or 'restart the daemon'. Returns the best matches, each with a one-line summary, its required " +
        'parameters, whether it is in your tool list, and `call`, the exact call to make. Search here before concluding ' +
        'that something cannot be done.',
      inputSchema: S(
        {
          query: { type: 'string', description: 'What you want done, in plain words.' },
          limit: { type: 'number', description: 'How many tools to return (default 8).' },
          tool: {
            type: 'string',
            description:
              "Instead of searching, return one tool's full description and input schema.",
          },
        },
        [],
      ),
      run: async (a) => {
        const tools = getTools()
        const listed = getListed()
        const one = str(a.tool).trim()
        if (one) {
          const t = tools.find((x) => x.name === one)
          if (!t) throw new Error(`no AgentHydra tool named ${one}; search with query instead`)
          return {
            name: t.name,
            listed: listed.has(t.name),
            description: t.description,
            inputSchema: t.inputSchema,
            call: callOf(t.name, listed.has(t.name)),
          }
        }
        const query = str(a.query).trim()
        if (!query) throw new Error('pass query (what you want done) or tool (a name to describe)')
        const limit =
          Number.isFinite(Number(a.limit)) && Number(a.limit) > 0 ? Math.floor(Number(a.limit)) : 8
        const found = rankTools(
          tools.filter((t) => !NOT_RUNNABLE.has(t.name)),
          query,
          limit,
          listed,
          !!(str(a.deskChat).trim() || process.env.HYDRA_DESK_CHAT_ID?.trim()),
        )
        return {
          query,
          tools: found.map((f) => ({ ...f, call: callOf(f.name, f.listed) })),
          note: found.length
            ? 'A tool with listed: true is already in your tool list: call it by its name. Any other tool runs through hydra_run { tool, args }. hydra_find { tool } gives its full schema.'
            : 'Nothing matched: try other words (what it acts on: chat, account, folder, quota, session, server).',
        }
      },
    },
    {
      name: 'hydra_run',
      listed: true,
      description:
        'Runs an AgentHydra tool that is not in your tool list, by name: hydra_run { tool, args }. It changes state only ' +
        'when the tool it runs does. Your list holds the most used tools; the rest (orchestrator, free_chat, instances, ' +
        'incidents, daemon_restart and so on) are reached here. Find a tool and its arguments with hydra_find. The result is what the tool returns.',
      inputSchema: S(
        {
          tool: { type: 'string', description: 'The tool name, as hydra_find gives it.' },
          args: { type: 'object', description: "The tool's own arguments." },
        },
        ['tool'],
      ),
      run: async (a, signal?: AbortSignal) => {
        const name = str(a.tool).trim()
        if (NOT_RUNNABLE.has(name))
          throw new Error(`${name} is called directly, not through hydra_run`)
        const t = getTools().find((x) => x.name === name)
        if (!t)
          throw new Error(
            `no AgentHydra tool named ${name || '(none)'}; search with hydra_find { query }`,
          )
        const args =
          a.args && typeof a.args === 'object' && !Array.isArray(a.args)
            ? (a.args as Record<string, unknown>)
            : {}
        return (t.run as (x: Record<string, unknown>, s?: AbortSignal) => unknown)(args, signal)
      },
    },
    {
      name: 'desk_chat',
      callerChat: 'chat',
      listed: true,
      description:
        'MUTATES: move this chat (a Hydra Desk chat) to another folder or workspace, and/or rename it. `cwd` moves it, ' +
        'which is how its WORKSPACE changes: the sidebar group, the project it works in, and the workspace-scoped tools ' +
        '(saved browsers, the Connections workspace) that follow the folder; its tools see the new folder from its next ' +
        'turn. `title` renames it: worth it when the chat has really changed what it works on, not on every turn. ' +
        '`chat` defaults to THIS chat; name another by its Desk id, its Claude session id, or part of its title. Not for ' +
        'Claude DESKTOP chats (move_chat_folder) or for moving a chat to another ACCOUNT (move_chat).',
      inputSchema: S({
        cwd: {
          type: 'string',
          description: 'The new folder: an absolute path to an existing folder.',
        },
        title: { type: 'string', description: 'The new name.' },
        chat: {
          type: 'string',
          description:
            'Another chat: Desk chat id, Claude session id, or a title fragment. Default: this chat.',
        },
      }),
      run: async (a) => {
        const patch = deskChatPatch(a)
        const base = deskBase()
        const listed = await fetch(`${base}/api/chats`).catch(() => null)
        if (!listed?.ok)
          throw new Error(`the Desk window does not answer at ${base}; is AgentHydra 2.0 open?`)
        const chats: unknown = await listed.json().catch(() => null)
        if (!Array.isArray(chats))
          throw new Error(`unexpected answer from ${base}/api/chats (not a list of chats)`)
        const ref = str(a.chat).trim() || process.env.HYDRA_DESK_CHAT_ID?.trim() || ''
        if (!ref)
          throw new Error(
            'this process is not a Desk chat (no HYDRA_DESK_CHAT_ID): name the chat with `chat`',
          )
        const chat = pickDeskChat(chats as DeskChat[], ref)
        const res = await fetch(`${base}/api/chats/${encodeURIComponent(chat.id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        const body = (await res.json().catch(() => ({}))) as DeskChat & { error?: string }
        if (!res.ok) throw new Error(`Desk refused the change: ${body.error ?? res.status}`)
        return {
          id: body.id ?? chat.id,
          title: body.title ?? chat.title,
          cwd: body.cwd ?? chat.cwd,
          ...(patch.cwd
            ? { from: chat.cwd, note: "Its tools see the new folder from the chat's next turn." }
            : {}),
        }
      },
    },
    {
      name: 'desk_transcript',
      callerChat: 'chat',
      description:
        'Reads the whole record of a Hydra Desk chat as Desk keeps it: messages, tool calls and results, oldest first. Use it for a detail a handoff left out. chat defaults to this chat; name another by Desk id, session id or title fragment. last keeps only the newest N items. Read-only.',
      inputSchema: S({
        chat: {
          type: 'string',
          description: 'Desk chat id, Claude session id, or a title fragment. Default: this chat.',
        },
        last: { type: 'number', description: 'Only the newest N items.' },
      }),
      run: async (a) => {
        const base = deskBase()
        const listed = await fetch(`${base}/api/chats`).catch(() => null)
        if (!listed?.ok)
          throw new Error(`the Desk window does not answer at ${base}; is AgentHydra 2.0 open?`)
        const chats: unknown = await listed.json().catch(() => null)
        if (!Array.isArray(chats))
          throw new Error(`unexpected answer from ${base}/api/chats (not a list of chats)`)
        const ref = str(a.chat).trim() || process.env.HYDRA_DESK_CHAT_ID?.trim() || ''
        if (!ref)
          throw new Error(
            'this process is not a Desk chat (no HYDRA_DESK_CHAT_ID): name the chat with `chat`',
          )
        const chat = pickDeskChat(chats as DeskChat[], ref)
        const res = await fetch(
          `${base}/api/chats/${encodeURIComponent(chat.id)}/transcript`,
        ).catch(() => null)
        if (!res?.ok)
          throw new Error(
            `Desk did not give the transcript of ${chat.id} (${res?.status ?? 'no answer'})`,
          )
        const items: unknown = await res.json().catch(() => null)
        if (!Array.isArray(items))
          throw new Error('unexpected transcript answer (not a list of items)')
        const last = Number(a.last)
        return {
          id: chat.id,
          title: chat.title,
          total: items.length,
          items: Number.isFinite(last) && last > 0 ? items.slice(-Math.floor(last)) : items,
        }
      },
    },
    {
      name: 'daemon_restart',
      description:
        'MUTATES: restart the AgentHydra daemon onto the code in its folder (what its "running older code" note asks for). ' +
        'The successor starts and reports in before this one lets go, so there is no gap; dispatch runs and CliMayte ' +
        'runners carry on. Refused while a chat move is running or a CliMayte worker runs inside the daemon itself, ' +
        "unless `force` (a person's word).",
      inputSchema: S({
        force: {
          type: 'boolean',
          description: "A person's word: restart past in-daemon CliMayte workers.",
        },
      }),
      run: (a) =>
        api('/api/daemon/restart', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ force: a.force === true }),
        }),
    },
  ]
}

/** The header Desk puts on each chat's agenthydra MCP connection: that chat's Desk id. */
export const DESK_CHAT_HEADER = 'x-hydra-desk-chat'

/** A tool's arguments with the calling Desk chat filled in, as its own `callerChat` flag says; any other tool's as given. */
function bindDeskChat(
  tool: HydraTool | undefined,
  a: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  if (tool?.callerChat === 'chat') return { ...a, chat: str(a.chat).trim() || id }
  if (tool?.callerChat === 'deskChat') return { ...a, deskChat: id }
  return a
}

/** `tools` with every `callerChat` tool (desk_chat, desk_transcript, the dashboard tools...) defaulting to the calling Desk chat (the HTTP transport knows it
 *  from DESK_CHAT_HEADER; stdio from HYDRA_DESK_CHAT_ID), also when reached through hydra_run, which runs the bare tool (a chat
 *  whose list was fixed before a tool was added reaches it only that way). Every other tool is the same object. */
export function withDeskChat(tools: HydraTool[], chatId: string | null | undefined): HydraTool[] {
  const id = chatId?.trim()
  if (!id) return tools
  return tools.map((t) => {
    const run = t.run as (x: Record<string, unknown>, s?: AbortSignal) => unknown
    if (t.name === 'hydra_run')
      return {
        ...t,
        run: (a: Record<string, unknown>, signal?: AbortSignal) => {
          const args =
            a.args && typeof a.args === 'object' && !Array.isArray(a.args)
              ? (a.args as Record<string, unknown>)
              : {}
          const named = str(a.tool).trim()
          return run(
            {
              ...a,
              args: bindDeskChat(
                tools.find((x) => x.name === named),
                args,
                id,
              ),
            },
            signal,
          )
        },
      }
    if (!t.callerChat) return t
    return {
      ...t,
      run: (a: Record<string, unknown>, signal?: AbortSignal) =>
        run(bindDeskChat(t, a, id), signal),
    }
  })
}
