import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitFact, workTreeRoot } from '../../src/repoyeti/api'

const temps: string[] = []
const temp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p))
  temps.push(d)
  return d
}

/** Records the subcommand of every git start while it is on; the caller turns it off. */
function watchGit(): { starts: string[]; stop: () => void } {
  const starts: string[] = []
  const real = Bun.spawn
  const spy = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[], opts?: unknown) => {
    if (cmd[0] === 'git') starts.push(cmd.slice(3).join(' '))
    return real(cmd, opts as Parameters<typeof Bun.spawn>[1])
  }) as typeof Bun.spawn)
  return { starts, stop: () => spy.mockRestore() }
}

const count = (starts: string[], sub: string): number => starts.filter((s) => s.startsWith(sub)).length

afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

test('concurrent asks for one folder start git for its root once', async () => {
  const repo = temp('root-cache-repo-')
  Bun.spawnSync(['git', 'init', '-q', repo])
  const watch = watchGit()
  try {
    const roots = await Promise.all(Array.from({ length: 5 }, () => workTreeRoot(repo)))
    expect(new Set(roots).size).toBe(1)
    await workTreeRoot(repo)
    expect(count(watch.starts, 'rev-parse')).toBe(1)
  } finally {
    watch.stop()
  }
}, 20_000)

test('a folder outside any work tree is asked again only after its short memory', async () => {
  const plain = temp('root-cache-plain-')
  const watch = watchGit()
  try {
    expect(await workTreeRoot(plain)).toBeNull()
    expect(await workTreeRoot(plain)).toBeNull()
    expect(count(watch.starts, 'rev-parse')).toBe(1)
  } finally {
    watch.stop()
  }
}, 20_000)

test('a cached root that is gone from disk is looked up again', async () => {
  const repo = temp('root-cache-gone-')
  Bun.spawnSync(['git', 'init', '-q', repo])
  const watch = watchGit()
  try {
    expect(await workTreeRoot(repo)).not.toBeNull()
    rmSync(repo, { recursive: true, force: true })
    expect(await workTreeRoot(repo)).toBeNull()
    expect(count(watch.starts, 'rev-parse')).toBe(2)
  } finally {
    watch.stop()
  }
}, 20_000)

test('a remote URL asked twice within the minute starts git once', async () => {
  const repo = temp('root-cache-fact-')
  Bun.spawnSync(['git', 'init', '-q', repo])
  Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', 'https://example.com/owner/repo.git'])
  const watch = watchGit()
  try {
    const args = ['config', '--get', 'remote.origin.url']
    expect(await gitFact(repo, args)).toBe('https://example.com/owner/repo.git')
    expect(await gitFact(repo, args)).toBe('https://example.com/owner/repo.git')
    expect(count(watch.starts, 'config')).toBe(1)
  } finally {
    watch.stop()
  }
}, 20_000)
