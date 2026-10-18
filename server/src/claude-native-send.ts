// server/src/claude-native-send.ts - send a message into a desktop chat through the RUNNING app.
//
// The peer pipe reaches only a chat whose engine is live, and the composer route types into the
// app's window. A chat a usage limit stopped has neither a live engine nor anyone at the window, so
// the babysitter's continues all came back "no peer pipe" overnight (44 of them, 2026-10-09). The
// app's own peer-message delivery (what one chat's SendMessage calls to reach another) starts the
// chat's engine itself; the native send makes that call, as a message from another session.
//
// A busy chat is not handed to the app at all: the app's queue drops such a message unrun
// (claude-native-send-hold.ts), so sendOrHold journals it and sends it once the chat is idle.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createNativeSendHold, type HoldSendResult } from './claude-native-send-hold'
import {
  getClaudeNativeProfileConfig,
  normalizeClaudeNativeProfile,
} from './claude-native-settings'
import { transcriptFile } from './climayte-core'
import { DATA_DIR } from './config'
import { connectClaudeInspector } from './core/claude-native/inspector-client'
import { nativeProgram } from './core/claude-native/native-program'
import { scanClaudeProcesses } from './core/process'

export interface NativeSendOutcome {
  ok: boolean
  /** True when nothing reached the app (not configured, not running, no connection, refused before
   *  sending): the caller may try another route. False once the send was made: never resend it. */
  unavailable: boolean
  /** The app's receipt: delivered (a turn started on it), queued (it runs when the chat is free), or
   *  sent (in the app's hands, no answer within the program's 35s wait). `held` comes only from
   *  sendOrHold: the chat was busy, so AgentHydra journals the message and sends it once it is idle. */
  delivery?: 'delivered' | 'queued' | 'sent' | 'held' | null
  /** The chat was busy and nothing was sent to the app; unavailable is true, so the caller may hold it. */
  busy?: boolean
  /** The app refused the send before sending (archived, stopped until a person sends): final, never retried. */
  refused?: boolean
  reason?: string
}

/** The inspector's ceiling: the program stops waiting for the app's answer at 35s, inside it
 *  (Desk's bridge gives the whole route 50s). */
const SEND_CALL_TIMEOUT_MS = 60_000

