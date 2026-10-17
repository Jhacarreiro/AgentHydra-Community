// tests/consolidate-releases.test.ts - the consolidate-releases.mjs script:
// groups releases by minor version (x.y), keeps x.y.0 (or lowest if missing), folds patches,
// and never folds the latest release.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  apply,
  applyRefusal,
  classifyVersions,
  groupByMinor,
  // @ts-expect-error - consolidate-releases.mjs is a build script with runtime exports
} from '../scripts/consolidate-releases.mjs'
import { RELEASE_CHANNEL } from '../server/src/release-channel'
import { REPO_ROOT } from './repo-root'

describe('consolidate releases', () => {
  test('groups versions by minor version (x.y)', () => {
    const versions = ['2.0.0', '2.0.1', '2.0.2', '2.1.0', '2.1.1', '1.13.0']
    const groups = groupByMinor(versions)

    expect(groups.has('2.0')).toBe(true)
    expect(groups.get('2.0')).toContain('2.0.0')
    expect(groups.get('2.0')).toContain('2.0.1')
    expect(groups.get('2.0')).toContain('2.0.2')

    expect(groups.has('2.1')).toBe(true)
    expect(groups.get('2.1')).toContain('2.1.0')
    expect(groups.get('2.1')).toContain('2.1.1')

    expect(groups.has('1.13')).toBe(true)
    expect(groups.get('1.13')).toContain('1.13.0')
  })

  test('keeps x.y.0 and folds patches', () => {
    const versions = ['2.0.1', '2.0.0', '2.0.2']
    const { kept, patches } = classifyVersions(versions)

    expect(kept).toBe('2.0.0')
    expect(patches).toContain('2.0.1')
    expect(patches).toContain('2.0.2')
    expect(patches.length).toBe(2)
  })

  test('keeps lowest when x.y.0 does not exist', () => {
    const versions = ['2.5.3', '2.5.1', '2.5.2']
    const { kept, patches } = classifyVersions(versions)

    expect(kept).toBe('2.5.1')
    expect(patches).toContain('2.5.2')
    expect(patches).toContain('2.5.3')
    expect(patches.length).toBe(2)
  })

  test('single version is kept, no patches', () => {
    const versions = ['2.2.0']
    const { kept, patches } = classifyVersions(versions)

    expect(kept).toBe('2.2.0')
    expect(patches.length).toBe(0)
  })

  test('multiple versions keep x.y.0, fold others in release order', () => {
    const versions = ['1.13.0', '1.13.1', '1.13.2']
    const { kept, patches } = classifyVersions(versions)

    expect(kept).toBe('1.13.0')
    // Patches are sorted oldest first (for the body)
    expect(patches).toEqual(['1.13.1', '1.13.2'])
  })
})

// The script rewrites and deletes release pages. It may only ever do that to the release channel's own repository.
describe('--apply is held to the release channel', () => {
  test("allows the channel's repository, in any case, and refuses every other one", () => {
    expect(applyRefusal(RELEASE_CHANNEL.repo)).toBeNull()
    expect(applyRefusal(RELEASE_CHANNEL.repo.toUpperCase())).toBeNull()
    for (const repo of [
      'LunarWerxs/AgentHydra',
      `${RELEASE_CHANNEL.repo}-mirror`,
      'Other-Owner/Other-App',
    ])
      expect(applyRefusal(repo)).toContain(`refusing --apply against ${repo}`)
  })

  test('apply() refuses another repository before it runs a single gh command', async () => {
    const plan = { edit: ['2.0.0'], fold: {}, delete: ['2.0.1'], missingSections: [] }
    await expect(apply(plan, { '2.0.0': 'body' }, 'LunarWerxs/AgentHydra')).rejects.toThrow(
      'refusing --apply against LunarWerxs/AgentHydra',
    )
  })

  test('the command line stops an --apply against another repository before it reads anything', () => {
    // PATH holds no gh here, so a run that got as far as listing releases would fail differently.
    const run = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts', 'consolidate-releases.mjs'),
        '--apply',
        '--repo',
        'LunarWerxs/AgentHydra',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PATH: '' }, timeout: 30_000 },
    )
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('refusing --apply against LunarWerxs/AgentHydra')
    // One bun start that exits before any work: well under a second here; the spawn's own timeout is the same.
  }, 30_000)
})
