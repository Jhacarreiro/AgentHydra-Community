import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyUpdate,
  assetForThisPlatform,
  CHECKSUM_MANIFEST,
  checkForUpdate,
  currentTarget,
  isNewer,
  latestReleaseRequest,
} from '../src/github-updater'
import {
  latestReleaseApi,
  type ReleaseChannel,
  releaseDownloadBase,
  releasesPage,
} from '../src/release-channel'

describe('github-updater version logic', () => {
  test('isNewer: strictly-greater semver only', () => {
    expect(isNewer('0.3.0', '0.2.1')).toBe(true)
    expect(isNewer('0.2.2', '0.2.1')).toBe(true)
    expect(isNewer('1.0.0', '0.9.9')).toBe(true)
    expect(isNewer('0.2.1', '0.2.1')).toBe(false)
    expect(isNewer('0.2.0', '0.2.1')).toBe(false)
    expect(isNewer('0.1.9', '0.2.1')).toBe(false)
  })

  test('isNewer: tolerates a leading v and pre-release/build suffixes', () => {
    expect(isNewer('v0.3.0', '0.2.1')).toBe(true)
    expect(isNewer('0.3.0', 'v0.2.1')).toBe(true)
    // A pre-release/build suffix past the patch number is ignored (compares the numeric triple).
    expect(isNewer('0.3.0-rc1', '0.2.1')).toBe(true)
    expect(isNewer('0.2.1', '0.2.1+build9')).toBe(false)
  })

  test('currentTarget: os-arch matching the release-asset naming', () => {
    const t = currentTarget()
    expect(t).toMatch(/^(windows|darwin|linux)-(x64|arm64)$/)
    // never leaks node's raw 'win32'
    expect(t.startsWith('win32')).toBe(false)
  })

  test('asset selection prefers the compressed updater bundle when a direct exe is also present', () => {
    const target = currentTarget()
    const extension = process.platform === 'win32' ? '.zip' : '.tar.gz'
    const directExtension = process.platform === 'win32' ? '.exe' : ''
    const direct = {
      name: `AgentHydra-9.9.9-${target}${directExtension}`,
      browser_download_url: 'https://example.test/direct',
      size: 100,
    }
    const compressed = {
      name: `AgentHydra-9.9.9-${target}${extension}`,
      browser_download_url: 'https://example.test/compressed',
      size: 40,
    }

    expect(assetForThisPlatform([direct, compressed])).toEqual(compressed)
    expect(assetForThisPlatform([compressed, direct])).toEqual(compressed)
  })
})

// ── the release channel (release-channel.ts) ──────────────────────────────────────────────────────
//
// Every case names its own channel, so none depends on what the committed release-channel.json says
// today. The network is globalThis.fetch replaced by a recorder that answers only the channel's own
// API URL from a local fixture and fails everything else; nothing leaves the machine.

const repo = 'Example-Owner/Example-App'
const OFF: ReleaseChannel = { repo, updates: 'off' }
const NOTIFY: ReleaseChannel = { repo, updates: 'notify' }
const AUTO: ReleaseChannel = { repo, updates: 'auto' }

// The release the fixture offers: above any version this repository's calendar line will reach (2026.10.0 now).
const NEWER = '9999.1.0'
const EXT = process.platform === 'win32' ? '.zip' : '.tar.gz'
const ASSET = `AgentHydra-${NEWER}-${currentTarget()}${EXT}`
const OWN = `${releaseDownloadBase(AUTO)}/v${NEWER}`

