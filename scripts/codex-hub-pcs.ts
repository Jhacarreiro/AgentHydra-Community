#!/usr/bin/env bun
// scripts/codex-hub-pcs.ts — lists a Codex hub's PCs, gives one a token, revokes one, or forgets one.
//
// Each PC on a hub has a token of its own (server/src/core/codex-hub-pcs.ts). The tray gets one through the hub's
// pairing page; a PC without a desktop, a daemon's pusher or a standalone one gets one here. This runs on the hub,
// against its loopback, with the owner's admin token from hub.env (the admin API, /api/codex-relay/admin/pcs), the
// way the signing script works on the builds: never through the forward PCs reach the hub by.
//
//   bun --env-file ~/.config/codex-hub/hub.env scripts/codex-hub-pcs.ts list [--json]
//   bun --env-file ~/.config/codex-hub/hub.env scripts/codex-hub-pcs.ts add <pc> [--replace] [--json]
//   bun --env-file ~/.config/codex-hub/hub.env scripts/codex-hub-pcs.ts revoke <pc>
//   bun --env-file ~/.config/codex-hub/hub.env scripts/codex-hub-pcs.ts forget <pc>
//     --hub <url>   default http://127.0.0.1:$PORT, else http://127.0.0.1:7787
//
// `add` makes the token here, registers only its id and SHA-256, and prints the token alone on stdout (with --json,
// `{ token, pc, key, id }`). Put it in the PC's tray.json as {"token": "..."}, keeping "hub" if the file has one, or
// in its pusher's AGENTHYDRA_CODEX_HUB_TOKEN, and use it at once: until its first request with an install id, whoever
// uses it first binds it. A name that has a token, or is still on the old shared token, is replaced only with
// --replace. `revoke` stops a PC at once and keeps its copies; `forget` also removes its copies and its record.
// <pc> is a name or a key: revoke and forget take its key, add keeps the name as typed.

import { randomBytes } from 'node:crypto'
import { CONTROL, hubPcKey, isHubPcKey, pcTokenHash } from '../server/src/core/codex-hub-ids'

const USAGE = `usage: bun --env-file <hub.env> scripts/codex-hub-pcs.ts list [--json]
       bun --env-file <hub.env> scripts/codex-hub-pcs.ts add <pc> [--replace] [--json]
       bun --env-file <hub.env> scripts/codex-hub-pcs.ts revoke <pc>
       bun --env-file <hub.env> scripts/codex-hub-pcs.ts forget <pc>
  --hub <url>   default http://127.0.0.1:$PORT, else http://127.0.0.1:7787`

function fail(text: string): never {
  console.error(text)
  process.exit(1)
}

interface Row {
  key: string
  pc: string
  state: string
  why?: string
  tokenId?: string
  pairedAt?: string
  pairedBy?: string
  pairedFrom?: string
  firstUsedAt?: string
  revokedAt?: string
  revokedWhy?: string
  contestedAt?: string
  install?: string
  pushedAt?: string
  chats: number
  relay: boolean
}

interface List {
  legacy: { open: boolean; since?: string; until?: string; pending: number }
  pcs: Row[]
}

const args = process.argv.slice(2)
const flags = new Set<string>(args.filter((a) => a === '--json' || a === '--replace'))
const at = args.indexOf('--hub')
const hubArg = at === -1 ? undefined : args[at + 1]
if (at !== -1 && !hubArg) fail(USAGE)
const words = args.filter((a, i) => !flags.has(a) && a !== '--hub' && !(at !== -1 && i === at + 1))
const [command, name, ...extra] = words
if (!command || extra.length) fail(USAGE)

const hub = (hubArg ?? `http://127.0.0.1:${process.env.PORT?.trim() || '7787'}`).replace(/\/+$/, '')
const admin = (
  process.env.AGENTHYDRA_CODEX_HUB_TOKEN ?? process.env.CCMANAGERUI_CODEX_HUB_TOKEN
)?.trim()
if (!admin)
  fail('AGENTHYDRA_CODEX_HUB_TOKEN is not set: run this with --env-file pointing at hub.env')

/** A line as the terminal gets it: a control character in a name or a reason (C0, DEL or C1) is printed escaped. */
const shown = (line: string): string =>
  line.replace(
    new RegExp(CONTROL.source, 'gu'),
    (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  )

const when = (iso: string | undefined): string =>
  iso && Number.isFinite(Date.parse(iso))
    ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : 'never'

/** One request to the admin API; its JSON, or the reason it failed, said for the owner. */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${hub}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${admin}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    fail(`the hub is not running at ${hub}`)
  }
  const text = await res.text()
  let answer: { error?: string; code?: string } & Record<string, unknown> = {}
  try {
    answer = JSON.parse(text)
  } catch {
    // not JSON: said below with the status
  }
  if (res.status === 401)
    fail('the hub refused the admin token: run this with --env-file pointing at hub.env')
  if (res.status === 404 && answer.code === 'hub-off')
    fail(`the hub at ${hub} is off: AGENTHYDRA_CODEX_HUB_TOKEN is not set where it runs`)
  if (!res.ok)
    fail(
      `the hub answered ${res.status}${answer.code ? ` ${answer.code}` : ''}: ${answer.error ?? text.slice(0, 200)}`,
    )
  return answer as T
}

