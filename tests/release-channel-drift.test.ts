// tests/release-channel-drift.test.ts - the copies of the release channel that cannot import
// server/src/release-channel.ts (PowerShell, the tray's JSON, the workflow) say what release-channel.json says.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { githubSlug, RELEASE_CHANNEL } from '../server/src/release-channel'
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
