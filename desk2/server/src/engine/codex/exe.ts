// Where the Codex CLI is, and the environment it starts in: AgentHydra's own lookup (server/src/config.ts
// resolveCodexExe and codexSpawnEnv), so Desk starts the Codex the daemon does. CODEX_PATH, Desk's own name for it,
// first, then AGENTHYDRA_CODEX_PATH. On Windows the newest binary the Codex desktop app installed, then the npm one;
// on a Mac or Linux PC a codex on PATH, then the places Homebrew, npm, bun, Volta and nvm put it, which a launchd or
// systemd PATH misses. A codex found by path starts with its own folder ahead of PATH, where npm's launcher finds node.

import { resolveCodexExe } from '../../../../../server/src/config'

export { codexSpawnEnv } from '../../../../../server/src/config'

export function codexExe(): string {
  return process.env.CODEX_PATH?.trim() || resolveCodexExe()
}
