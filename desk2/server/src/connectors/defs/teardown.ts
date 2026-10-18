// The Teardown connector (upstream morluto/rea): morluto/rea, a reverse-engineering MCP server with about 170 tools for web apps, binaries, APKs and
// runtimes (npm package rea-agents). Desk installs nothing; it finds Teardown where it is and gives every chat its tools
// while it is there. Teardown is found in one of two places:
// - AgentHydra's shared MCP hub serves an entry named `teardown` (server/src/mcp-hub.ts). The daemon answers a POST to
//   <daemon>/api/mcp/shared/teardown with 404 for a name it does not serve, before any child starts; a ping there proves it
//   serves one, and chats get that URL.
// - A `rea` command is on PATH (npm i -g rea-agents): chats get `rea mcp` over stdio, under the server key `teardown`.
// An account's own `teardown` server wins over this one by name, as it does for every connector (chat-runtime.ts).

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { createClient } from '../../bridge/client'
import type { ConnectorDef, ConnectorFactory } from '../types'
import { whichOnce } from '../release'

const NAME = 'teardown'
const CLI = 'rea' // upstream's command name
const PROBE_MS = 1500
const INSTALL = 'Not installed: npm i -g rea-agents (github.com/morluto/rea)'

const PROMPT =
  'Teardown is available: reverse-engineering tools for web apps, binaries, APKs and runtimes. To see what a competitor\'s web app ships, open it with browser_navigate {url, profile}, read the debugging port from browser_status, then call mcp__teardown__list_browser_targets {cdp_endpoint: "http://127.0.0.1:<port>"} and mcp__teardown__analyze_web_bundle {cdp_endpoint, target_id, include_script_sources: true}. A big answer comes back as a saved_to file plus an evidence_id: read it in parts. Learn features only and copy no code or assets. Never run `rea setup` or `rea update`: they rewrite every agent\'s config.'

/** The hub URL for Teardown when the daemon serves an entry named teardown, else null. */
async function hubUrl(): Promise<string | null> {
  const url = `${createClient().url}/api/mcp/shared/${NAME}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      signal: AbortSignal.timeout(PROBE_MS)
    })
    if (!res.ok) return null
    const body = (await res.json()) as { result?: unknown }
    return body.result === undefined ? null : url
  } catch {
    return null
  }
}

const factory: ConnectorFactory = (): ConnectorDef => ({
  info: {
    id: 'teardown',
    name: 'Teardown',
    blurb: "Reverse-engineering tools for web apps, binaries, APKs and runtimes, so a chat can learn what a competitor's app ships.",
    homepage: 'https://github.com/morluto/rea',
    installable: false,
    pane: false
  },
  async detect() {
    const url = await hubUrl()
    if (url) return { state: 'running', url, version: null }
    if (whichOnce(CLI)) return { state: 'running', url: null, version: null }
    return { state: 'absent', url: null, version: null, reason: INSTALL }
  },
  chat(_cwd, status) {
    if (status.state !== 'running') return null
    const server: McpServerConfig = status.url
      ? { type: 'http', url: status.url }
      : { type: 'stdio', command: CLI, args: ['mcp'] }
    return { mcpServers: { [NAME]: server }, prompt: PROMPT }
  }
})

export default factory
