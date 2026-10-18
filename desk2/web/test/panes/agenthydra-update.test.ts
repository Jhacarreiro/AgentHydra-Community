import { expect, test } from 'bun:test'
import type { PaneApi } from '../../src/components/panes/api'
import { useAgentHydraSettings } from '../../src/components/panes/agenthydra'

// What GET /api/update answers, as the daemon builds it (server/src/github-updater.ts, server/src/updater-engine.mjs).
const status = (over: Record<string, unknown>) => ({
  currentVersion: '2026.10.0',
  currentCommit: null,
  remote: null,
  updateAvailable: false,
  canApply: false,
  reason: null,
  ...over
})

async function versionRow(answer: Record<string, unknown>) {
  const api = { agentHydra: async () => status(answer) } as unknown as PaneApi
  const ah = useAgentHydraSettings(api)
  await ah.checkUpdate()
  return { state: ah.updateState.value, notes: ah.rowNotes('ahVersion') }
}

// Regression (2026-10-17): a release build whose release channel says "off" answers remote: null with the reason,
// and the row said "This install is not linked to a Git remote", which is not why, and never showed the reason.
test("a release build with updates off says the daemon's reason, not that a Git remote is missing", async () => {
  const off = 'Updates are off in this build: release-channel.json says "off" for Owner/Repo, so nothing was checked or downloaded.'
  expect(await versionRow({ reason: off })).toEqual({ state: 'no-source', notes: [off] })
})

test('a checkout whose remote is not the channel repository is not shown as up to date', async () => {
  const refused = 'the update remote (someone/else) is not Owner/Repo, the repository release-channel.json names, so this checkout does not update from it'
  const row = await versionRow({ remote: 'https://github.com/someone/else.git', remoteRefused: true, reason: refused })
  expect(row.state).toBe('no-source')
  expect(row.notes).toEqual([`The update remote (someone/else) is not Owner/Repo, the repository release-channel.json names, so this checkout does not update from it.`])
})

test('with no remote and no reason, the row still says there is nowhere to pull from', async () => {
  expect(await versionRow({})).toEqual({ state: 'no-source', notes: ['This install is not linked to a Git remote, so there is nowhere to pull new versions from.'] })
})

test('a "notify" release reads as one sentence after the blocked prefix', async () => {
  const notify = 'v2026.11.0 is available. This build only tells you about new releases (release-channel.json says "notify"); download the new one from https://github.com/Owner/Repo/releases.'
  const row = await versionRow({ remote: 'https://github.com/Owner/Repo/releases', updateAvailable: true, reason: notify })
  expect(row.state).toBe('blocked')
  expect(row.notes).toEqual([`An update is waiting but cannot be applied: ${notify}`])
})
