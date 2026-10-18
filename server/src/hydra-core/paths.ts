import { homedir } from 'node:os'
import { join } from 'node:path'

const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function coreDir(): string {
  return process.env.AGENTHYDRA_CORE_DIR?.trim() || join(homedir(), '.agenthydra', 'core')
}

export function chatKeyOk(raw: string): boolean {
  return KEY.test(raw.trim())
}

export function chatKey(raw: string): string {
  const key = raw.trim()
  if (!chatKeyOk(key))
    throw new Error('a chat key is letters, digits, - and _ (the key the hook wrote)')
  return key
}

export function chatPaths(dir: string, raw: string) {
  const root = join(dir, 'chats', chatKey(raw))
  return {
    root,
    hydraMd: join(root, 'hydra.md'),
    state: join(root, 'state.json'),
    prompt: join(root, 'prompt.txt'),
    cwd: join(root, 'cwd.txt'),
    sent: join(root, 'sent.json'),
    slot: join(root, 'slot.md'),
    pack: join(root, 'pack.md'),
    placed: join(root, 'placement.json'),
    seats: join(root, 'seats.json'),
  }
}

export function logPath(dir: string): string {
  return join(dir, 'log.jsonl')
}
