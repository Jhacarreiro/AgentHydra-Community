// server/src/move-settings-in-app.ts - a moved chat's effort and Bypass, pushed into a RUNNING app.
//
// The running app holds a moved chat in memory with its own defaults, and the disk carry
// (chat-settings-carry.ts) only takes effect at that app's next start. So on 2026-10-14 the owner
// had to set Bypass and the effort by hand on moved chats. This is the same call the Python
// mover's effort_in_app makes (orchestrator/scripts/migrate_chat.py): tryNativeUltracode runs the
// app's own picker path, which sets the effort and Bypass in memory, the saved record and a running
// engine, then reads both back. The disk carry stays as the backstop.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { tryNativeUltracode } from './claude-native-ultracode'
import { NATIVE_EFFORTS } from './core/claude-native/native-program'
import { newChatUltracodeEnabled } from './new-chat-defaults'

export interface MovedSettingsOutcome {
  ok: boolean
  effort: string
  ultracode: boolean
  /** The permission mode the app read back after the push; null when it did not say. */
  permissionMode: string | null
  /** Why the push did not land; absent on success. */
  reason?: string
  /** The app would not keep Bypass, so the chat is on Auto: why. */
  bypassRefused?: string
}

function knownEffort(value: unknown): string | null {
  return typeof value === 'string' && NATIVE_EFFORTS.includes(value) ? value : null
}

function ultracodeOf(meta: Record<string, unknown>): boolean {
  const settings = meta.sessionSettings
  return (
    !!settings &&
    typeof settings === 'object' &&
    (settings as Record<string, unknown>).ultracode === true
  )
}

/** The effort and ultracode a moved chat should come up with: the source's own, else the landed
 *  record's, else xhigh with the new-chat default. Ultracode only runs at xhigh or max, so a flag
 *  beside a lower effort is dropped (the app would read it as off). */
export function movedEffortPair(
  sourceMeta: Record<string, unknown>,
  landedMeta: Record<string, unknown>,
  ultracodeByDefault: boolean,
): { effort: string; ultracode: boolean } {
  const fromSource = knownEffort(sourceMeta.effort)
  const fromLanded = knownEffort(landedMeta.effort)
  const picked = fromSource
    ? { effort: fromSource, ultracode: ultracodeOf(sourceMeta) }
    : fromLanded
      ? { effort: fromLanded, ultracode: ultracodeOf(landedMeta) }
      : { effort: 'xhigh', ultracode: ultracodeByDefault }
  return {
    effort: picked.effort,
    ultracode: picked.ultracode && (picked.effort === 'xhigh' || picked.effort === 'max'),
  }
}

function readLandedRecord(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** Ask the running target app for the moved chat's effort and Bypass permissions, once. Never
 *  throws and never retries: a refusal, an unverified read-back or a thrown error is reported in the
 *  answer, and the move itself has already landed and been verified by the caller. */
export async function landMovedSettingsInApp(
  targetDir: string,
  landedPath: string,
  sourceMeta: Record<string, unknown>,
  deps: {
    native?: typeof tryNativeUltracode
    ultracodeByDefault?: () => boolean
    readLanded?: (path: string) => Record<string, unknown>
  } = {},
): Promise<MovedSettingsOutcome> {
  const native = deps.native ?? tryNativeUltracode
  const ultracodeByDefault = deps.ultracodeByDefault ?? newChatUltracodeEnabled
  const readLanded = deps.readLanded ?? readLandedRecord
  let landedMeta: Record<string, unknown> = {}
  try {
    const record: unknown = readLanded(landedPath)
    if (!record || typeof record !== 'object') throw new Error('it is not a JSON object')
    landedMeta = record as Record<string, unknown>
  } catch (error) {
    const pair = movedEffortPair(sourceMeta, {}, ultracodeByDefault())
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      ...pair,
      permissionMode: null,
      reason: `could not read the landed record: ${reason}`,
    }
  }
  const pair = movedEffortPair(sourceMeta, landedMeta, ultracodeByDefault())
  const chatId = basename(landedPath, '.json')
  try {
    const outcome = await native(targetDir, chatId, pair.effort, pair.ultracode, true)
    if (outcome.ok !== true) {
      return {
        ok: false,
        ...pair,
        permissionMode: null,
        reason: outcome.reason ?? 'the app did not read the effort and Bypass back',
      }
    }
    return {
      ok: true,
      ...pair,
      permissionMode: outcome.after?.permissionMode ?? null,
      ...(outcome.bypassRefused ? { bypassRefused: outcome.bypassRefused } : {}),
    }
  } catch (error) {
    return {
      ok: false,
      ...pair,
      permissionMode: null,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