/** Runs one inspector expression against the profile's running app; `unavailable` says nothing ran. */
async function withAppClient<T>(
  profileDir: string,
  run: (app: {
    pid: number
    evaluate: (expression: string) => Promise<Record<string, any>>
  }) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const config = getClaudeNativeProfileConfig(profileDir)
  if (!config) return { ok: false, reason: 'native control is not configured for this profile' }
  const profile = normalizeClaudeNativeProfile(profileDir)
  const scan = await scanClaudeProcesses({ fresh: true })
  if (!scan.ok) return { ok: false, reason: `could not read the Claude processes: ${scan.reason}` }
  const owners = scan.processes.filter(
    (p) => p.isMain && p.dir && normalizeClaudeNativeProfile(p.dir) === profile,
  )
  if (owners.length !== 1)
    return {
      ok: false,
      reason: owners.length ? 'several main processes match' : 'the app is not running',
    }
  let client: Awaited<ReturnType<typeof connectClaudeInspector>> | undefined
  try {
    client = await connectClaudeInspector({
      pid: owners[0].pid,
      profile,
      port: config.port,
      connectTimeoutMs: 3000,
      callTimeoutMs: SEND_CALL_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  try {
    const value = await run({
      pid: owners[0].pid,
      evaluate: (expression) => client!.evaluate<Record<string, any>>(expression),
    })
    return { ok: true, value }
  } finally {
    client.close()
  }
}

export async function tryNativeSend(
  profileDir: string,
  cliSessionId: string,
  text: string,
  fromName: string,
): Promise<NativeSendOutcome> {
  const profile = normalizeClaudeNativeProfile(profileDir)
  const connected = await withAppClient(profileDir, ({ pid, evaluate }) =>
    evaluate(
      nativeProgram({ action: 'send', pid, profileDir: profile, cliSessionId, text, fromName }),
    ),
  )
  if (!connected.ok) return { ok: false, unavailable: true, reason: connected.reason }
  try {
    const result = connected.value
    if (result?.ok === true && (result.verified === true || result.delivery === 'sent'))
      return { ok: true, unavailable: false, delivery: result.delivery ?? null }
    return {
      ok: false,
      unavailable: result?.dispatch === 'not-sent',
      busy: result?.busy === true,
      ...(result?.refused === true ? { refused: true } : {}),
      delivery: result?.delivery ?? null,
      reason: String(result?.reason ?? 'the app did not confirm the message'),
    }
  } catch (error) {
    // A lost reply after sending: the message may have gone in, so no other route retries it.
    return {
      ok: false,
      unavailable: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Whether the chat is idle by the app's own state: `unavailable` when the app cannot be asked. */
export async function probeChatIdle(
  profileDir: string,
  cliSessionId: string,
): Promise<'idle' | 'busy' | 'unavailable'> {
  const probed = await withAppClient(profileDir, ({ pid, evaluate }) =>
    evaluate(nativeProgram({ action: 'inspect', pid, profileDir, cliSessionId } as any)),
  )
  if (!probed.ok) return 'unavailable'
  const session = (probed.value.sessions ?? []).find((s: any) => s?.cliSessionId === cliSessionId)
  if (!session) return 'unavailable'
  return session.busy === true ? 'busy' : 'idle'
}

/** Whether the message's ref is in the chat's transcript, looked for on the profile and then on the
 *  default Claude config (where the desktop chats' transcripts are written). */
export function transcriptHasRef(profileDir: string, cliSessionId: string, ref: string): boolean {
  const candidates = [profileDir, join(homedir(), '.claude')]
  for (const dir of candidates) {
    const file = transcriptFile(dir, cliSessionId)
    if (!file) continue
    try {
      if (readFileSync(file, 'utf8').includes(ref)) return true
    } catch {
      // An unreadable copy in one place does not mean the message is absent: try the next.
    }
  }
  return false
}

let productionHold: ReturnType<typeof createNativeSendHold> | undefined

function holdFor(): ReturnType<typeof createNativeSendHold> {
  productionHold ??= createNativeSendHold({
    journalPath: join(DATA_DIR, 'claude-native', 'held-sends.json'),
    send: async (req): Promise<HoldSendResult> => {
      const r = await tryNativeSend(req.profileDir, req.cliSessionId, req.text, req.fromName)
      return {
        ok: r.ok,
        unavailable: r.unavailable,
        busy: r.busy,
        refused: r.refused,
        delivery: r.delivery,
        reason: r.reason,
      }
    },
    transcriptHas: (req, ref) => transcriptHasRef(req.profileDir, req.cliSessionId, ref),
    isIdle: async (req) => (await probeChatIdle(req.profileDir, req.cliSessionId)) === 'idle',
  })
  return productionHold
}

/** At daemon start: a journal that a stopped daemon left with held or unconfirmed sends is picked up
 *  now, so they go out once their chats are idle, not on the next busy send. */
export function resumeHeldNativeSends(): void {
  holdFor()
}

/** The native send for a caller that must reach the chat. A busy chat is journalled and sent once it
 *  is idle (claude-native-send-hold.ts); the app is never handed a message for a busy chat. `holdLimitMs`:
 *  the held note is not sent once that old, for a note that stops being news (unset: the hold's expiry). */
export async function sendOrHold(
  profileDir: string,
  cliSessionId: string,
  text: string,
  fromName: string,
  holdLimitMs?: number,
): Promise<NativeSendOutcome> {
  const result = await tryNativeSend(profileDir, cliSessionId, text, fromName)
  if (!result.busy) return result
  holdFor().hold({ profileDir, cliSessionId, text, fromName }, holdLimitMs)
  return { ok: true, unavailable: false, delivery: 'held' }
}

/** The desktop profile whose app holds a chat known only by its CLI session id (the app's chat index, as
 *  the message route finds it), or null. Never the engine's config home: a desktop chat's engine runs on
 *  ~/.claude while native control is set per desktop profile, so on 2026-10-12 every CliMayte ping to a
 *  desktop chat was refused as "not configured" and fell to the pipe, which only queues a note in an idle
 *  chat. */
async function desktopProfileOf(cliSessionId: string): Promise<string | null> {
  const { desktopHomeFor } = await import('./session-launch')
  return desktopHomeFor(cliSessionId).catch(() => null)
}

/** tryNativeSend for a chat known only by its CLI session id, sent to the desktop profile whose app holds it.
 *  Nothing is journalled: a busy chat answers `busy: true` and the caller keeps the message until it is idle.
 *  (CliMayte's pings once went through the hold queue here; a chat busy for hours then got each stale ping
 *  separately, one per idle moment, 2026-10-13. The outbox keeps them now and sends what is still news.) */
export async function tryNativeSendToChat(
  cliSessionId: string,
  text: string,
  fromName: string,
): Promise<NativeSendOutcome> {
  const profileDir = await desktopProfileOf(cliSessionId)
  if (!profileDir)
    return { ok: false, unavailable: true, reason: 'no desktop chat holds this session' }
  return tryNativeSend(profileDir, cliSessionId, text, fromName)
}

export interface NativeStopOutcome {
  ok: boolean
  /** True when nothing was called in the app (not configured, not running, no connection, refused
   *  before the stop): the caller reports it as unavailable and tries nothing else. */
  unavailable: boolean
  /** The app's own state shows the turn stopping or stopped. */
  verified?: boolean
  /** The app refused the stop before calling its Stop (no running turn, archived, several chats). */
  refused?: boolean
  reason?: string
}

/** The app's own Stop for one chat in a profile's RUNNING app (native-program.ts nativeStop). One call:
 *  a stop the app did not confirm is reported, never sent again. */
export async function tryNativeStop(
  profileDir: string,
  cliSessionId: string,
): Promise<NativeStopOutcome> {
  const profile = normalizeClaudeNativeProfile(profileDir)
  const connected = await withAppClient(profileDir, ({ pid, evaluate }) =>
    evaluate(nativeProgram({ action: 'stop', pid, profileDir: profile, cliSessionId })),
  )
  if (!connected.ok) return { ok: false, unavailable: true, reason: connected.reason }
  try {
    const result = connected.value
    if (result?.ok === true && result.verified === true)
      return { ok: true, unavailable: false, verified: true }
    return {
      ok: false,
      unavailable: result?.dispatch === 'not-sent',
      verified: result?.verified === true,
      ...(result?.refused === true ? { refused: true } : {}),
      reason: String(result?.reason ?? 'the app did not confirm the stop'),
    }
  } catch (error) {
    // The stop may have been called: nothing else is tried, and the caller is told it is unknown.
    return {
      ok: false,
      unavailable: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** tryNativeStop for a chat known only by its CLI session id, in the desktop profile whose app holds it. */
export async function tryNativeStopChat(cliSessionId: string): Promise<NativeStopOutcome> {
  const profileDir = await desktopProfileOf(cliSessionId)
  if (!profileDir)
    return { ok: false, unavailable: true, reason: 'no desktop chat holds this session' }
  return tryNativeStop(profileDir, cliSessionId)
}
