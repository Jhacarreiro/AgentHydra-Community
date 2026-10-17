// server/tests/updater-channel-remote.test.ts - which remote a source checkout may update from
// (channelRemoteRefusal in server/src/updater.ts): only the release channel's repository on GitHub, in
// whichever URL shape git was given it. The engine side (the gate is asked before any remote is
// contacted) is in server-lib/updater-engine.test.ts.
import { describe, expect, test } from 'bun:test'
import type { ReleaseChannel } from '../src/release-channel'
import { channelRemoteRefusal } from '../src/updater'

const CH: ReleaseChannel = { repo: 'Example-Owner/Example-App', updates: 'off' }

describe('channelRemoteRefusal', () => {
  test("allows the channel's repository in every shape git takes, whatever the case or the policy", () => {
    for (const url of [
      'https://github.com/Example-Owner/Example-App.git',
      'https://github.com/example-owner/example-app',
      'git@github.com:Example-Owner/Example-App.git',
      'ssh://git@github.com/Example-Owner/Example-App.git',
    ])
      expect({ url, refused: channelRemoteRefusal(url, CH) }).toEqual({ url, refused: null })
    // The policy is about release downloads; a checkout follows git either way.
    expect(
      channelRemoteRefusal('https://github.com/Example-Owner/Example-App.git', {
        ...CH,
        updates: 'auto',
      }),
    ).toBeNull()
  })

  test('refuses any other repository, host or path, and the reason names the channel repository', () => {
    for (const url of [
      'https://github.com/LunarWerxs/AgentHydra.git',
      'https://github.com/Example-Owner/Example-App-mirror.git',
      'https://github.com/Other-Owner/Example-App.git',
      'https://gitlab.com/Example-Owner/Example-App.git',
      '/srv/git/Example-App.git',
      'C:\\repos\\Example-App',
    ]) {
      const refused = channelRemoteRefusal(url, CH)
      expect({ url, refused: typeof refused }).toEqual({ url, refused: 'string' })
      expect(refused).toContain('Example-Owner/Example-App')
      expect(refused).toContain('release-channel.json')
    }
  })

  test('names the remote it refused, as owner/name when it is on GitHub', () => {
    expect(channelRemoteRefusal('git@github.com:LunarWerxs/AgentHydra.git', CH)).toContain(
      '(LunarWerxs/AgentHydra)',
    )
    expect(channelRemoteRefusal('/srv/git/app.git', CH)).toContain('(/srv/git/app.git)')
  })
})
