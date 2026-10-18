// Where the Codex CLI is: the same order as AgentHydra's server/src/config.ts resolveCodexExe, which desk2 cannot
// import. CODEX_PATH first, then the newest binary the Codex desktop app installed, then the npm one.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function codexExe(env: Record<string, string | undefined> = process.env): string {
  const configured = env.CODEX_PATH?.trim()
  if (configured) return configured
  const local = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const bin = join(local, 'OpenAI', 'Codex', 'bin')
  // The folders are content hashes: an update leaves the old one beside the new, so the newest binary wins.
  let newest: { path: string; mtime: number } | null = null
  try {
    for (const dir of readdirSync(bin)) {
      const path = join(bin, dir, 'codex.exe')
      const mtime = statSync(path, { throwIfNoEntry: false })?.mtimeMs
      if (mtime !== undefined && (!newest || mtime > newest.mtime)) newest = { path, mtime }
    }
  } catch {
    // no desktop app
  }
  if (newest) return newest.path
  const roaming = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  for (const npm of [join(roaming, 'npm', 'codex.cmd'), join(roaming, 'npm', 'codex')]) if (existsSync(npm)) return npm
  return 'codex'
}
