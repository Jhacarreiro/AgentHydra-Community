// Pushes this PC's Codex chats to a Codex hub (core/codex-hub.ts) without running the daemon:
//   AGENTHYDRA_CODEX_HUB_URL=https://hub.example.test AGENTHYDRA_CODEX_HUB_TOKEN=... bun server/src/codex-hub-push-main.ts [--once]
// Optional: AGENTHYDRA_CODEX_HUB_PC (default: this computer's name), AGENTHYDRA_CODEX_HUB_HEADERS
// (a JSON object of extra headers), AGENTHYDRA_CODEX_HUB_INTERVAL_MIN (default 2), AGENTHYDRA_CODEX_PATH.
import { codexHubPushConfig, pushCodexHubOnce, startCodexHubPusher } from './core/codex-hub-push'

const cfg = codexHubPushConfig()
if (!cfg) {
  console.error('Set AGENTHYDRA_CODEX_HUB_URL and AGENTHYDRA_CODEX_HUB_TOKEN.')
  process.exit(2)
}
if (process.argv.includes('--once')) {
  const r = await pushCodexHubOnce(cfg)
  console.log(
    `${cfg.pc}: ${r.threads} chats listed, ${r.sent} rollouts sent, ${r.missing} still missing`,
  )
  process.exit(r.missing ? 1 : 0)
}
startCodexHubPusher(cfg)
