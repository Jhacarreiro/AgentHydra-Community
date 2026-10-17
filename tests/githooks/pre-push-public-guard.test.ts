// tests/githooks/pre-push-public-guard.test.ts - the pre-push gate. A PUBLIC remote, or one whose
// visibility cannot be proven, refuses the push and prints the heading; AGENTHYDRA_PUSH_PUBLIC=1
// announces and proceeds; a private remote is untouched; a release tag is refused while
// docs/todo/TODO.md has an open section, and nothing overrides that; a release tag that
// scripts/release-notes.mjs would refuse (below 2.0.0, or a long section with no TL;DR) never lands;
// and a release tag whose CI the hook cannot confirm lands only once `check:deep` passes.
//
// Drives the real, on-disk `.githooks/pre-push` and `.githooks/check-public-push.mjs` (copied
// fresh at test time, never duplicated by hand) against a throwaway repo pushing to a throwaway
// bare origin. The visibility lookup is stubbed through the environment, so nothing here reaches
// the network; the real lookup was proven by hand on 2026-09-12 (LunarWerxs/AgentHydra answered
// 200 + public, a private repo answered 404). It never touches this repo's own remote or index.
//
// Lives under tests/, not .githooks/tests/: `bun test` skips dot-directories, so a suite parked
// there passes by hand and never runs (see hook-tests-live-here.test.ts).
//
// Revert check: delete the `if (verdict !== "private")` block in check-public-push.mjs and the
// first four tests fail; delete the release-tag block and the tag tests fail; drop the
// `bun run check:deep` lane from pre-push and the check:deep tests fail.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openTodoSections,
  parseGithubSlug,
  parseRefLines,
} from '../../.githooks/check-public-push.mjs'
import { REPO_ROOT } from '../repo-root'

// Real git init/commit/push, each push through Git for Windows' sh and one or two node starts. Not the
// ~1 s once noted here: on a loaded Windows box a push took 4-9 s alone and a one-push test up to 27.7 s
// in the parallel suite (2026-10-11). A test that pushes more than once gets this per push; past the
// bound bun kills the push in flight, which reads as a refused push.
const HOOK_TEST_TIMEOUT = 45_000

