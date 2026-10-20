/** ChatGPT's own conversation payloads (as its web page reads them) turned into what Desk shows.
 * Pure functions over untrusted data: the account stays authoritative and nothing here is stored.
 */

export type ChatGptTurnState = 'idle' | 'thinking' | 'generating' | 'stopped'
export type ChatGptConversationSummary = { id: string; title: string; updatedAt: string | null }
export type ChatGptMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number | null
}
export type ChatGptConversation = {
  id: string
  title: string
  messages: ChatGptMessage[]
  state: ChatGptTurnState
  /** More messages exist above the ones returned. */
  truncated: boolean
}

export const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_MESSAGES = 200
export const MAX_TEXT = 250_000
const MAX_TITLE = 300
/** A question with no answer yet counts as still being worked on for this long, then as stopped. */
const PENDING_MS = 10 * 60_000

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const title = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TITLE) : '')

export function parseConversationList(input: unknown): ChatGptConversationSummary[] {
  const items = record(input)?.items
  if (!Array.isArray(items)) throw new Error('Invalid ChatGPT conversation list')
  return items.slice(0, 100).flatMap((raw) => {
    const item = record(raw)
    if (!item || typeof item.id !== 'string' || !CONVERSATION_ID.test(item.id)) return []
    const updated = item.update_time
    const updatedAt =
      typeof updated === 'string'
        ? updated
        : typeof updated === 'number'
          ? new Date(updated * 1000).toISOString()
          : null
    return [{ id: item.id, title: title(item.title), updatedAt }]
  })
}

type Node = { message: Record<string, unknown> | null; parent: string | null }

function textOf(content: Record<string, unknown>): string | null {
  const type = content.content_type
  if (type !== 'text' && type !== 'multimodal_text') return null
  const parts = Array.isArray(content.parts) ? content.parts : []
  return parts
    .filter((p): p is string => typeof p === 'string')
    .join('\n')
    .trim()
}

/** The messages on the conversation's current branch, oldest first, and where its last turn is. */
export function parseConversation(input: unknown, now = Date.now()): ChatGptConversation {
  const conv = record(input)
  const mapping = record(conv?.mapping)
  if (!conv || !mapping) throw new Error('Invalid ChatGPT conversation')
  const id = typeof conv.conversation_id === 'string' ? conv.conversation_id : ''
  if (!CONVERSATION_ID.test(id)) throw new Error('Invalid ChatGPT conversation')
  const path: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let key = typeof conv.current_node === 'string' ? conv.current_node : null
  while (key && !seen.has(key) && seen.size < 20_000) {
    seen.add(key)
    const node = record(mapping[key]) as Node | null
    if (!node) break
    const message = record(node.message)
    if (message) path.push(message)
    key = typeof node.parent === 'string' ? node.parent : null
  }
  path.reverse()
  const messages: ChatGptMessage[] = []
  for (const m of path) {
    const role = record(m.author)?.role
    const content = record(m.content)
    if ((role !== 'user' && role !== 'assistant') || !content) continue
    if (m.recipient !== undefined && m.recipient !== 'all') continue
    if (record(m.metadata)?.is_visually_hidden_from_conversation) continue
    const text = textOf(content)
    if (!text) continue
    messages.push({
      id: typeof m.id === 'string' ? m.id : String(messages.length),
      role,
      text: text.slice(0, MAX_TEXT),
      createdAt: typeof m.create_time === 'number' ? m.create_time : null,
    })
  }
  return {
    id,
    title: title(conv.title),
    messages: messages.slice(-MAX_MESSAGES),
    state: turnState(path, now),
    truncated: messages.length > MAX_MESSAGES,
  }
}

/** Where the last turn is: nothing running, the model reasoning, writing its answer, or cut short. */
export function turnState(path: Record<string, unknown>[], now = Date.now()): ChatGptTurnState {
  let lastUser = -1
  path.forEach((m, i) => {
    if (record(m.author)?.role === 'user') lastUser = i
  })
  if (lastUser < 0) return 'idle'
  const after = path.slice(lastUser + 1).filter((m) => record(m.author)?.role !== 'system')
  const last = after.at(-1)
  if (!last) {
    const asked = path[lastUser]?.create_time
    return typeof asked === 'number' && now - asked * 1000 < PENDING_MS ? 'thinking' : 'stopped'
  }
  const finalAnswer = after.find(
    (m) => record(m.author)?.role === 'assistant' && m.end_turn === true && m.recipient === 'all',
  )
  if (finalAnswer) {
    const finish = record(record(finalAnswer.metadata)?.finish_details)?.type
    return finalAnswer.status === 'finished_partial_completion' || finish === 'interrupted'
      ? 'stopped'
      : 'idle'
  }
  if (last.status === 'in_progress') {
    const type = record(last.content)?.content_type
    return type === 'thoughts' || type === 'reasoning_recap' || last.recipient !== 'all'
      ? 'thinking'
      : 'generating'
  }
  if (last.status === 'finished_partial_completion' || last.status === 'finished_with_error')
    return 'stopped'
  // Between steps (a tool call answered, the next step not started): still at work for a while.
  const at = typeof last.create_time === 'number' ? last.create_time * 1000 : 0
  return now - at < PENDING_MS ? 'thinking' : 'stopped'
}
