// Which of the owner's Codex accounts a pinned chat's new thread starts on. AgentHydra owns the accounts
// (GET /api/codex-instances) and reads their usage (GET /api/codex-instances/:id/usage, its cached reading: a fresh
// one would refresh the login beside the app-server Desk holds). Desk only picks.

import type { AhCodexInstance, AhCodexUsage, HydraClient } from '../../bridge/client'
import { relayHome } from './app-server'

/**
 * A Codex account a chat can run on: AgentHydra's instance id, the label the window shows, its CODEX_HOME. Another
 * PC's Codex (`relay`) has no home here: `home` names it for app-server.ts, which reaches it through the hub.
 */
export interface CodexAccount {
  id: string
  label: string
  home: string
  relay?: boolean
}

/** What Desk reads of AgentHydra's Codex accounts. */
export interface CodexDirectory {
  instances(): Promise<AhCodexInstance[]>
  usage(id: string): Promise<AhCodexUsage | null>
}

export type CodexPick = { account: CodexAccount } | { why: string }

/** Another PC's Codex behind the hub: its id is the hub's `hub:<pc>`, which no account of this machine has. */
export const isRelayAccount = (id: string): boolean => id.startsWith('hub:')

/** Why a chat on another PC's Codex cannot go on now: that PC's relay is not open. */
export const notConnected = (pc: string): string =>
  `${pc} is not connected to the Codex hub now (it is off, or its pusher is not running), so this chat cannot continue here.`

/** The directory through AgentHydra's API: this machine's accounts, then every PC behind its Codex hub. */
export function codexDirectory(client: Pick<HydraClient, 'codexInstances' | 'codexUsage' | 'codexRelayPcs'>): CodexDirectory {
  return {
    instances: async () => {
      const [own, pcs] = await Promise.all([client.codexInstances(), client.codexRelayPcs()])
      return [...own, ...pcs.map((p) => ({ id: p.id, name: p.pc, codexHome: relayHome(p.id), loggedIn: p.relay, relay: true }))]
    },
    usage: (id) => (isRelayAccount(id) ? Promise.resolve(null) : client.codexUsage(id).catch(() => null)),
  }
}

export function codexAccount(i: AhCodexInstance): CodexAccount {
  const name = i.name?.trim()
  return {
    id: i.id,
    label: typeof i.num === 'number' ? `#${i.num}${name ? ` ${name}` : ''}` : (name ?? i.id),
    home: i.codexHome,
    ...(i.relay ? { relay: true } : {}),
  }
}

/** The fuller of an account's 5-hour and weekly windows, in percent, and when a full one frees up; null when unread. */
export function fullness(u: AhCodexUsage | null, now: number): { pct: number; freesAt: number | null } | null {
  const windows = [u?.snapshot?.session, u?.snapshot?.weekAll].filter((w): w is { pct?: number; resetsAt?: string } => !!w && typeof w.pct === 'number')
  if (!windows.length) return null
  let pct = 0
  let freesAt: number | null = null
  for (const w of windows) {
    const reset = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN
    // A window whose reset has passed is empty again, whatever the cached reading says.
    const p = Number.isFinite(reset) && reset <= now ? 0 : (w.pct ?? 0)
    if (p >= 100 && Number.isFinite(reset)) freesAt = Math.max(freesAt ?? 0, reset)
    pct = Math.max(pct, p)
  }
  return { pct, freesAt }
}

/**
 * The account a new thread starts on: signed in, not one this message already failed on (`avoid`), not held after
 * a usage limit (`held`, until when), not full. Of those, one whose Codex app is closed first (the app refreshes the
 * same login), then the emptiest; an account whose usage is unread counts as half full.
 */
export async function pickCodexAccount(dir: CodexDirectory, avoid: ReadonlySet<string>, held: ReadonlyMap<string, number>, now: number): Promise<CodexPick> {
  let instances: AhCodexInstance[]
  try {
    instances = await dir.instances()
  } catch {
    return { why: 'AgentHydra is not answering, so Desk cannot see the Codex accounts.' }
  }
  // Another PC's Codex only goes on with that PC's own chats: a new thread never starts there.
  const signedIn = instances.filter((i) => i.loggedIn && !i.relay)
  if (!signedIn.length) return { why: 'No Codex account is signed in. Sign one in on AgentHydra’s Codex page.' }
  const open = signedIn.filter((i) => !avoid.has(i.id) && (held.get(i.id) ?? 0) <= now)
  const read = await Promise.all(open.map(async (i) => ({ i, full: fullness(await dir.usage(i.id).catch(() => null), now) })))
  const room = read.filter((r) => (r.full?.pct ?? 50) < 100)
  if (!room.length) {
    const frees = [...read.flatMap((r) => (r.full?.freesAt ? [r.full.freesAt] : [])), ...signedIn.flatMap((i) => (held.has(i.id) ? [held.get(i.id)!] : []))].filter((t) => t > now)
    const first = frees.length ? Math.min(...frees) : null
    return { why: `Every Codex account is at its usage limit${first ? ` (the first frees at ${new Date(first).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : ''}.` }
  }
  room.sort((a, b) => Number(!!a.i.isDesktopRunning) - Number(!!b.i.isDesktopRunning) || (a.full?.pct ?? 50) - (b.full?.pct ?? 50))
  return { account: codexAccount(room[0]!.i) }
}
