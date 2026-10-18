// server/tests/codex-hub-test-pc.ts — a PC with a token of its own, for the hub tests that run in this process.
//
// Every route a PC calls takes that PC's own token (src/core/codex-hub-pcs.ts), bound to the install id it pushes
// with. testPc makes a token as the tray or the command line makes one, registers its id and hash in the hub's store
// with a fresh install id, and answers the push config that PC's pusher would run with. The test files share one
// hub folder: give each PC a name of its own.
import { randomBytes, randomUUID } from 'node:crypto'
import { CODEX_HUB_DIR } from '../src/core/codex-hub'
import { pcTokenHash } from '../src/core/codex-hub-ids'
import { registerPcToken } from '../src/core/codex-hub-pcs'
import type { CodexHubPushConfig } from '../src/core/codex-hub-push'

/** A new PC token, made at run time as a client makes one: `chp_<16 hex>_<64 hex>`, with its id and hash. */
export function newPcToken(): { token: string; id: string; hash: string } {
  const id = randomBytes(8).toString('hex')
  const token = `chp_${id}_${randomBytes(32).toString('hex')}`
  return { token, id, hash: pcTokenHash(token) }
}

export interface TestPc {
  token: string
  id: string
  hash: string
  /** The install id bound to the token; null for one left unbound, as `add` leaves it. */
  install: string | null
  pc: string
  key: string
  /** What this PC's pusher runs with, against the hub at `url`. */
  cfg(url: string): CodexHubPushConfig
}

/** A PC named `name`, registered in the store under `root` (the routes' hub folder by default). */
export function testPc(
  name: string,
  opts: { root?: string; install?: string | null; replace?: boolean } = {},
): TestPc {
  const made = newPcToken()
  const install = opts.install === undefined ? randomUUID() : opts.install
  const r = registerPcToken(
    { pc: name, id: made.id, hash: made.hash, install, replace: opts.replace },
    opts.root ?? CODEX_HUB_DIR,
  )
  if (!r.ok) throw new Error(`testPc(${name}): ${r.code}: ${r.error}`)
  return {
    ...made,
    install,
    pc: name,
    key: r.key,
    cfg: (url) => ({ url, token: made.token, pc: name, install, headers: {}, intervalMs: 60_000 }),
  }
}
