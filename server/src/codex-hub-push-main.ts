// Pushes this PC's Codex chats to a Codex hub (core/codex-hub.ts) without running the daemon:
//   AGENTHYDRA_CODEX_HUB_URL=https://hub.example.test AGENTHYDRA_CODEX_HUB_TOKEN=... bun server/src/codex-hub-push-main.ts [--once]
// Optional: AGENTHYDRA_CODEX_HUB_PC (default: this computer's name), AGENTHYDRA_CODEX_HUB_HEADERS
// (a JSON object of extra headers), AGENTHYDRA_CODEX_HUB_INTERVAL_MIN (default 2), AGENTHYDRA_CODEX_PATH,
// AGENTHYDRA_CODEX_HUB_RELAY (codex-hub-relay-pc.ts), AGENTHYDRA_CODEX_HUB_UPDATE, AGENTHYDRA_CODEX_HUB_UPDATE_KEY and
// AGENTHYDRA_CODEX_HUB_RESTART (codex-hub-update.ts).
// Its install id is kept apart from the daemon pusher's (codex-hub-push.ts PUSHER_INSTALL_FILES).
// HOST is ignored: the pusher binds no port. Its module has to stay the first import.
import { callerHost } from './codex-hub-push-host'
import { codexHubPushConfig, pushCodexHubOnce, startCodexHubPusher } from './core/codex-hub-push'
import {
  PUSHER_BANNER,
  removeOldBuild,
  selfUpdateOn,
  startSelfUpdate,
} from './core/codex-hub-update'

if (callerHost !== undefined) process.env.HOST = callerHost

// How an update checks that a downloaded build starts before it takes this one's place.
if (process.argv.includes('--version')) {
  console.log(PUSHER_BANNER)
  process.exit(0)
}

const cfg = codexHubPushConfig('standalone')
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
// The compiled pusher keeps itself at the hub's build, so a PC is installed once.
if (selfUpdateOn()) {
  removeOldBuild()
  startSelfUpdate(cfg)
}
startCodexHubPusher(cfg)
