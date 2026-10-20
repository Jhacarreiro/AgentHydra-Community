import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { type ChatGptVisibleView, parseChatGptVisibleView } from './chatgpt-visible'

/** Read from the local OpenCLI browser bridge on the Hub host.
 * No SSH, external executable configured by HTTP clients, or cookies in the Hub.
 */
export async function readChatGptLocally(timeoutMs = 12_000): Promise<ChatGptVisibleView> {
  const script = fileURLToPath(
    new URL('../../../scripts/chatgpt-local-reader.mjs', import.meta.url),
  )
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        AGENTHYDRA_CHATGPT_OPENCLI: process.env.AGENTHYDRA_CHATGPT_OPENCLI || '',
        AGENTHYDRA_CHATGPT_BROWSER_SESSION:
          process.env.AGENTHYDRA_CHATGPT_BROWSER_SESSION || 'chatgpt',
      },
    })
    const chunks: Buffer[] = []
    let size = 0
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (part: Buffer) => {
      size += part.length
      if (size > 1024 * 1024) {
        child.kill('SIGKILL')
        return
      }
      chunks.push(part)
    })
    child.stderr.resume() // never log potentially sensitive output
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (expired || size > 1024 * 1024 || code !== 0)
        return reject(new Error('ChatGPT reader unavailable'))
      try {
        resolve(parseChatGptVisibleView(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
      } catch {
        reject(new Error('ChatGPT reader returned invalid data'))
      }
    })
  })
}
