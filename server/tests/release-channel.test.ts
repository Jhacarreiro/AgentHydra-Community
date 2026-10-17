// server/tests/release-channel.test.ts - the release channel (server/src/release-channel.ts): the committed file is
// valid and names this project's own repository, and the URL rules every download is held to.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../../tests/repo-root'
import {
  applyRefusal,
  changelogUrl,
  checkRefusal,
  githubSlug,
  isChannelAssetUrl,
  latestReleaseApi,
  parseReleaseChannel,
  RELEASE_CHANNEL,
  type ReleaseChannel,
  releaseDownloadBase,
  releasesPage,
  sameRepo,
} from '../src/release-channel'

const CH: ReleaseChannel = { repo: 'Example-Owner/Example.App', updates: 'auto' }

describe('the committed release-channel.json', () => {
  test('is what the loader reads, and it is valid', () => {
    const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'release-channel.json'), 'utf8'))
    expect(parseReleaseChannel(raw)).toEqual({
      repo: RELEASE_CHANNEL.repo,
      updates: RELEASE_CHANNEL.updates,
    })
  })

  test("names this project's repository, never the one it was forked from", () => {
    expect(sameRepo(RELEASE_CHANNEL.repo, 'LunarWerxs/AgentHydra')).toBe(false)
    expect(RELEASE_CHANNEL.repo.toLowerCase().startsWith('lunarwerxs/')).toBe(false)
  })
})

describe('parseReleaseChannel', () => {
  test('accepts every policy', () => {
    for (const updates of ['off', 'notify', 'auto'] as const)
      expect(parseReleaseChannel({ repo: 'a/b', updates, notes: 'ignored' })).toEqual({
        repo: 'a/b',
        updates,
      })
  })

  test('refuses what could not be a repository or a policy', () => {
    for (const raw of [
      null,
      [],
      'a/b',
      { updates: 'off' },
      { repo: 'no-slash', updates: 'off' },
      { repo: 'a/b/c', updates: 'off' },
      { repo: 'a/..', updates: 'off' },
      { repo: '-a/b', updates: 'off' },
      { repo: 'a b/c', updates: 'off' },
      { repo: 'a/b"); evil("', updates: 'off' },
      { repo: 'a/b', updates: 'on' },
      { repo: 'a/b', updates: true },
      { repo: 'a/b' },
    ])
      expect(() => parseReleaseChannel(raw)).toThrow()
  })
})

describe('URLs come from the channel', () => {
  test('every link is under the channel repository', () => {
    expect(latestReleaseApi(CH)).toBe(
      'https://api.github.com/repos/Example-Owner/Example.App/releases/latest',
    )
    expect(releasesPage(CH)).toBe('https://github.com/Example-Owner/Example.App/releases')
    expect(releaseDownloadBase(CH)).toBe(
      'https://github.com/Example-Owner/Example.App/releases/download',
    )
    expect(changelogUrl(CH)).toBe(
      'https://github.com/Example-Owner/Example.App/blob/main/CHANGELOG.md',
    )
  })
})

describe('isChannelAssetUrl', () => {
  const base = 'https://github.com/Example-Owner/Example.App/releases/download'

  test("accepts the channel's own release files, owner and name in any case", () => {
    expect(isChannelAssetUrl(`${base}/v2026.10.0/AgentHydra-2026.10.0-linux-x64.tar.gz`, CH)).toBe(
      true,
    )
    expect(isChannelAssetUrl(`${base}/v2026.10.0/SHA256SUMS.txt`, CH)).toBe(true)
    expect(
      isChannelAssetUrl(
        'https://github.com/example-owner/example.app/releases/download/v1/a.zip',
        CH,
      ),
    ).toBe(true)
  })

  test('refuses another repository, another host, and anything that climbs or hides', () => {
    for (const url of [
      'https://github.com/LunarWerxs/AgentHydra/releases/download/v2.0.5/AgentHydra-2.0.5-linux-x64.tar.gz',
      'https://github.com/Example-Owner/Example.App-evil/releases/download/v1/a.zip',
      'https://github.com/Example-Owner/Example.Ap/releases/download/v1/a.zip',
      'http://github.com/Example-Owner/Example.App/releases/download/v1/a.zip',
      'https://objects.githubusercontent.com/Example-Owner/Example.App/releases/download/v1/a.zip',
      'https://github.com.example.test/Example-Owner/Example.App/releases/download/v1/a.zip',
      'https://example.test/Example-Owner/Example.App/releases/download/v1/a.zip',
      'https://github.com:8443/Example-Owner/Example.App/releases/download/v1/a.zip',
      'https://user@github.com/Example-Owner/Example.App/releases/download/v1/a.zip',
      `${base}/../../../LunarWerxs/AgentHydra/releases/download/v1/a.zip`,
      `${base}/%2e%2e/%2e%2e/%2e%2e/LunarWerxs/AgentHydra/releases/download/v1/a.zip`,
      `${base}/v1/a.zip?redirect=https://example.test`,
      `${base}/v1/a.zip#x`,
      `${base}/v1`,
      `${base}/v1/deeper/a.zip`,
      `${base}/`,
      'https://github.com/Example-Owner/Example.App/releases/latest',
      'not a url',
      '',
    ])
      expect({ url, ok: isChannelAssetUrl(url, CH) }).toEqual({ url, ok: false })
  })
})

describe('githubSlug', () => {
  test('reads owner/name from every URL shape git takes for GitHub', () => {
    for (const url of [
      'https://github.com/Example-Owner/Example.App.git',
      'https://github.com/Example-Owner/Example.App',
      'https://github.com/Example-Owner/Example.App/',
      'git@github.com:Example-Owner/Example.App.git',
      'ssh://git@github.com/Example-Owner/Example.App.git',
    ])
      expect(githubSlug(url)).toBe('Example-Owner/Example.App')
  })

  test('is null for anything that is not GitHub', () => {
    for (const url of [
      '/srv/git/app.git',
      'C:\\repos\\app',
      'https://gitlab.com/a/b.git',
      'origin',
      '',
    ])
      expect(githubSlug(url)).toBeNull()
  })
})

describe('the policy', () => {
  test('"off" refuses checking and installing', () => {
    const off = { ...CH, updates: 'off' as const }
    expect(checkRefusal(off)).toContain('off')
    expect(applyRefusal(off)).toBe(checkRefusal(off))
  })

  test('"notify" checks but refuses installing, and says where the download is', () => {
    const notify = { ...CH, updates: 'notify' as const }
    expect(checkRefusal(notify)).toBeNull()
    expect(applyRefusal(notify)).toContain(releasesPage(notify))
  })

  test('"auto" refuses nothing', () => {
    expect(checkRefusal(CH)).toBeNull()
    expect(applyRefusal(CH)).toBeNull()
  })
})
