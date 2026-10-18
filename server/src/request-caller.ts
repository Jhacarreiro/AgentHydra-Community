// server/src/request-caller.ts - which process sent an HTTP request, and the chat that process runs under.
//
// Over HTTP the daemon cannot read its caller from its own process, but the socket knows: Bun hands the route
// the peer's port, and the OS connection table names the pid that opened it (core/process.ts). The MCP routes
// bind that pid for their identity tools (index.ts); the CliMayte dispatch routes use it to record the chat a
// script was run from (routes/climayte.ts).

import type { CallerChatOrigin } from './mcp-self'

/** The pid of the process that sent this request, or null when it cannot be told. Bun exposes the
 *  peer address through the server object Hono passes as `c.env`; everything after that is the OS
 *  connection table. Every failure answers null - "could not tell" is a fine answer here, and a
 *  guessed pid would become a confidently wrong identity. */
export async function requestCallerPid(c: {
  env: unknown
  req: { raw: Request }
}): Promise<number | null> {
  try {
    const server = c.env as { requestIP?: (r: Request) => { port?: number } | null } | null
    const port = typeof server?.requestIP === 'function' ? server.requestIP(c.req.raw)?.port : null
    if (!port) return null
    const { pidOwningLocalPort } = await import('./core/process')
    return await pidOwningLocalPort(Number(port))
  } catch {
    return null
  }
}

/** How long a plain-HTTP dispatch waits to learn which chat sent it before it goes on without one. The
 *  lookup is an in-process table read and a walk of the live session registries. */
export const REQUEST_ORIGIN_BUDGET_MS = 5_000

/** The chat a plain HTTP request came from: the request's process and its ancestors, matched against
 *  the live Claude session registries by the same walk the MCP tools use (mcp-self.ts callerOrigin).
 *
 *  WHY (owner, 2026-10-12): a chat's script posted about 60 workers to /api/corch/workers with no
 *  origin, and neither the CliMayte table nor Desk's sidebar could say which thread ran them: "it
 *  doesn't specify what OG thread ran it". This daemon's own requests are never traced (it is no
 *  chat's process). Never throws. */
export async function requestCallerOrigin(
  c: { env: unknown; req: { raw: Request } },
  budgetMs = REQUEST_ORIGIN_BUDGET_MS,
): Promise<
  | { origin: CallerChatOrigin; why: null; pid: number | null }
  | { origin: null; why: string; pid: number | null }
> {
  // The budget covers the pid lookup too: off Windows it shells out to lsof, which can take seconds.
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const pid = await Promise.race([
    requestCallerPid(c),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs)
    }),
  ]).finally(() => clearTimeout(timer))
  if (pid === null)
    return {
      origin: null,
      why: 'no origin was sent, and the calling process could not be traced',
      pid: null,
    }
  if (pid === process.pid) return { origin: null, why: 'no origin was sent', pid }
  const { CALLER_PID_ARG, callerOrigin } = await import('./mcp-self')
  const r = await callerOrigin(
    { [CALLER_PID_ARG]: async () => pid },
    Math.max(1, budgetMs - (Date.now() - started)),
  )
  if (!r.origin) return { origin: null, why: `no origin was sent, and ${r.why}`, pid }
  return {
    origin: { ...r.origin, how: `traced from the HTTP request: ${r.origin.how}`.slice(0, 300) },
    why: null,
    pid,
  }
}
