// Loads the owners' private page price checker when its checkout is present; without it, AgentHydra has no price check tools.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_ROOT } from './config'
import { api, type HydraTool, JSON_HEADERS, MCP_CALL_BUDGET_MS } from './mcp-client'
import { folderOf } from './mcp-dashboards'

export interface PriceCheckHost {
  folderOf: (args: Record<string, unknown>) => Promise<{ cwd: string }>
  postDashboard: (body: unknown) => Promise<unknown>
  callBudgetMs: number
}

const postDashboard = (body: unknown) =>
  api('/api/dashboards/workspace', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })

const LIVE_HOST: PriceCheckHost = { folderOf, postDashboard, callBudgetMs: MCP_CALL_BUDGET_MS }

export function priceCheckDir(): string {
  return process.env.PRICECHECK_DIR || join(APP_ROOT, '..', 'sue-dredd', 'pricecheck')
}

export async function loadPriceCheckTools(
  dir: string,
  host: PriceCheckHost = LIVE_HOST,
): Promise<HydraTool[]> {
  const file = join(dir, 'mcp', 'tools.mjs')
  if (!existsSync(file)) return []
  try {
    const mod = await import(pathToFileURL(file).href)
    if (typeof mod.priceCheckTools !== 'function')
      throw new Error('mcp/tools.mjs exports no priceCheckTools')
    return (mod.priceCheckTools(host) as HydraTool[]).map(
      ({ name, description, inputSchema, listed, callerChat, run }) => ({
        name,
        description,
        inputSchema,
        listed,
        callerChat,
        run,
      }),
    )
  } catch (err) {
    console.error(`[agenthydra] price check tools not loaded from ${dir}: ${String(err)}`)
    return []
  }
}

export const PRICECHECK_TOOLS: HydraTool[] = await loadPriceCheckTools(priceCheckDir())