// A single root for every scratch dir this file creates: at most one mkdtempSync may root
// directly in the OS temp dir per file. realpathSync.native up front resolves the 8.3-short-path
// issue once, so every nested mkdirSync below it is already long-path.
//
// ROOT holds what mkdtempSync returned and is what afterAll reaps: inline, a throw from
// realpathSync.native would leave no reference to the directory at all, leaking it forever.
const ROOT = mkdtempSync(join(tmpdir(), 'ah-prepush-'))
const FILE_ROOT = realpathSync.native(ROOT)
let prepushSeq = 0
function prepushRoot(name: string) {
  const dir = join(FILE_ROOT, `${name}-${prepushSeq++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})
const HEADING = '# WARNING: THIS REPOSITORY IS **PUBLIC**'

const REAL_PREPUSH = join(REPO_ROOT, '.githooks', 'pre-push')
const REAL_GUARD = join(REPO_ROOT, '.githooks', 'check-public-push.mjs')

type Env = Record<string, string>

/** The test's own environment never leaks a real override or stub into the sandbox. */
function envFor(overrides: Env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.AGENTHYDRA_PUSH_PUBLIC
  delete env.AGENTHYDRA_VISIBILITY_STUB
  return { ...env, ...overrides }
}

function git(cwd: string, env: Env, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', timeout: HOOK_TEST_TIMEOUT, env: envFor(env) },
  )
}

interface PushResult {
  status: number
  output: string
}

/** spawnSync rather than execFileSync: the hook speaks on stderr, and a push that SUCCEEDS with
 *  the override must still show the heading, which execFileSync's return value (stdout only)
 *  would hide. */
function push(repo: string, env: Env, ...refs: string[]): PushResult {
  const r = spawnSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'push', 'origin', ...refs],
    { cwd: repo, encoding: 'utf8', timeout: HOOK_TEST_TIMEOUT, env: envFor(env) },
  )
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** A stand-in `check:deep` in `dir`, run by the hook as `bun run check:deep` when it cannot confirm
 *  CI on a release tag. It writes the GIT_ variables it inherits to `record` (so the file existing
 *  means it ran) and exits with `code`. Left untracked: the hook runs it from the working tree. */
function stubCheckDeep(dir: string, record: string, code = 0) {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ private: true, scripts: { 'check:deep': 'node check-deep.mjs' } }),
  )
  writeFileSync(
    join(dir, 'check-deep.mjs'),
    [
      "import { writeFileSync } from 'node:fs'",
      `const git = Object.keys(process.env).filter((k) => k.startsWith('GIT_')).map((k) => k + '=' + process.env[k])`,
      `writeFileSync(${JSON.stringify(record.replace(/\\/g, '/'))}, git.join(String.fromCharCode(10)))`,
      `process.exit(${code})`,
      '',
    ].join('\n'),
  )
}

function originHas(origin: string, ref: string): boolean {
  try {
    git(origin, {}, 'rev-parse', '--verify', '--quiet', ref)
    return true
  } catch {
    return false
  }
}

describe('.githooks/pre-push: a public remote is announced and refused', () => {
  let sandbox: string
  let repo: string
  let origin: string

  beforeEach(() => {
    // realpathSync.native: GitHub's Windows runner hands out an 8.3 temp path (RUNNER~1) while git
    // reports the worktree by its long name, and every path comparison in a hook test then misses.
    sandbox = prepushRoot('sandbox')
    repo = join(sandbox, 'repo')
    origin = join(sandbox, 'origin')
    mkdirSync(join(repo, '.githooks'), { recursive: true })
    git(sandbox, {}, 'init', '-q', '--bare', origin)

    // Byte-identical copies of the REAL hook files, read fresh every run.
    writeFileSync(join(repo, '.githooks', 'pre-push'), readFileSync(REAL_PREPUSH))
    writeFileSync(join(repo, '.githooks', 'check-public-push.mjs'), readFileSync(REAL_GUARD))
    chmodSync(join(repo, '.githooks', 'pre-push'), 0o755) // git on POSIX refuses a non-executable hook

    git(repo, {}, 'init', '-q', '-b', 'main')
    git(repo, {}, 'config', 'core.hooksPath', '.githooks')
    git(repo, {}, 'remote', 'add', 'origin', origin)
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, {}, 'add', 'a.txt')
    git(repo, {}, 'commit', '-q', '-m', 'init')
  }, HOOK_TEST_TIMEOUT)

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  test(
    'PUBLIC without the override: heading printed, push refused, nothing lands',
    () => {
      const r = push(repo, { AGENTHYDRA_VISIBILITY_STUB: 'public' }, 'main')
      expect(r.status).not.toBe(0)
      expect(r.output).toContain(HEADING)
      expect(r.output).toContain('AGENTHYDRA_PUSH_PUBLIC=1')
      expect(originHas(origin, 'refs/heads/main')).toBe(false)
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'PUBLIC with AGENTHYDRA_PUSH_PUBLIC=1: heading STILL printed, then the push proceeds',
    () => {
      const r = push(
        repo,
        { AGENTHYDRA_VISIBILITY_STUB: 'public', AGENTHYDRA_PUSH_PUBLIC: '1' },
        'main',
      )
      expect(r.status).toBe(0)
      expect(r.output).toContain(HEADING)
      expect(r.output).toContain('announced, proceeding')
      expect(originHas(origin, 'refs/heads/main')).toBe(true)
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'PRIVATE: no heading, no friction',
    () => {
      const r = push(repo, { AGENTHYDRA_VISIBILITY_STUB: 'private' }, 'main')
      expect(r.status).toBe(0)
      expect(r.output).not.toContain(HEADING)
      expect(originHas(origin, 'refs/heads/main')).toBe(true)
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'UNKNOWN is fail-closed: refused, and the output says it could not be proven private',
    () => {
      const r = push(repo, { AGENTHYDRA_VISIBILITY_STUB: 'unknown' }, 'main')
      expect(r.status).not.toBe(0)
      expect(r.output).toContain(HEADING)
      expect(r.output).toContain('could not be proven private')
      expect(originHas(origin, 'refs/heads/main')).toBe(false)
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'no stub and a remote that is not GitHub: unknown, so refused without any network',
    () => {
      const r = push(repo, {}, 'main')
      expect(r.status).not.toBe(0)
      expect(r.output).toContain('is not a GitHub remote')
      expect(originHas(origin, 'refs/heads/main')).toBe(false)
    },
    HOOK_TEST_TIMEOUT,
  )

  describe('a release tag is refused while the work queue has an open section', () => {
    const PRIVATE = { AGENTHYDRA_VISIBILITY_STUB: 'private' }

    // The origin is a local path, so the hook cannot confirm CI on a tag and runs check:deep; here
    // it passes, so what these tests see is rules 2 and 3 alone.
    beforeEach(() => {
      stubCheckDeep(repo, join(sandbox, 'check-deep.txt'))
    })

    function writeTodo(repo: string, body: string) {
      mkdirSync(join(repo, 'docs', 'todo'), { recursive: true })
      writeFileSync(join(repo, 'docs', 'todo', 'TODO.md'), body)
    }

    test(
      'open section: refused by name, no override exists, the tag never lands',
      () => {
        writeTodo(repo, '# q\n\n## Contents\n\n- x\n\n## 1. Still open thing\n\nbody\n')
        git(repo, {}, 'tag', 'v1.2.3')
        const r = push(repo, { ...PRIVATE, AGENTHYDRA_PUSH_PUBLIC: '1' }, 'v1.2.3')
        expect(r.status).not.toBe(0)
        expect(r.output).toContain('release refused')
        expect(r.output).toContain('1. Still open thing')
        expect(originHas(origin, 'refs/tags/v1.2.3')).toBe(false)
      },
      HOOK_TEST_TIMEOUT,
    )

    test(
      'only the Contents heading left: the tag ships',
      () => {
        writeTodo(repo, '# q\n\n## Contents\n\n(nothing open)\n')
        git(repo, {}, 'tag', 'v1.2.3')
        const r = push(repo, PRIVATE, 'v1.2.3')
        expect(r.status).toBe(0)
        expect(originHas(origin, 'refs/tags/v1.2.3')).toBe(true)
      },
      HOOK_TEST_TIMEOUT,
    )

    test(
      'no queue file on this machine: nothing to gate on, the tag ships',
      () => {
        git(repo, {}, 'tag', 'v1.2.3')
        const r = push(repo, PRIVATE, 'v1.2.3')
        expect(r.status).toBe(0)
        expect(originHas(origin, 'refs/tags/v1.2.3')).toBe(true)
      },
      HOOK_TEST_TIMEOUT,
    )

    test(
      "release-notes.mjs's refusals stop the tag: a 1.x version, or a long section with no TL;DR",
      () => {
        // The real script beside the hook, as in this repo; the throwaway repo above has none.
        mkdirSync(join(repo, 'scripts'), { recursive: true })
        writeFileSync(
          join(repo, 'scripts', 'release-notes.mjs'),
          readFileSync(join(REPO_ROOT, 'scripts', 'release-notes.mjs')),
        )
        const bullets = '### Added\n\n- **One.** a\n- **Two.** b\n- **Three.** c\n'
        const tldr = '**TL;DR**\n\n- **One**\n\n**Everything in 2.0.0**\n\n'
        writeFileSync(
          join(repo, 'CHANGELOG.md'),
          `# Changelog\n\n## [2.0.0] - 2026-10-07\n\n${bullets}\n## [1.14.0] - 2026-10-06\n\n${bullets}`,
        )
        git(repo, {}, 'add', 'CHANGELOG.md')
        git(repo, {}, 'commit', '-q', '-m', 'notes')
        git(repo, {}, 'tag', 'v1.14.0')
        git(repo, {}, 'tag', 'v2.0.0')
        const old = push(repo, PRIVATE, 'v1.14.0')
        expect(old.status).not.toBe(0)
        expect(old.output).toContain('below 2.0.0')
        expect(originHas(origin, 'refs/tags/v1.14.0')).toBe(false)
        const wall = push(repo, PRIVATE, 'v2.0.0')
        expect(wall.status).not.toBe(0)
        expect(wall.output).toContain('no TL;DR')

        // The same section with its TL;DR ships.
        writeFileSync(
          join(repo, 'CHANGELOG.md'),
          `# Changelog\n\n## [2.0.0] - 2026-10-07\n\n${tldr}${bullets}`,
        )
        git(repo, {}, 'commit', '-q', '-am', 'tldr')
        git(repo, {}, 'tag', '-f', 'v2.0.0')
        const ok = push(repo, PRIVATE, 'v2.0.0')
        expect(ok.status).toBe(0)
        expect(originHas(origin, 'refs/tags/v2.0.0')).toBe(true)
      },
      3 * HOOK_TEST_TIMEOUT, // three pushes
    )

    test(
      'a tag that is not a release (no v-semver name) is not gated',
      () => {
        writeTodo(repo, '# q\n\n## Contents\n\n## 1. Open\n')
        git(repo, {}, 'tag', 'checkpoint')
        const r = push(repo, PRIVATE, 'checkpoint')
        expect(r.status).toBe(0)
        expect(originHas(origin, 'refs/tags/checkpoint')).toBe(true)
      },
      HOOK_TEST_TIMEOUT,
    )
  })

  describe('a release tag whose CI cannot be confirmed waits for check:deep', () => {
    const PRIVATE = { AGENTHYDRA_VISIBILITY_STUB: 'private' }
    let record: string

    beforeEach(() => {
      record = join(sandbox, 'check-deep.txt')
    })

    test(
      'a local origin: CI cannot be confirmed, check:deep fails, and the tag never lands',
      () => {
        stubCheckDeep(repo, record, 1)
        git(repo, {}, 'tag', 'v1.2.3')
        const r = push(repo, PRIVATE, 'v1.2.3')
        expect(r.status).not.toBe(0)
        expect(r.output).toContain('CI not confirmed, so the full check:deep runs')
        expect(existsSync(record)).toBe(true)
        expect(originHas(origin, 'refs/tags/v1.2.3')).toBe(false)
      },
      HOOK_TEST_TIMEOUT,
    )

    test(
      'check:deep passes: the tag ships',
      () => {
        stubCheckDeep(repo, record)
        git(repo, {}, 'tag', 'v1.2.3')
        const r = push(repo, PRIVATE, 'v1.2.3')
        expect(r.status).toBe(0)
        expect(existsSync(record)).toBe(true)
        expect(originHas(origin, 'refs/tags/v1.2.3')).toBe(true)
      },
      HOOK_TEST_TIMEOUT,
    )

    test(
      'a push with no release tag in it never runs check:deep',
      () => {
        stubCheckDeep(repo, record, 1)
        git(repo, {}, 'tag', 'checkpoint')
        const r = push(repo, PRIVATE, 'main', 'checkpoint')
        expect(r.status).toBe(0)
        expect(existsSync(record)).toBe(false)
        expect(originHas(origin, 'refs/heads/main')).toBe(true)
      },
      HOOK_TEST_TIMEOUT,
    )
  })
})

