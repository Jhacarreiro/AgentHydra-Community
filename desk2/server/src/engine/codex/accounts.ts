// Which of the owner's Codex accounts a pinned chat's new thread starts on. AgentHydra owns the accounts
// (GET /api/codex-instances) and reads their usage (GET /api/codex-instances/:id/usage, its cached reading: a fresh
// one would refresh the login beside the app-server Desk holds). Desk only picks.

import type { AhCodexInstance, AhCodexUsage, HydraClient } from '../../bridge/client'

/** A Codex account a chat can run on: AgentHydra's instance id, the label the window shows, its CODEX_HOME. */
export interface CodexAccount {
  id: string
  label: string
  home: string
}

/** What Desk reads of AgentHydra's Codex accounts. */
export interface CodexDirectory {
  instances(): Promise<AhCodexInstance[]>
  usage(id: string): Promise<AhCodexUsage | null>
}

export type CodexPick = { account: CodexAccount } | { why: string }

/** The directory through AgentHydra's API. */
export function codexDirectory(client: Pick<HydraClient, 'codexInstances' | 'codexUsage'>): CodexDirectory {
  return { instances: () => client.codexInstances(), usage: (id) => client.codexUsage(id).catch(() => null) }
}

export function codexAccount(i: AhCodexInstance): CodexAccount {
  const name = i.name?.trim()
  return { id: i.id, label: typeof i.num === 'number' ? `#${i.num}${name ? ` ${name}` : ''}` : (name ?? i.id), home: i.codexHome }
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
  const signedIn = instances.filter((i) => i.loggedIn)
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
