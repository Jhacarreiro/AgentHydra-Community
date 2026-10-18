// server/src/core/codex-hub-ids.ts — the shapes a Codex hub and the programs that talk to it share.
//
// A PC's key is its folder on the hub and the one name it is kept under (codex-hub.ts); a PC token is the secret
// that PC alone holds (codex-hub-pcs.ts). The tray (codex-hub-tray/token.go) and scripts/codex-hub-pcs.ts make and
// read the same shapes, and codex-hub-tray/testdata/pckey.json holds the key cases every copy must agree on.
//
//   chp_<16 hex: the token id>_<64 hex: the secret>
//
// Only a client makes a token: the tray on the PC, or the command line on the hub for a PC without one. The hub is
// sent the id and the SHA-256 of the whole token, and keeps only those.
//
// Nothing here reads the configuration, so the command line can load this module on its own.

import { createHash } from 'node:crypto'

const PC_MAX = 63

/** A PC token: the first group is its id. */
export const PC_TOKEN = /^chp_([0-9a-f]{16})_[0-9a-f]{64}$/

/** Whether `value` is shaped like a PC token (an admin or legacy token never is). */
export function isPcToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && PC_TOKEN.test(value)
}

/** A PC token's id, or null for what is not one. */
export function pcTokenId(token: string): string | null {
  return PC_TOKEN.exec(token)?.[1] ?? null
}

/** What the hub keeps of a token: the SHA-256 of its UTF-8, lowercase hex. */
export function pcTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** The folder name for a PC: its name lowercased to letters, digits and dashes. */
export function hubPcKey(pc: string): string | null {
  const key = pc
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PC_MAX)
  return key || null
}
