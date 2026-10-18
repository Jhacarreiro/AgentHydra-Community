// Core mode, on while the file <core dir>/ON exists. Read fresh on every call. Same code as server/src/hydra-core-mode.ts
// (desk2 cannot import from server/src).
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function coreDir(): string {
  return process.env.AGENTHYDRA_CORE_DIR || join(homedir(), '.agenthydra', 'core')
}

export function coreModeOn(): boolean {
  return existsSync(join(coreDir(), 'ON'))
}

/** Where a chat's pack goes: <core dir>/PLACEMENT, as server/src/hydra-core/placement.ts placementOf reads it. */
export function corePlacement(): 'slot' | 'file' | 'attach' | 'off' {
  try {
    const raw = readFileSync(join(coreDir(), 'PLACEMENT'), 'utf8').trim()
    return raw === 'slot' || raw === 'file' || raw === 'attach' ? raw : 'off'
  } catch {
    return 'off'
  }
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
    console.log('core mode: excludes.json is not a JSON array, so no extra CLAUDE.md excludes for chats')
    return []
  }
  return list.filter((p): p is string => typeof p === 'string' && p.length > 0)
}
