/** On-demand ChatGPT browser read, run locally on the Hub's host (e.g. Dark).
 * No network server, account tokens, session files, or background polling.
 * The OpenCLI bridge must already be attached to an authenticated browser.
 */
import { execFileSync } from 'node:child_process'

const cli = process.env.AGENTHYDRA_CHATGPT_OPENCLI || 'opencli'
const profile = process.env.AGENTHYDRA_CHATGPT_BROWSER_SESSION || 'chatgpt'
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw Error('Invalid browser session')
const options = { encoding: 'utf8', timeout: 5_000, maxBuffer: 256 * 1024 }
const tabs = JSON.parse(execFileSync(cli, ['browser', profile, 'tab', 'list'], options))
if (!Array.isArray(tabs)) throw Error('Invalid browser tab list')
const matching = tabs.filter((t) =>
  typeof t?.url === 'string' && t.url.startsWith('https://chatgpt.com/') &&
  typeof t.page === 'string' && /^[0-9a-f]{32}$/i.test(t.page),
)
const tab = matching.find((t) => t.active) || matching[0]
if (!tab) throw Error('No ChatGPT tab is open')
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
const result = execFileSync(cli, ['browser', profile, 'eval', '--tab', tab.page, expression], {
  ...options, maxBuffer: 1024 * 1024,
})
const view = JSON.parse(result)
if (!Number.isSafeInteger(view?.visibleTurnCount) || !Array.isArray(view?.messages))
  throw Error('Invalid visible conversation')
process.stdout.write(JSON.stringify(view) + '\n')
