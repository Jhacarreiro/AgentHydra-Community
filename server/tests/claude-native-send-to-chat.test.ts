// A send addressed by CLI session id goes to the desktop profile whose app holds the chat. The CliMayte ping
// knows a chat by its engine's config home, which for a desktop chat is the default ~/.claude, while native
// control is set per desktop profile: sent there, every ping on 2026-10-12 was refused as "not configured"
// and fell to the pipe, which never wakes an idle chat.
//
// The app's chat index (session-launch) and the process scan are stand-ins, so nothing here reaches a real
// app; the settings answer for the one configured profile, and the reason the send stops with says which
// profile it reached.
import { afterAll, expect, mock, test } from 'bun:test'

// Captured before any fake is installed and put back in afterAll: mock.module applies to the whole run.
const realSessionLaunch = { ...(await import('../src/session-launch')) }
const realSettings = { ...(await import('../src/claude-native-settings')) }
const realProcess = { ...(await import('../src/core/process')) }

const PROFILE = 'C:/Users/me/.claude-instances/example'
const HELD = '0b6f2b0e-1111-4c4c-9a9a-123456789abc'
const NOWHERE = '0b6f2b0e-2222-4c4c-9a9a-123456789abc'
const holders: Record<string, string> = { [HELD]: PROFILE }

mock.module('../src/session-launch', () => ({
  ...realSessionLaunch,
  desktopHomeFor: async (id: string) => holders[id] ?? null,
}))
mock.module('../src/claude-native-settings', () => ({
  ...realSettings,
  getClaudeNativeProfileConfig: (dir: string) =>
    realSettings.normalizeClaudeNativeProfile(dir) ===
    realSettings.normalizeClaudeNativeProfile(PROFILE)
      ? { port: 19399, mode: 'native-only' as const, launchDebugger: true }
      : null,
}))
mock.module('../src/core/process', () => ({
  ...realProcess,
  scanClaudeProcesses: async () => ({ ok: true, processes: [] }),
}))

afterAll(() => {
  mock.module('../src/session-launch', () => realSessionLaunch)
  mock.module('../src/claude-native-settings', () => realSettings)
  mock.module('../src/core/process', () => realProcess)
})

const { tryNativeSendToChat } = await import('../src/claude-native-send')

test('a send by CLI session id reaches the native control of the desktop profile that holds the chat, and a chat no desktop holds is refused before any app is asked', async () => {
  // The holding profile is configured, so the send gets as far as looking for its app: not running here.
  expect(await tryNativeSendToChat(HELD, 'Group settled.', 'CliMayte')).toEqual({
    ok: false,
    unavailable: true,
    reason: 'the app is not running',
  })
  expect(await tryNativeSendToChat(NOWHERE, 'Group settled.', 'CliMayte')).toEqual({
    ok: false,
    unavailable: true,
    reason: 'no desktop chat holds this session',
  })
})
