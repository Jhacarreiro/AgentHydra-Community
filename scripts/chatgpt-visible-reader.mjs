/**
 * Experimental DOM reader for an already-open ChatGPT conversation.
 * Runs in browser page context; does not send prompts, call private APIs,
 * read browser credentials or persist messages. Not a background scraper.
 * The ChatGPT DOM is undocumented and subject to breaking changes.
 */
export function readVisibleChatGptConversation(doc = document) {
  const turns = [...doc.querySelectorAll('[data-turn-key]')]
  const messages = []
  for (const turn of turns) {
    const user = turn.querySelector('[data-user-message-bubble]')
    const assistant = turn.querySelector('[data-conversation-role="assistant"]')
    for (const [role, element] of [['user', user], ['assistant', assistant]]) {
      if (!element) continue
      const text = (element.innerText || element.textContent || '').trim()
      if (text) messages.push({ role, text })
    }
  }
  return { visibleTurnCount: turns.length, messages }
}

/** Diagnostics safe to log: never include message content or conversation IDs. */
export function summarizeVisibleChatGptConversation(result) {
  return {
    visibleTurns: result.visibleTurnCount,
    userMessages: result.messages.filter((m) => m.role === 'user').length,
    assistantMessages: result.messages.filter((m) => m.role === 'assistant').length,
  }
}
