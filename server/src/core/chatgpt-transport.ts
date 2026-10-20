import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { type ChatGptVisibleView, parseChatGptVisibleView } from './chatgpt-visible'

const exec = promisify(execFile)

const expression = `(() => {
  const turns = [...document.querySelectorAll('[data-turn-key]')]
  const messages = []
  if (location.pathname.split('/')[1] !== 'c')
    return JSON.stringify({ visibleTurnCount: 0, messages })
  for (const turn of turns) {
    for (const [role, selector] of [['user','[data-user-message-bubble]'], ['assistant','[data-conversation-role="assistant"]']]) {
      const el = turn.querySelector(selector)
      const text = (el?.innerText || el?.textContent || '').trim()
      if (text) messages.push({ role, text })
    }
  }
  return JSON.stringify({ visibleTurnCount: turns.length, messages })
})()`

/** Read through OpenCLI on the same host as the Hydra Hub, with no SSH or extra service.
 * Commands are fixed and no browser credentials or client-provided code enter this module.
 * Bundled into the server executable, so compiled releases need no separate reader script.
 */
export async function readChatGptLocally(): Promise<ChatGptVisibleView> {
  const cli = process.env.AGENTHYDRA_CHATGPT_OPENCLI || 'opencli'
  const profile = process.env.AGENTHYDRA_CHATGPT_BROWSER_SESSION || 'chatgpt'
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new Error('Invalid browser session')
  const options = { timeout: 5_000, maxBuffer: 1024 * 1024 }
  try {
    const listing = await exec(cli, ['browser', profile, 'tab', 'list'], options)
    const tabs: unknown = JSON.parse(listing.stdout)
    if (!Array.isArray(tabs)) throw new Error('Invalid tab list')
    const matches = tabs.filter(
      (t) =>
        t &&
        typeof t.url === 'string' &&
        t.url.startsWith('https://chatgpt.com/') &&
        typeof t.page === 'string' &&
        /^[0-9a-f]{32}$/i.test(t.page),
    )
    const tab = matches.find((t) => t.active) || matches[0]
    if (!tab) throw new Error('No ChatGPT tab')
    const result = await exec(
      cli,
      ['browser', profile, 'eval', '--tab', tab.page, expression],
      options,
    )
    return parseChatGptVisibleView(JSON.parse(result.stdout))
  } catch {
    // Never log browser output, private conversation contents, or tool errors.
    throw new Error('ChatGPT browser reader unavailable')
  }
}
