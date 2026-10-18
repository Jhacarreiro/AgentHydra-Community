// Every desk2 test file runs in one Bun process, so a global one file swaps (a stand-in document, window, WebSocket or
// fetch) is every later file's until it is put back. On 2026-10-12 the desk store's tests left theirs behind and 286
// tests in later files failed (server/test/preload.ts now names a file that does).

/** Saves the named globals as they are now; returns what puts them back (one that was missing is removed again). */
export function saveGlobals(...names: string[]): () => void {
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  return () => {
    for (const [name, real] of saved) {
      if (real) Object.defineProperty(globalThis, name, real)
      else delete (globalThis as Record<string, unknown>)[name]
    }
  }
}