describe('.githooks/pre-push: check:deep runs free of the hook git environment', () => {
  test(
    'a release tag pushed from a linked worktree hands check:deep no GIT_DIR, so its own git finds its own repo',
    () => {
      // Pushing the 1.5.0 tag from a worktree, every git-backed test inherited GIT_DIR and looked at
      // the pushing checkout instead of its own throwaway repo (2026-10-01). The stand-in
      // check:deep records the git variables it inherits.
      const base = prepushRoot('lanes')
      const repo = join(base, 'ah', 'repo')
      const wt = join(base, 'ah', 'wt')
      const origin = join(base, 'origin')
      const seen = join(base, 'seen.txt')

      mkdirSync(join(repo, '.githooks'), { recursive: true })
      git(base, {}, 'init', '-q', '--bare', origin)
      writeFileSync(join(repo, '.githooks', 'pre-push'), readFileSync(REAL_PREPUSH))
      writeFileSync(join(repo, '.githooks', 'check-public-push.mjs'), readFileSync(REAL_GUARD))
      chmodSync(join(repo, '.githooks', 'pre-push'), 0o755)
      git(repo, {}, 'init', '-q', '-b', 'main')
      git(repo, {}, 'config', 'core.hooksPath', '.githooks')
      git(repo, {}, 'remote', 'add', 'origin', origin)
      git(repo, {}, 'add', '-A')
      git(repo, {}, 'commit', '-q', '-m', 'init')
      git(repo, {}, 'tag', 'v1.0.0')
      git(repo, {}, 'worktree', 'add', '-q', '--detach', wt)
      stubCheckDeep(wt, seen)

      const r = push(wt, { AGENTHYDRA_VISIBILITY_STUB: 'private' }, 'v1.0.0')
      expect(r.status).toBe(0)
      const inherited = readFileSync(seen, 'utf8')
      expect(inherited).not.toMatch(/^GIT_(DIR|WORK_TREE|INDEX_FILE)=/m)
    },
    HOOK_TEST_TIMEOUT,
  )
})