/**
 * The key a revoke or forget is for: the PC's name made a key, or a key as it is. The two differ only for a key that
 * the cut at 63 characters left ending in a dash, which hubPcKey would trim: then the list says which of the two the
 * hub has, and a hub with both is asked about neither.
 */
async function keyOf(pc: string | undefined): Promise<string> {
  const made = pc ? hubPcKey(pc) : null
  if (!pc || !made) fail(USAGE)
  if (made === pc || !isHubPcKey(pc)) return made
  const list = await call<List>('GET', '/api/codex-relay/admin/pcs')
  const keys = new Set(list.pcs.map((r) => r.key))
  if (keys.has(pc) && keys.has(made))
    fail(
      `${pc} is a PC's key on this hub and also the name of ${made}: say which one, with the admin API ` +
        '(docs/REFERENCE.md, the Codex hub)',
    )
  return keys.has(pc) ? pc : made
}

if (command === 'list' && !name) {
  const list = await call<List>('GET', '/api/codex-relay/admin/pcs')
  if (flags.has('--json')) {
    console.log(JSON.stringify(list, null, 2))
  } else {
    const { legacy } = list
    console.log(
      `legacy window: ${
        legacy.open
          ? `open until ${when(legacy.until)}, ${legacy.pending} pending`
          : legacy.until
            ? `closed on ${when(legacy.until)}`
            : 'off'
      }`,
    )
    for (const r of list.pcs)
      console.log(
        shown(
          [
            // The key too where the name does not make it, which revoke and forget then take.
            hubPcKey(r.pc) === r.key ? r.pc : `${r.pc} (key ${r.key})`,
            `${r.state}${r.why ? ` (${r.why})` : ''}`,
            r.tokenId ? `chp_${r.tokenId}` : '-',
            r.pairedAt
              ? `paired ${when(r.pairedAt)} by ${r.pairedBy}${r.pairedFrom ? ` from ${r.pairedFrom}` : ''}`
              : 'not paired',
            `first used ${when(r.firstUsedAt)}`,
            `last push ${when(r.pushedAt)}`,
            `relay ${r.relay ? 'on' : 'off'}`,
            `install ${r.install ? `${r.install.slice(0, 8)}…` : '-'}`,
            ...(r.revokedAt ? [`revoked ${when(r.revokedAt)}: ${r.revokedWhy}`] : []),
            ...(r.contestedAt ? [`CONTESTED ${when(r.contestedAt)}`] : []),
          ].join('  '),
        ),
      )
  }
} else if (command === 'add' && name) {
  // Made here, as the tray makes one on the PC: the hub is sent only its id and hash.
  const id = randomBytes(8).toString('hex')
  const token = `chp_${id}_${randomBytes(32).toString('hex')}`
  const added = await call<{ pc: string; key: string; id: string }>(
    'POST',
    '/api/codex-relay/admin/pcs',
    { pc: name, id, hash: pcTokenHash(token), replace: flags.has('--replace') },
  )
  console.log(flags.has('--json') ? JSON.stringify({ token, ...added }) : token)
  console.error(
    `${added.pc} has a token of its own on the hub (chp_${added.id}). Put it in that PC's tray.json as ` +
      '{"token": "<the token>"}, keeping "hub" if the file has one, or in its pusher\'s ' +
      'AGENTHYDRA_CODEX_HUB_TOKEN, and use it at once: its first request with an install id binds it.',
  )
} else if (command === 'revoke' && name) {
  const key = await keyOf(name)
  const r = await call<{ pc: string; relayClosed: boolean }>(
    'POST',
    `/api/codex-relay/admin/pcs/${key}/revoke`,
  )
  console.log(
    shown(
      `${r.pc} revoked${r.relayClosed ? '; its relay closed' : ''}. Its copies stay until you forget it.`,
    ),
  )
} else if (command === 'forget' && name) {
  const key = await keyOf(name)
  const r = await call<{ pc: string }>('DELETE', `/api/codex-relay/admin/pcs/${key}`)
  console.log(shown(`${r.pc} forgotten: its token and its copies are gone from the hub.`))
} else {
  fail(USAGE)
}
