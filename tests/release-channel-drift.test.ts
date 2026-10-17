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