describe('check-public-push.mjs: the parsers', () => {
  test('parseGithubSlug accepts every URL shape git uses for GitHub, with or without .git', () => {
    for (const url of [
      'https://github.com/LunarWerxs/AgentHydra.git',
      'https://github.com/LunarWerxs/AgentHydra',
      'git@github.com:LunarWerxs/AgentHydra.git',
      'ssh://git@github.com/LunarWerxs/AgentHydra.git',
      'https://github.com/LunarWerxs/AgentHydra/',
    ]) {
      expect(parseGithubSlug(url)).toEqual({ owner: 'LunarWerxs', repo: 'AgentHydra' })
    }
    expect(parseGithubSlug('https://gitlab.com/o/r.git')).toBeNull()
    expect(parseGithubSlug('C:/tmp/origin')).toBeNull()
  })

  test('parseRefLines tells a deletion (all-zero local sha) from a push', () => {
    const refs = parseRefLines(
      'refs/heads/main abc123 refs/heads/main 000\n' +
        '(delete) 0000000000000000000000000000000000000000 refs/tags/v0.8.0 def456\n',
    )
    expect(refs).toHaveLength(2)
    expect(refs[0]?.isDelete).toBe(false)
    expect(refs[1]?.isDelete).toBe(true)
    expect(refs[1]?.remoteRef).toBe('refs/tags/v0.8.0')
  })

  test('openTodoSections counts headings after Contents, or all but the state of play without it', () => {
    const dir = prepushRoot('todo')
    try {
      const file = join(dir, 'TODO.md')
      writeFileSync(file, '# t\n\n## ⭐ STATE OF PLAY\n\n## Contents\n\n## 1. A\n\n## 2. B\n')
      expect(openTodoSections(file)).toEqual(['1. A', '2. B'])
      writeFileSync(file, '# t\n\n## ⭐ STATE OF PLAY, 2026-09-12\n\n## Only thing\n')
      expect(openTodoSections(file)).toEqual(['Only thing'])
      expect(openTodoSections(join(dir, 'missing.md'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
