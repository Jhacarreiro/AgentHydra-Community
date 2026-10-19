import { spawn } from 'node:child_process'
import { parseChatGptVisibleView, type ChatGptVisibleView } from './chatgpt-visible'

/** Optional operator-owned executable: stdout must be one JSON visible-conversation view.
 * This never accepts browser commands or caller-controlled shell input. The executable and
 * its credentials are private deployment configuration, never part of the public repo.
 */
export async function readChatGptViaOperatorRunner(
  executable: string | undefined = process.env.AGENTHYDRA_CHATGPT_READ_RUNNER,
  timeoutMs = 8000,
): Promise<ChatGptVisibleView> {
  if (!executable || !executable.startsWith('/') || executable.includes('\0'))
    throw new Error('ChatGPT reader not configured')
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH || '/usr/bin:/bin' } })
    const chunks: Buffer[] = []
    let size = 0
    let expired = false
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', (part: Buffer) => {
      size += part.length
      if (size > 1024 * 1024) { child.kill('SIGKILL'); return }
      chunks.push(part)
    })
    child.stderr.resume() // never log potentially sensitive output
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (expired || size > 1024 * 1024 || code !== 0) return reject(new Error('ChatGPT reader unavailable'))
      try { resolve(parseChatGptVisibleView(JSON.parse(Buffer.concat(chunks).toString('utf8')))) }
      catch { reject(new Error('ChatGPT reader returned invalid data')) }
    })
  })
}
