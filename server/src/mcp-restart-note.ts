import { type RunningCodeStatus, restartNeededMessage } from './core/running-code'
import type { McpEngineTool } from './mcp-stdio.mjs'

/** The restart note rides only on the answers that explain a missing tool or route: hydra_find (a
 *  tool may have been added since boot), any call that threw, and any answer reporting a failure. */
export function mcpWithRestartNote(
  tools: McpEngineTool[],
  status: () => RunningCodeStatus,
): McpEngineTool[] {
  return tools.map((t) => ({
    ...t,
    run: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      let value: unknown
      try {
        value = await t.run(args, signal)
      } catch (e) {
        const note = restartNeededMessage(status())
        if (!note) throw e
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n\n${note}`)
      }
      const note =
        t.name === 'hydra_find' || isFailure(value) ? restartNeededMessage(status()) : null
      return note && value && typeof value === 'object' && !Array.isArray(value)
        ? { daemonRestartNeeded: note, ...(value as Record<string, unknown>) }
        : value
    },
  }))
}

function isFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as { ok?: unknown; error?: unknown }
  return v.ok === false || !!v.error
}
