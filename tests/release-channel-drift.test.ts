// tests/release-channel-drift.test.ts - the copies of the release channel that cannot import
// server/src/release-channel.ts (PowerShell, the tray's JSON, Desk's links, the workflow) say what
// release-channel.json says, and no code names the repository this project was forked from, or the update
// proxy it used to ask.
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHANGELOG_URL, PROJECT_HOMEPAGE, PROJECT_REPO } from '../desk2/shared/release-links'
// @ts-expect-error - a plain node module with runtime exports
import { readReleaseChannel } from '../scripts/release-channel.mjs'
import { changelogUrl, githubSlug, RELEASE_CHANNEL, repoUrl } from '../server/src/release-channel'
import { REPO_ROOT } from './repo-root'

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

describe('scripts/live-checkout.ps1', () => {
  const ps1 = read('scripts/live-checkout.ps1')

  test('follows a -Remote that defaults to the channel, and names no remote of its own', () => {
    expect(ps1).toMatch(/\[string\]\$Remote = ''/)
    expect(ps1).toContain("Join-Path $here 'release-channel.json'")
    // Every git step goes through $Remote / $Upstream; a literal origin/main would follow whatever origin is.
    expect(ps1).not.toMatch(/origin\/main|'origin', 'main'|fetch origin/)
  })

  test("reads a GitHub URL the way githubSlug does (PowerShell's -match ignores case)", () => {
    const m = /function Get-GitHubSlug[\s\S]*?-match '([^']+)'/.exec(ps1)
    expect(m).not.toBeNull()
    const rx = new RegExp(m?.[1] ?? '', 'i')
    const slug = (url: string) => {
      const r = rx.exec(url.trim())
      return r ? `${r[1]}/${r[2]}` : null
    }
    for (const url of [
      `https://github.com/${RELEASE_CHANNEL.repo}.git`,
      `https://github.com/${RELEASE_CHANNEL.repo.toLowerCase()}`,
      `git@github.com:${RELEASE_CHANNEL.repo}.git`,
      `ssh://git@github.com/${RELEASE_CHANNEL.repo}.git`,
      'https://github.com/Other-Owner/Other-App/',
      'https://gitlab.com/Other-Owner/Other-App.git',
      'C:\\repos\\app',
      '/srv/git/app.git',
    ])
      expect({ url, slug: slug(url) }).toEqual({ url, slug: githubSlug(url) })
  })
})

describe('install.ps1', () => {
  const ps1 = read('install.ps1')

  test("copies the channel's repository and policy, and its one-line install names that repository", () => {
    expect(/^\$Repo = '([^']*)'\r?$/m.exec(ps1)?.[1]).toBe(RELEASE_CHANNEL.repo)
    expect(/^\$Updates = '([^']*)'\r?$/m.exec(ps1)?.[1]).toBe(RELEASE_CHANNEL.updates)
    expect(ps1).toContain(
      `irm https://raw.githubusercontent.com/${RELEASE_CHANNEL.repo}/main/install.ps1 | iex`,
    )
    expect(ps1.toLowerCase()).not.toContain('lunarwerxs/agenthydra')
  })

  test('refuses the download while updates are off, and downloads only the release files of $Repo', () => {
    // The refusal comes before the first request: nothing is asked of GitHub while there is nothing to get.
    const off = ps1.indexOf("if ($Updates -eq 'off')")
    expect(off).toBeGreaterThan(0)
    expect(off).toBeLessThan(ps1.indexOf('Invoke-RestMethod'))
    expect(ps1).toContain('"https://github.com/$Repo/releases/download/$tag/$($file.name)"')
    expect(ps1.indexOf('$expectedUrl')).toBeLessThan(ps1.indexOf('Invoke-WebRequest'))
  })
})

describe('scripts/release-channel.mjs', () => {
  test('the node release scripts read the channel the TypeScript loader reads', () => {
    expect(readReleaseChannel()).toEqual({
      repo: RELEASE_CHANNEL.repo,
      updates: RELEASE_CHANNEL.updates,
    })
  })
})

describe('links', () => {
  test("the tray's changelog item opens the channel repository's CHANGELOG", () => {
    const tray = JSON.parse(read('misc/AgentHydra-Tray.json')) as { changelogUrl?: string }
    expect(tray.changelogUrl).toBe(changelogUrl())
  })

  test("Desk's links (desk2/shared/release-links.ts) are the channel repository's", () => {
    expect(PROJECT_REPO).toBe(RELEASE_CHANNEL.repo)
    expect(PROJECT_HOMEPAGE).toBe(repoUrl())
    expect(CHANGELOG_URL).toBe(changelogUrl())
  })
})

// Code only: the CHANGELOG and the docs tell the history, which names the project this one came from, and tests
// name it as the case that must be refused.
describe('no code points at the project this one was forked from', () => {
  const FORBIDDEN = [/lunarwerxs\/agenthydra/i, /connectionsapi\.com\/v1\/app\//i]
  // Each stays on purpose, and the reason is beside it.
  const ALLOWED = new Set([
    // The Go module path of the Codex hub tray: a name, never fetched; renaming it moves every import with it.
    'codex-hub-tray/go.mod',
    // A comment on the public-push guard, about the repository that guard was written for.
    '.githooks/check-public-push.mjs',
  ])
  const isDocOrTest = (file: string) =>
    /\.md$/i.test(file) ||
    /(^|\/)(tests?|__tests__)\//.test(file) ||
    /\.test\.[cm]?[jt]sx?$/.test(file) ||
    /(^|\/)test_[^/]*\.py$/.test(file)

  test('every tracked code file is free of it, except the ones listed with their reason', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((f) => f && !isDocOrTest(f) && !ALLOWED.has(f))
    // A guard that found nothing to scan would pass over anything.
    expect(files.length).toBeGreaterThan(500)
    const hits: string[] = []
    for (const file of files) {
      let text: string
      try {
        text = readFileSync(join(REPO_ROOT, file), 'utf8')
      } catch {
        continue // a symlink to nothing, a file deleted in the working tree
      }
      for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${file}: ${re.source}`)
    }
    expect(hits).toEqual([])
    // One `git ls-files` and a read of every tracked code file: about 100 ms here, so this is a bound, not a guess.
  }, 30_000)
})
