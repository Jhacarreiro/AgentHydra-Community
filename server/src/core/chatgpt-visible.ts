/** Ephemeral, read-only ChatGPT browser view. The upstream account stays authoritative.
 * No background sync, persistent store, credentials, or automated sends.
 */
export type ChatGptVisibleMessage = { role: 'user' | 'assistant'; text: string }
export type ChatGptVisibleView = { visibleTurnCount: number; messages: ChatGptVisibleMessage[] }

/** A browser reader supplies an untrusted ephemeral payload; reject malformed content. */
export function parseChatGptVisibleView(input: unknown): ChatGptVisibleView {
  if (!input || typeof input !== 'object') throw new Error('Invalid ChatGPT view')
  const record = input as Record<string, unknown>
  if (!Number.isSafeInteger(record.visibleTurnCount) || Number(record.visibleTurnCount) < 0 || !Array.isArray(record.messages)) {
    throw new Error('Invalid ChatGPT view shape')
  }
  if (record.messages.length > 1000) throw new Error('ChatGPT view too large')
  const messages: ChatGptVisibleMessage[] = record.messages.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid ChatGPT message')
    const message = item as Record<string, unknown>
    if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string' || message.text.length > 250_000) {
      throw new Error('Invalid ChatGPT message')
    }
    return { role: message.role, text: message.text }
  })
  return { visibleTurnCount: record.visibleTurnCount as number, messages }
}

/** Execute an explicitly requested read using the Hub's future authorized transport.
 * The caller supplies the transport; this does not open SSH, expose CDP, or cache messages.
 */
export async function readChatGptThroughHub(readFromBrowser: () => Promise<unknown>): Promise<ChatGptVisibleView> {
  return parseChatGptVisibleView(await readFromBrowser())
}
