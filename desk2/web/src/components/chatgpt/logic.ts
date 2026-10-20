// The ChatGPT screen's rules, apart from the page so they can be tested.

export type TurnState = 'idle' | 'thinking' | 'generating' | 'stopped'
export type Summary = { id: string; title: string; updatedAt: string | null }
export type Message = { id: string; role: 'user' | 'assistant'; text: string; createdAt: number | null }
export type Conversation = { id: string; title: string; messages: Message[]; state: TurnState; truncated: boolean; busy?: boolean }

export const running = (state: TurnState | undefined): boolean => state === 'thinking' || state === 'generating'

export const STATE_WORDS: Record<TurnState, string> = {
  idle: 'Answered',
  thinking: 'Thinking…',
  generating: 'Writing…',
  stopped: 'Stopped before the end',
}

/** How soon to read the open conversation again: often while ChatGPT works on it, rarely once it is answered. */
export function nextReadMs(state: TurnState | undefined, sentAt: number | null, now = Date.now()): number {
  if (running(state)) return 2_000
  // Just sent: the answer may not have started yet.
  if (sentAt !== null && now - sentAt < 60_000) return 2_000
  return 20_000
}

const CODES: Record<string, string> = {
  CHATGPT_TRANSPORT_UNAVAILABLE: 'ChatGPT is not turned on for this AgentHydra.',
  CHATGPT_BRIDGE_UNAVAILABLE: "The browser bridge isn't answering.",
  CHATGPT_SIGNED_OUT: 'ChatGPT is signed out in the bridge window.',
  CHATGPT_NOT_FOUND: "That conversation wasn't found.",
  CHATGPT_NOT_OPEN: 'That conversation is not the one open in the bridge window.',
  CHATGPT_COMPOSER_UNAVAILABLE: "ChatGPT didn't take the message. Check the conversation before sending it again.",
  CHATGPT_BAD_MESSAGE: 'Write a message first.',
}
export const errorWords = (code: unknown): string =>
  (typeof code === 'string' && CODES[code]) || 'ChatGPT is temporarily unavailable.'

/** "5 min", "3 h", "2 d": how long ago a conversation last changed. */
export function ago(iso: string | null, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(at)) return ''
  const min = Math.max(0, Math.round((now - at) / 60_000))
  if (min < 1) return 'now'
  if (min < 60) return `${min} min`
  const h = Math.round(min / 60)
  return h < 24 ? `${h} h` : `${Math.round(h / 24)} d`
}