/** A `releases/latest` answer whose two files sit wherever the case says. */
function release(assetUrl = `${OWN}/${ASSET}`, sumsUrl = `${OWN}/${CHECKSUM_MANIFEST}`) {
  return {
    tag_name: `v${NEWER}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: ASSET, browser_download_url: assetUrl, size: 1 },
      { name: CHECKSUM_MANIFEST, browser_download_url: sumsUrl, size: 1 },
    ],
  }
}

interface Seen {
  url: string
  headers: Record<string, string>
}

const savedFetch = globalThis.fetch
const scratch = mkdtempSync(join(tmpdir(), 'ah-gh-updater-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
afterEach(() => {
  globalThis.fetch = savedFetch
})

/** Replace fetch: the channel's latest-release URL answers `body`, any other URL is a failure. */
function stubFetch(channel: ReleaseChannel, body: unknown): Seen[] {
  const seen: Seen[] = []
  // `input: unknown` rather than RequestInfo: the server tsconfig has no DOM lib.
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url =
      typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    seen.push({ url, headers: { ...(init?.headers ?? {}) } })
    if (url !== latestReleaseApi(channel)) throw new Error(`unexpected request to ${url}`)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return seen
}

/** A scratch install whose exe must still be the old one after a refusal. */
function scratchInstall(): { installDir: string; exePath: string } {
  const installDir = mkdtempSync(join(scratch, 'install-'))
  const exePath = join(installDir, process.platform === 'win32' ? 'AgentHydra.exe' : 'agenthydra')
  writeFileSync(exePath, 'old exe')
  return { installDir, exePath }
}

describe('the update request', () => {
  test("asks GitHub for the channel repository's latest release, and sends nothing about this install", () => {
    const { url, headers } = latestReleaseRequest(AUTO)
    expect(url).toBe('https://api.github.com/repos/Example-Owner/Example-App/releases/latest')
    expect(Object.keys(headers).sort()).toEqual(['accept', 'user-agent'])
    expect(new URL(url).search).toBe('')
  })

  test('a check reaches only that URL: no proxy, no install id, no upstream', async () => {
    const seen = stubFetch(AUTO, release())
    const status = await checkForUpdate({ fresh: true, channel: AUTO })
    expect(status.ok).toBe(true)
    expect(seen.map((s) => s.url)).toEqual([latestReleaseApi(AUTO)])
    for (const s of seen) {
      expect(s.url.toLowerCase()).not.toContain('lunarwerxs')
      expect(s.url).not.toContain('connectionsapi')
      expect(Object.keys(s.headers).map((h) => h.toLowerCase())).not.toContain('x-install-id')
    }
  })
})

describe('updates "off"', () => {
  test('a check asks nothing and reports no update, nothing to apply, and why', async () => {
    const seen = stubFetch(OFF, release())
    const status = await checkForUpdate({ fresh: true, channel: OFF })
    expect(seen).toEqual([])
    expect(status.ok).toBe(true)
    expect(status.updateAvailable).toBe(false)
    expect(status.canApply).toBe(false)
    expect(status.remote).toBeNull()
    expect(status.reason).toContain('Updates are off')
  })

  test('an apply refuses before any request or any file is touched', async () => {
    const seen = stubFetch(OFF, release())
    const { installDir, exePath } = scratchInstall()
    let downloaded = false
    const result = await applyUpdate({
      channel: OFF,
      installDir,
      exePath,
      downloadAndVerifyUpdate: async () => {
        downloaded = true
        throw new Error('download reached')
      },
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Updates are off')
    expect(seen).toEqual([])
    expect(downloaded).toBe(false)
    expect(readdirSync(installDir)).toEqual([exePath.split(/[\\/]/).pop() as string])
  })
})

describe('updates "notify"', () => {
  test('a check finds the new release but will not apply it, and says where to get it', async () => {
    const seen = stubFetch(NOTIFY, release())
    const status = await checkForUpdate({ fresh: true, channel: NOTIFY })
    expect(seen.map((s) => s.url)).toEqual([latestReleaseApi(NOTIFY)])
    expect(status.updateAvailable).toBe(true)
    expect(status.canApply).toBe(false)
    expect(status.reason).toContain(`v${NEWER} is available`)
    expect(status.reason).toContain(releasesPage(NOTIFY))
  })

  test('an apply refuses before any request', async () => {
    const seen = stubFetch(NOTIFY, release())
    const { installDir, exePath } = scratchInstall()
    const result = await applyUpdate({ channel: NOTIFY, installDir, exePath })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('only tells you')
    expect(seen).toEqual([])
  })
})

describe('updates "auto": only the channel repository\'s own release files', () => {
  test('a release whose archive is under the channel can be applied', async () => {
    stubFetch(AUTO, release())
    const status = await checkForUpdate({ fresh: true, channel: AUTO })
    expect(status.updateAvailable).toBe(true)
    expect(status.canApply).toBe(true)
  })

  for (const [label, url] of [
    [
      "the upstream project's releases",
      `https://github.com/LunarWerxs/AgentHydra/releases/download/v${NEWER}/${ASSET}`,
    ],
    ['an unrelated host', `https://downloads.example.test/v${NEWER}/${ASSET}`],
  ] as const) {
    test(`an archive on ${label} is reported and never applied`, async () => {
      stubFetch(AUTO, release(url))
      const status = await checkForUpdate({ fresh: true, channel: AUTO })
      expect(status.updateAvailable).toBe(true)
      expect(status.canApply).toBe(false)
      expect(status.reason).toContain(`not a release download of ${repo}`)

      const { installDir, exePath } = scratchInstall()
      let downloaded = false
      const result = await applyUpdate({
        channel: AUTO,
        installDir,
        exePath,
        downloadAndVerifyUpdate: async () => {
          downloaded = true
          throw new Error('download reached')
        },
      })
      expect(result.ok).toBe(false)
      expect(result.message).toContain(`refusing ${ASSET}`)
      expect(downloaded).toBe(false)
    })
  }

  test('a checksum list from elsewhere is refused too, before the archive is fetched', async () => {
    const seen = stubFetch(
      AUTO,
      release(undefined, `https://downloads.example.test/v${NEWER}/SHA256SUMS.txt`),
    )
    const { installDir, exePath } = scratchInstall()
    let downloaded = false
    const result = await applyUpdate({
      channel: AUTO,
      installDir,
      exePath,
      downloadAndVerifyUpdate: async () => {
        downloaded = true
        throw new Error('download reached')
      },
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain(`refusing ${CHECKSUM_MANIFEST}`)
    expect(downloaded).toBe(false)
    expect(seen.every((s) => s.url === latestReleaseApi(AUTO))).toBe(true)
  })
})
