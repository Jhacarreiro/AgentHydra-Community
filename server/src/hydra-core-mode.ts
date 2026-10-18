// server/src/hydra-core-mode.ts - core mode, on while the file <core dir>/ON exists. Read fresh on every
// call, so a launch always sees the flag as it is now. desk2/server/src/engine/hydra-core-mode.ts is the same code.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function coreDir(): string {
  return process.env.AGENTHYDRA_CORE_DIR || join(homedir(), '.agenthydra', 'core')
}

export function coreModeOn(): boolean {
  return existsSync(join(coreDir(), 'ON'))
}

/** The CLAUDE.md layers a chat skips in core mode: the paths and globs listed in <core dir>/excludes.json. */
export function coreChatExcludes(): string[] {
  if (!coreModeOn()) return []
  let list: unknown
  try {
    list = JSON.parse(readFileSync(join(coreDir(), 'excludes.json'), 'utf8'))
  } catch {
    console.log('core mode: no readable excludes.json, so no extra CLAUDE.md excludes for chats')
    return []
  }
  if (!Array.isArray(list)) {
    console.log(
      'core mode: excludes.json is not a JSON array, so no extra CLAUDE.md excludes for chats',
    )
    return []
  }
  return list.filter((p): p is string => typeof p === 'string' && p.length > 0)
}
