// A CLI login's link to a desktop profile holds however the profile folder is spelled (server/src/core/cli-instances.ts).
// 2026-10-14: 6 of 7 links on the owner's PC were stored lower-cased (`c:\users\...`) while the desktop list spells the
// same folders `C:\Users\...`, so the exact compare found none of them: the desktop usage check's linked-login fallback,
// and a second link of the same profile, missed the login. Windows paths ignore case; POSIX ones do not.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  cliInstanceForDesktop,
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  linkCliInstanceToDesktop,
} from '../src/core/cli-instances'
import { instancesRoot } from '../src/core/paths'

const made: { dirs: string[]; ids: string[] } = { dirs: [], ids: [] }
afterEach(() => {
  for (const id of made.ids.splice(0)) deleteCliInstance(id, getCliInstance(id)?.name ?? '')
  for (const dir of made.dirs.splice(0)) if (dir) rmSync(dir, { recursive: true, force: true })
})

function cli(name: string): string {
  const created = createCliInstance(name)
  expect(created.ok).toBe(true)
  const id = created.data?.id as string
  made.ids.push(id)
  return id
}

describe.skipIf(process.platform !== 'win32')(
  'a desktop link stored in another letter case',
  () => {
    test('finds its CLI login, and a second link of the same profile takes it over', () => {
      const dir = join(instancesRoot(), `link-case-test-${Date.now()}`)
      mkdirSync(dir, { recursive: true })
      made.dirs.push(dir)
      const first = cli('link-case-first')
      expect(linkCliInstanceToDesktop(first, dir.toLowerCase(), 'link-case (desktop)').ok).toBe(
        true,
      )

      expect(cliInstanceForDesktop(dir.toUpperCase())?.id).toBe(first)

      const second = cli('link-case-second')
      expect(linkCliInstanceToDesktop(second, dir, 'link-case (desktop)').ok).toBe(true)
      expect(getCliInstance(first)?.associatedDesktopDir).toBeNull()
      expect(cliInstanceForDesktop(dir.toLowerCase())?.id).toBe(second)
    })
  },
)
