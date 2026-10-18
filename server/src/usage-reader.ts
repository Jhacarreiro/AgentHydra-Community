// server/src/usage-reader.ts: which request or timer a usage reading was taken for.
//
// Every reading lands in usage_samples with its reader (usage-history.ts), so a burst of readings can
// be traced to what asked for it. 2026-10-15, 00:47 UTC: 25 of 30 CLI logins were read again 85-150 s
// after a full read, and nothing recorded who read them. An HTTP request is labelled by its method,
// path and client (index.ts). A timer names itself with asReader: a timer armed inside a request
// would otherwise carry that request's label into every later run.

import { AsyncLocalStorage } from 'node:async_hooks'

const store = new AsyncLocalStorage<string>()

/** Run `fn` with `reader` as the label of every usage reading it takes; an inner label wins. */
export function asReader<T>(reader: string, fn: () => T): T {
  return store.run(reader, fn)
}

/** The label of the request or timer running now, or null outside any. */
export function usageReader(): string | null {
  return store.getStore() ?? null
}

/** A request's label: "GET /api/usage (Bun)". The client is the user agent's first product token,
 *  which tells the page (Mozilla) from the MCP server and Desk's proxy (Bun) and from scripts (curl). */
export function requestReader(method: string, path: string, userAgent: string | undefined): string {
  const client = userAgent?.trim().split(/[/\s]/, 1)[0] || 'no agent'
  return `${method} ${path.slice(0, 120)} (${client.slice(0, 24)})`
}
