// tests/githooks/check-public-push-audit.test.ts - rules 4 to 7 of the pre-push gate. A pushed ref
// whose history holds upstream's relicensing commit is refused on every remote, override or not, and
// so is a ref that shares any of upstream's history or has a root other than the import commit, and
// a tag on upstream's history or on its tree (the import commit); scripts/audit-public.mjs runs over
// what each push carries, so a push that would publish a mailbox never lands, lands once that one
// finding is in the allowlist, and is refused when the audit cannot run at all.
//
// None of upstream's commits is in a throwaway repo, and CI's clones of this repository do not have
// them either, so upstream's history is built in miniature: an "upstream base" with a commit before
// it, and an import commit with the base's tree and no parent, which this repository's own commits
// sit on, as they sit on the real import commit.
//
// The end-to-end tests drive the real, on-disk .githooks/pre-push, check-public-push.mjs,
// scripts/audit-public.mjs, its config and server/src/secrets.ts (copied fresh at test time) against a
// throwaway repo pushing to a throwaway bare origin, as pre-push-public-guard.test.ts does for rules 1
// to 3. The sandbox's copy of the audit config names the sandbox's own commits: its first commit as
// the base (the import commit) with that commit's tree as baseTree, an orphan commit with the same
// tree as upstreamBase, and another commit as licenseBoundary. Rules 4, 6 and 7 read them from there
// exactly as they read the real ones here. Visibility is stubbed through the environment, so nothing
// reaches the network or this repo's own remote.
//
// Every value the audit must find is built at run time (see tests/audit-public.test.ts), because the
// audit reads this file too.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  foreignRootRefusals,
  IMPORT_COMMIT,
  importCommit,
  LICENSE_BOUNDARY,
  licenseBoundaries,
  licenseRefusals,
  parseRefLines,
  RELEASE_WORKFLOW,
  runPushAudit,
  UPSTREAM_BASE,
  UPSTREAM_TREE,
  upstreamBases,
  upstreamHistoryRefusals,
  upstreamTagRefusals,
  upstreamTrees,
} from '../../.githooks/check-public-push.mjs'
import {
  LICENSE_BOUNDARY as AUDIT_LICENSE_BOUNDARY,
  fingerprint,
  loadAuditFiles,
} from '../../scripts/audit-public.mjs'
import { REPO_ROOT } from '../repo-root'

// Real git, and per push Git for Windows' sh, a node start and a bun start for the audit. See
// pre-push-public-guard.test.ts for the measurements behind 45 s; a test that pushes more than once
// gets it per push.
const HOOK_TEST_TIMEOUT = 45_000

const ROOT = mkdtempSync(join(tmpdir(), 'ah-prepush-audit-'))
const FILE_ROOT = realpathSync.native(ROOT)
let seq = 0
function scratch(name: string) {
  const dir = join(FILE_ROOT, `${name}-${seq++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
// Removing every throwaway repository at the end can outlast bun's 5 s hook default on a loaded box.
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
}, HOOK_TEST_TIMEOUT)

const j = (...parts: string[]) => parts.join('')
const MAILBOX = j('pat.person', '@', 'mail-fixture', '.zz')
const NOREPLY = 'fixture@users.noreply.github.com'
const ZERO = '0'.repeat(40)

type Env = Record<string, string>

/** The test's own environment never leaks a real override or stub into the sandbox. */
function envFor(overrides: Env = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.AGENTHYDRA_PUSH_PUBLIC
  delete env.AGENTHYDRA_VISIBILITY_STUB
  delete env.GITHUB_ACTIONS
  return { ...env, ...overrides }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      `user.email=${NOREPLY}`,
      '-c',
      'user.name=Fixture',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      '-c',
      'push.negotiate=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', timeout: HOOK_TEST_TIMEOUT, env: envFor() },
  ).trim()
}

/** Writes `files`, commits exactly those paths, and returns the new commit's sha. */
function commit(dir: string, files: Record<string, string>, message: string, email = NOREPLY) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  const paths = Object.keys(files)
  if (paths.length) git(dir, 'add', '--', ...paths)
  git(dir, '-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

/**
 * Upstream's history in miniature, beside `main`: `before`, then `upstreamBase` with `tree`, both on
 * their own root, and `imported`, the import commit: the same tree, no parent. `main` is checked out
 * at `own`, a commit of this repository's own on top of `imported`.
 */
function upstreamInMiniature(dir: string) {
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'checkout', '-q', '--orphan', 'upstream')
  const before = commit(dir, { 'a.txt': 'a\n' }, 'upstream, before its last MIT commit')
  const upstreamBase = commit(dir, { 'b.txt': 'b\n' }, "upstream's last MIT commit")
  const tree = git(dir, 'rev-parse', `${upstreamBase}^{tree}`)
  const imported = git(dir, 'commit-tree', tree, '-m', 'the import commit')
  git(dir, 'checkout', '-q', '-B', 'main', imported)
  const own = commit(dir, { 'c.txt': 'c\n' }, 'own work')
  return { before, upstreamBase, tree, imported, own }
}

/** A clone of `branch` alone over the pack protocol, so it holds only what that branch reaches: as a
 *  clone of this repository holds none of upstream's commits. */
function cloneOf(dir: string, branch: string) {
  const to = scratch('clone')
  const url = pathToFileURL(dir).href
  git(to, 'clone', '-q', '--no-local', '--single-branch', '--no-tags', '-b', branch, url, '.')
  return to
}

// --- rule 4's pieces, without a push -------------------------------------------------------------

describe('rule 4: the relicensing commit', () => {
  test('the hook, the audit and the audit config name the same boundary commit', () => {
    expect(LICENSE_BOUNDARY).toMatch(/^[0-9a-f]{40}$/)
    expect(AUDIT_LICENSE_BOUNDARY).toBe(LICENSE_BOUNDARY)
    expect(loadAuditFiles().config.licenseBoundary).toBe(LICENSE_BOUNDARY)
    expect(licenseBoundaries(REPO_ROOT)).toEqual([LICENSE_BOUNDARY])
  })

  test('the config can add a boundary, never take the built-in one away', () => {
    const dir = scratch('boundaries')
    expect(licenseBoundaries(dir)).toEqual([LICENSE_BOUNDARY])
    const other = 'ab'.repeat(20)
    mkdirSync(join(dir, 'scripts'))
    const cfg = join(dir, 'scripts', 'audit-public.config.json')
    writeFileSync(cfg, JSON.stringify({ licenseBoundary: other }))
    expect(licenseBoundaries(dir)).toEqual([LICENSE_BOUNDARY, other])
    writeFileSync(cfg, JSON.stringify({ licenseBoundary: 'not a sha' }))
    expect(licenseBoundaries(dir)).toEqual([LICENSE_BOUNDARY])
    writeFileSync(cfg, '{ not json')
    expect(licenseBoundaries(dir)).toEqual([LICENSE_BOUNDARY])
  })

  test(
    'a ref with the boundary in its history is refused; a sibling, a deletion and an absent boundary are not',
    () => {
      const dir = scratch('refusals')
      git(dir, 'init', '-q', '-b', 'main')
      const root = commit(dir, { 'a.txt': 'a\n' }, 'root')
      git(dir, 'checkout', '-q', '-b', 'upstream')
      const boundary = commit(dir, { LICENSE: 'relicensed\n' }, 'boundary')
      const after = commit(dir, { 'b.txt': 'b\n' }, 'after the boundary')
      git(dir, 'checkout', '-q', 'main')
      const sibling = commit(dir, { 'c.txt': 'c\n' }, 'beside it')
      git(dir, 'tag', '-a', '-m', 'annotated', 'past', after)
      const tagObject = git(dir, 'rev-parse', 'past')

      const refs = parseRefLines(
        [
          `refs/heads/upstream ${after} refs/heads/upstream ${ZERO}`,
          `refs/heads/main ${sibling} refs/heads/main ${root}`,
          `(delete) ${ZERO} refs/heads/old ${after}`,
          `refs/tags/past ${tagObject} refs/tags/past ${ZERO}`,
          `refs/heads/exact ${boundary} refs/heads/exact ${ZERO}`,
        ].join('\n'),
      )
      const refused = licenseRefusals(refs, [boundary], dir)
      expect(refused.map((r) => r.ref)).toEqual([
        'refs/heads/upstream',
        'refs/tags/past',
        'refs/heads/exact',
      ])
      expect(refused[0]?.why).toContain(boundary.slice(0, 8))

      // A boundary this clone does not have cannot be in any of its refs' history.
      expect(licenseRefusals(refs, ['cd'.repeat(20)], dir)).toEqual([])
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'a checkout without the audit script has nothing to run and passes rule 5',
    () => {
      const dir = scratch('no-script')
      git(dir, 'init', '-q', '-b', 'main')
      const sha = commit(dir, { 'a.txt': 'a\n' }, 'init')
      expect(runPushAudit(`refs/heads/main ${sha} refs/heads/main ${ZERO}\n`, 'origin', dir)).toBe(
        0,
      )
    },
    HOOK_TEST_TIMEOUT,
  )
})

// --- rules 6 and 7's pieces, without a push ------------------------------------------------------

describe("rules 6 and 7: upstream's base and its tree", () => {
  test("the hook names upstream's last MIT commit and its tree, and the config can only add to them", () => {
    expect(UPSTREAM_BASE).toMatch(/^[0-9a-f]{40}$/)
    expect(UPSTREAM_TREE).toMatch(/^[0-9a-f]{40}$/)
    expect(upstreamBases(REPO_ROOT)).toEqual([UPSTREAM_BASE])
    expect(upstreamTrees(REPO_ROOT)).toEqual([UPSTREAM_TREE])
    // The audit config names the same two, beside its own base, the import commit, which has that
    // tree and is none of upstream's commits.
    const config = loadAuditFiles().config
    expect(config.upstreamBase).toBe(UPSTREAM_BASE)
    expect(config.baseTree).toBe(UPSTREAM_TREE)
    expect(config.base).not.toBe(UPSTREAM_BASE)
    // A checkout without the config still knows them.
    const dir = scratch('upstream-config')
    expect(upstreamBases(dir)).toEqual([UPSTREAM_BASE])
    expect(upstreamTrees(dir)).toEqual([UPSTREAM_TREE])

    mkdirSync(join(dir, 'scripts'))
    const cfg = join(dir, 'scripts', 'audit-public.config.json')
    const commitId = 'ab'.repeat(20)
    const treeId = 'cd'.repeat(20)
    // The config's base, the import commit, is not what these rules read.
    writeFileSync(cfg, JSON.stringify({ base: 'ef'.repeat(20) }))
    expect(upstreamBases(dir)).toEqual([UPSTREAM_BASE])
    expect(upstreamTrees(dir)).toEqual([UPSTREAM_TREE])
    writeFileSync(cfg, JSON.stringify({ upstreamBase: commitId, baseTree: treeId }))
    expect(upstreamBases(dir)).toEqual([UPSTREAM_BASE, commitId])
    expect(upstreamTrees(dir)).toEqual([UPSTREAM_TREE, treeId])
    writeFileSync(cfg, JSON.stringify({ upstreamBase: 'not a sha', baseTree: UPSTREAM_TREE }))
    expect(upstreamBases(dir)).toEqual([UPSTREAM_BASE])
    expect(upstreamTrees(dir)).toEqual([UPSTREAM_TREE])
  })

  test(
    "rule 6: a tag on upstream's history or on the import commit is refused; a later tag, a branch and a deletion are not",
    () => {
      const dir = scratch('upstream-tags')
      const { before, upstreamBase, tree, imported, own } = upstreamInMiniature(dir)
      git(dir, 'tag', '-a', '-m', 'annotated', 'old-release', before)
      const tagObject = git(dir, 'rev-parse', 'old-release')

      const refs = parseRefLines(
        [
          `refs/tags/old-release ${tagObject} refs/tags/old-release ${ZERO}`,
          `refs/tags/at-base ${upstreamBase} refs/tags/at-base ${ZERO}`,
          `refs/tags/imported ${imported} refs/tags/imported ${ZERO}`,
          `refs/tags/own ${own} refs/tags/own ${ZERO}`,
          `refs/heads/main ${own} refs/heads/main ${ZERO}`,
          `refs/heads/old ${before} refs/heads/old ${ZERO}`,
          `(delete) ${ZERO} refs/tags/gone ${before}`,
        ].join('\n'),
      )
      const upstream = { bases: [upstreamBase], trees: [tree] }
      const refused = upstreamTagRefusals(refs, upstream, dir)
      expect(refused.map((r) => r.ref)).toEqual([
        'refs/tags/old-release',
        'refs/tags/at-base',
        'refs/tags/imported',
      ])
      expect(refused[0]?.why).toContain(before.slice(0, 8))
      expect(refused[0]?.why).toContain(upstreamBase.slice(0, 8))
      expect(refused[2]?.why).toBe(
        `it points at ${imported.slice(0, 8)}, whose tree is upstream's ${tree.slice(0, 8)}`,
      )

      // A base this clone does not have is in no tag's history; the tree still refuses the import
      // commit, and the base's own commit, which has that tree too.
      const absent = { bases: ['cd'.repeat(20)], trees: [tree] }
      expect(upstreamTagRefusals(refs, absent, dir).map((r) => r.ref)).toEqual([
        'refs/tags/at-base',
        'refs/tags/imported',
      ])
      expect(upstreamTagRefusals(refs, { bases: ['cd'.repeat(20)] }, dir)).toEqual([])
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    "rule 6 in a clone without upstream's commits: the import commit is still refused, own tags are not",
    () => {
      const dir = scratch('upstream-tags-src')
      const { upstreamBase, tree, imported, own } = upstreamInMiniature(dir)
      const clone = cloneOf(dir, 'main')
      const refs = parseRefLines(
        [
          `refs/tags/imported ${imported} refs/tags/imported ${ZERO}`,
          `refs/tags/own ${own} refs/tags/own ${ZERO}`,
        ].join('\n'),
      )
      const refused = upstreamTagRefusals(refs, { bases: [upstreamBase], trees: [tree] }, clone)
      expect(refused.map((r) => r.ref)).toEqual(['refs/tags/imported'])
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    "rule 6: a tag on a commit that still has upstream's release.yml is refused; once release.yml is this repository's, it is not",
    () => {
      // Upstream's tree with a release workflow of its own, the import commit with that tree, then
      // this repository's commits: one that keeps upstream's release.yml, one that replaces it, one
      // after it, and, beside them, one that removes it.
      const dir = scratch('upstream-workflow')
      git(dir, 'init', '-q', '-b', 'main')
      git(dir, 'checkout', '-q', '--orphan', 'upstream')
      const upstreamBase = commit(
        dir,
        { [RELEASE_WORKFLOW]: "name: upstream's release\n", 'a.txt': 'a\n' },
        "upstream's last MIT commit",
      )
      const tree = git(dir, 'rev-parse', `${upstreamBase}^{tree}`)
      const imported = git(dir, 'commit-tree', tree, '-m', 'the import commit')
      git(dir, 'checkout', '-q', '-B', 'main', imported)
      const early = commit(dir, { 'c.txt': 'c\n' }, "own work, upstream's release.yml still in it")
      git(dir, 'checkout', '-q', '-b', 'without', early)
      git(dir, 'rm', '-q', RELEASE_WORKFLOW)
      const removed = commit(dir, {}, 'own work, no release workflow at all')
      git(dir, 'checkout', '-q', 'main')
      const channel = commit(
        dir,
        { [RELEASE_WORKFLOW]: 'name: release, with a channel job\n' },
        "release.yml becomes this repository's",
      )
      const later = commit(dir, { 'd.txt': 'd\n' }, 'later work')
      git(dir, 'tag', '-a', '-m', 'annotated', 'early-annotated', early)
      const tagObject = git(dir, 'rev-parse', 'early-annotated')
      const workflow = git(dir, 'rev-parse', `${tree}:${RELEASE_WORKFLOW}`)

      const refs = parseRefLines(
        [
          `refs/tags/v2026.10.0 ${early} refs/tags/v2026.10.0 ${ZERO}`,
          `refs/tags/early-annotated ${tagObject} refs/tags/early-annotated ${ZERO}`,
          `refs/tags/removed ${removed} refs/tags/removed ${ZERO}`,
          `refs/tags/channel ${channel} refs/tags/channel ${ZERO}`,
          `refs/tags/later ${later} refs/tags/later ${ZERO}`,
          `refs/heads/early ${early} refs/heads/early ${ZERO}`,
        ].join('\n'),
      )
      const upstream = { bases: [], trees: [tree] }
      const refused = upstreamTagRefusals(refs, upstream, dir)
      expect(refused.map((r) => r.ref)).toEqual([
        'refs/tags/v2026.10.0',
        'refs/tags/early-annotated',
      ])
      expect(refused[0]?.why).toBe(
        `it points at ${early.slice(0, 8)}, whose ${RELEASE_WORKFLOW} is still upstream's ${workflow.slice(0, 8)}`,
      )
      // Without upstream's tree to read it from, there is no workflow of upstream's to compare.
      expect(upstreamTagRefusals(refs, { bases: [], trees: [] }, dir)).toEqual([])
      // A clone of this repository's branch alone still has the import commit's tree, and so the
      // workflow.
      const clone = cloneOf(dir, 'main')
      const inClone = upstreamTagRefusals(refs.slice(0, 1).concat(refs.slice(3)), upstream, clone)
      expect(inClone.map((r) => r.ref)).toEqual(['refs/tags/v2026.10.0'])
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    "rule 7: a ref that shares upstream's history is refused, whatever it shares; this repository's own history is not",
    () => {
      const dir = scratch('upstream-history')
      const { before, upstreamBase, own } = upstreamInMiniature(dir)
      git(dir, 'checkout', '-q', '-b', 'later', upstreamBase)
      const later = commit(dir, { 'd.txt': 'd\n' }, 'upstream, after its last MIT commit')
      git(dir, 'checkout', '-q', '-b', 'merged', own)
      git(dir, 'merge', '-q', '--no-edit', '--allow-unrelated-histories', 'upstream')
      const merged = git(dir, 'rev-parse', 'HEAD')
      git(dir, 'tag', '-a', '-m', 'annotated', 'checkpoint', own)
      const tagObject = git(dir, 'rev-parse', 'checkpoint')

      const refs = parseRefLines(
        [
          `refs/heads/main ${own} refs/heads/main ${ZERO}`,
          `refs/heads/later ${later} refs/heads/later ${ZERO}`,
          `refs/heads/older ${before} refs/heads/older ${ZERO}`,
          `refs/heads/merged ${merged} refs/heads/merged ${own}`,
          `refs/tags/checkpoint ${tagObject} refs/tags/checkpoint ${ZERO}`,
          `(delete) ${ZERO} refs/heads/gone ${later}`,
        ].join('\n'),
      )
      const refused = upstreamHistoryRefusals(refs, [upstreamBase], dir)
      expect(refused.map((r) => r.ref)).toEqual([
        'refs/heads/later',
        'refs/heads/older',
        'refs/heads/merged',
      ])
      const base = upstreamBase.slice(0, 8)
      expect(refused[0]?.why).toBe(`its history contains ${base}`)
      expect(refused[1]?.why).toBe(
        `its history contains ${before.slice(0, 8)}, in the history of ${base}`,
      )
      expect(refused[2]?.why).toBe(`its history contains ${base}`)
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    "rule 7 in a clone without upstream's commits: there is nothing to share, and this repository's own history passes",
    () => {
      const dir = scratch('upstream-history-src')
      const { upstreamBase, imported, own } = upstreamInMiniature(dir)
      const clone = cloneOf(dir, 'main')
      expect(
        spawnSync('git', ['cat-file', '-e', `${upstreamBase}^{commit}`], { cwd: clone }).status,
      ).not.toBe(0)
      const refs = parseRefLines(`refs/heads/main ${own} refs/heads/main ${ZERO}\n`)
      expect(upstreamHistoryRefusals(refs, [upstreamBase], clone)).toEqual([])
      // The real one is in no throwaway repo either.
      expect(upstreamHistoryRefusals(refs, upstreamBases(clone), clone)).toEqual([])
      expect(foreignRootRefusals(refs, imported, clone)).toEqual([])
    },
    HOOK_TEST_TIMEOUT,
  )

  test("rule 7's root is the audit config's base, and the import commit without a config", () => {
    expect(IMPORT_COMMIT).toMatch(/^[0-9a-f]{40}$/)
    expect(loadAuditFiles().config.base).toBe(IMPORT_COMMIT)
    expect(importCommit(REPO_ROOT)).toBe(IMPORT_COMMIT)
    const dir = scratch('import-config')
    expect(importCommit(dir)).toBe(IMPORT_COMMIT)
    mkdirSync(join(dir, 'scripts'))
    const cfg = join(dir, 'scripts', 'audit-public.config.json')
    const other = 'ef'.repeat(20)
    writeFileSync(cfg, JSON.stringify({ base: other.toUpperCase() }))
    expect(importCommit(dir)).toBe(other)
    writeFileSync(cfg, JSON.stringify({ base: 'not a sha' }))
    expect(importCommit(dir)).toBe(IMPORT_COMMIT)
    writeFileSync(cfg, '{ not json')
    expect(importCommit(dir)).toBe(IMPORT_COMMIT)
  })

  test(
    "rule 7 without upstream's commits: a ref with a root other than the import commit is refused, an older upstream tag included",
    () => {
      const dir = scratch('foreign-roots-src')
      const { before, upstreamBase, imported, own } = upstreamInMiniature(dir)
      git(dir, 'tag', 'older', before)
      // A clone of this repository's branch alone, then one of upstream's older tags fetched on its
      // own, as `git fetch upstream tag <older>` does: its history, without upstreamBase.
      const clone = cloneOf(dir, 'main')
      git(clone, 'fetch', '-q', '--no-tags', 'origin', 'refs/tags/older:refs/tags/older')
      expect(
        spawnSync('git', ['cat-file', '-e', `${upstreamBase}^{commit}`], { cwd: clone }).status,
      ).not.toBe(0)
      git(clone, 'checkout', '-q', '-b', 'merged', own)
      git(clone, 'merge', '-q', '--no-edit', '--allow-unrelated-histories', 'older')
      const merged = git(clone, 'rev-parse', 'HEAD')
      git(clone, 'checkout', '-q', '--orphan', 'stray')
      git(clone, 'rm', '-rq', '--cached', '.')
      const stray = commit(clone, { 'stray.txt': 'x\n' }, 'a root of its own')
      git(clone, 'tag', '-a', '-m', 'annotated', 'own-tag', own)
      const tagObject = git(clone, 'rev-parse', 'own-tag')

      const refs = parseRefLines(
        [
          `refs/tags/older ${before} refs/tags/older ${ZERO}`,
          `refs/heads/merged ${merged} refs/heads/merged ${own}`,
          `refs/heads/stray ${stray} refs/heads/stray ${ZERO}`,
          `refs/heads/main ${own} refs/heads/main ${ZERO}`,
          `refs/tags/own-tag ${tagObject} refs/tags/own-tag ${ZERO}`,
          `(delete) ${ZERO} refs/heads/gone ${before}`,
        ].join('\n'),
      )
      // The merge-base half has nothing to look for here; the roots half needs no upstream object.
      expect(upstreamHistoryRefusals(refs, [upstreamBase], clone)).toEqual([])
      expect(upstreamTagRefusals(refs, { bases: [upstreamBase] }, clone)).toEqual([])
      const refused = foreignRootRefusals(refs, imported, clone)
      expect(refused.map((r) => r.ref)).toEqual([
        'refs/tags/older',
        'refs/heads/merged',
        'refs/heads/stray',
      ])
      const at = imported.slice(0, 8)
      expect(refused[0]?.why).toBe(
        `its history has the root commit ${before.slice(0, 8)}, not only the import commit ${at}`,
      )
      expect(refused[1]?.why).toBe(
        `its history has the root commit ${before.slice(0, 8)}, not only the import commit ${at}`,
      )
      expect(refused[2]?.why).toBe(
        `its history has the root commit ${stray.slice(0, 8)}, not only the import commit ${at}`,
      )
      // A root this clone does not have: none of this repository's history is here to check.
      expect(foreignRootRefusals(refs, 'cd'.repeat(20), clone)).toEqual([])
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'rule 7 in a shallow clone: a commit cut off from its parents is refused as history that cannot be told',
    () => {
      const dir = scratch('foreign-roots-shallow-src')
      const { imported, own } = upstreamInMiniature(dir)
      git(dir, 'checkout', '-q', '-b', 'side', own)
      commit(dir, { 'd.txt': 'd\n' }, 'side, one')
      const tip = commit(dir, { 'd.txt': 'e\n' }, 'side, two')
      const clone = cloneOf(dir, 'main')
      git(clone, 'fetch', '-q', '--depth', '1', 'origin', 'side')
      const refs = parseRefLines(
        [
          `refs/heads/main ${own} refs/heads/main ${ZERO}`,
          `refs/heads/side ${tip} refs/heads/side ${ZERO}`,
        ].join('\n'),
      )
      const refused = foreignRootRefusals(refs, imported, clone)
      expect(refused.map((r) => r.ref)).toEqual(['refs/heads/side'])
      expect(refused[0]?.why).toBe(
        `this shallow clone cuts its history off at ${tip.slice(0, 8)}, so whether it starts at the import commit ${imported.slice(0, 8)} cannot be told (git fetch --unshallow)`,
      )
    },
    HOOK_TEST_TIMEOUT,
  )
})

// --- rules 6 and 7 on this repository's own history ----------------------------------------------

/** Whether this clone has `sha` as a commit: ci.yml's shallow checkouts do not reach the import commit. */
function hasCommit(sha: string): boolean {
  return spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: REPO_ROOT }).status === 0
}

describe('this repository', () => {
  test.skipIf(!hasCommit(IMPORT_COMMIT))(
    "rule 6 refuses a tag on its first commit, which still has upstream's release.yml, and not on HEAD; rule 7 passes HEAD",
    () => {
      const first = execFileSync(
        'git',
        ['rev-list', '--reverse', '--ancestry-path', `${IMPORT_COMMIT}..HEAD`],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: HOOK_TEST_TIMEOUT },
      )
        .split('\n')[0]
        ?.trim()
      expect(first).toMatch(/^[0-9a-f]{40}$/)
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim()
      const refs = parseRefLines(
        [
          `refs/tags/v2026.10.0 ${first} refs/tags/v2026.10.0 ${ZERO}`,
          `refs/tags/v2026.10.1 ${head} refs/tags/v2026.10.1 ${ZERO}`,
        ].join('\n'),
      )
      // Only trees and blobs are read here: the import commit's, never a file of upstream's history.
      const upstream = { bases: [], trees: upstreamTrees(REPO_ROOT) }
      const refused = upstreamTagRefusals(refs, upstream, REPO_ROOT)
      expect(refused.map((r) => r.ref)).toEqual(['refs/tags/v2026.10.0'])
      expect(refused[0]?.why).toContain(`whose ${RELEASE_WORKFLOW} is still upstream's`)
      expect(foreignRootRefusals(refs.slice(1), importCommit(REPO_ROOT), REPO_ROOT)).toEqual([])
    },
    HOOK_TEST_TIMEOUT,
  )
})

// --- rule 5's verdict, without a push ------------------------------------------------------------

describe("rule 5: what the audit's exit means", () => {
  const refText = `refs/heads/main ${'ab'.repeat(20)} refs/heads/main ${ZERO}\n`
  /** A checkout whose audit script is a stub that ends as `body` says. */
  function withAudit(body: string) {
    const dir = scratch('verdict')
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'scripts', 'audit-public.mjs'), body)
    return dir
  }

  test.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 2],
    [134, 2],
  ])(
    'an audit that exits %d is read as %d: clean, a finding, or no verdict',
    (code, verdict) => {
      expect(runPushAudit(refText, 'origin', withAudit(`process.exit(${code})\n`))).toBe(verdict)
    },
    HOOK_TEST_TIMEOUT,
  )

  test.skipIf(process.platform === 'win32')(
    'an audit killed by a signal gives no verdict, not a finding',
    () => {
      const dir = withAudit("process.kill(process.pid, 'SIGKILL')\n")
      expect(runPushAudit(refText, 'origin', dir)).toBe(2)
    },
    HOOK_TEST_TIMEOUT,
  )
})

// --- the real hook, end to end -------------------------------------------------------------------

const COPIED = [
  '.githooks/pre-push',
  '.githooks/check-public-push.mjs',
  'scripts/audit-public.mjs',
  'server/src/secrets.ts',
]

interface PushResult {
  status: number
  output: string
}

function push(repo: string, env: Env, ...refs: string[]): PushResult {
  const r = spawnSync(
    'git',
    [
      '-c',
      `user.email=${NOREPLY}`,
      '-c',
      'user.name=Fixture',
      '-c',
      'push.negotiate=false',
      'push',
      'origin',
      ...refs,
    ],
    { cwd: repo, encoding: 'utf8', timeout: HOOK_TEST_TIMEOUT, env: envFor(env) },
  )
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** Whether the bare origin holds `rev`: a ref name, or a commit sha (which rev-parse alone would
 *  accept by its shape). */
function originHas(origin: string, rev: string): boolean {
  const r = spawnSync('git', ['cat-file', '-e', `${rev}^{commit}`], {
    cwd: origin,
    encoding: 'utf8',
    timeout: HOOK_TEST_TIMEOUT,
  })
  return r.status === 0
}

describe('.githooks/pre-push: rules 4 to 7, end to end', () => {
  const PRIVATE = { AGENTHYDRA_VISIBILITY_STUB: 'private' }
  let repo: string
  let origin: string
  let boundary: string
  let upstreamBefore: string
  let upstreamBase: string
  let allowFile: string

  beforeEach(() => {
    const sandbox = scratch('sandbox')
    repo = join(sandbox, 'repo')
    origin = join(sandbox, 'origin')
    mkdirSync(repo)
    git(sandbox, 'init', '-q', '--bare', origin)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'core.hooksPath', '.githooks')
    git(repo, 'remote', 'add', 'origin', origin)

    // Byte-identical copies of the real files, read fresh every run, committed as the base: the
    // sandbox's import commit.
    const files: Record<string, string> = {}
    for (const path of COPIED) files[path] = readFileSync(join(REPO_ROOT, path), 'utf8')
    const base = commit(repo, files, 'the hook and the audit, as this repository has them')
    chmodSync(join(repo, '.githooks', 'pre-push'), 0o755) // git on POSIX refuses a non-executable hook
    git(repo, 'push', '-q', '--no-verify', 'origin', 'main')

    git(repo, 'checkout', '-q', '-b', 'upstream')
    boundary = commit(repo, { LICENSE: 'relicensed\n' }, 'the relicensing commit, in miniature')
    git(repo, 'checkout', '-q', 'main')

    // Upstream's history in miniature, on a root of its own, as in a clone that has upstream's
    // commits beside this repository's: a commit before its last MIT one, and that one with the
    // base's tree, as the real import commit has 3a65ba8e's.
    const baseTree = git(repo, 'rev-parse', `${base}^{tree}`)
    const emptyTree = execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], {
      cwd: repo,
      input: '',
      encoding: 'utf8',
    }).trim()
    upstreamBefore = git(repo, 'commit-tree', emptyTree, '-m', 'upstream, in miniature')
    upstreamBase = git(
      repo,
      'commit-tree',
      baseTree,
      '-p',
      upstreamBefore,
      '-m',
      "upstream's last MIT commit, in miniature",
    )
    git(repo, 'branch', 'upstream-history', upstreamBase)

    // The config, the allowlist and the provenance list are read from the working tree, as in this
    // repository; they stay out of the sandbox's commits so its base can name the commit before them.
    const real = JSON.parse(
      readFileSync(join(REPO_ROOT, 'scripts', 'audit-public.config.json'), 'utf8'),
    )
    const scripts = join(repo, 'scripts')
    writeFileSync(
      join(scripts, 'audit-public.config.json'),
      JSON.stringify({ ...real, base, baseTree, upstreamBase, licenseBoundary: boundary }, null, 2),
    )
    allowFile = join(scripts, 'audit-public.allow.json')
    writeFileSync(allowFile, JSON.stringify({ entries: [] }))
    writeFileSync(join(scripts, 'binary-provenance.json'), JSON.stringify({ binaries: [] }))
  }, HOOK_TEST_TIMEOUT)

  afterEach(() => {
    rmSync(dirname(repo), { recursive: true, force: true })
  })

  test(
    'a branch carrying the boundary commit is refused, even to a private remote',
    () => {
      const r = push(repo, PRIVATE, 'upstream')
      expect(r.status).not.toBe(0)
      expect(r.output).toContain("carries upstream's relicensing commit")
      expect(r.output).toContain(`its history contains ${boundary.slice(0, 8)}`)
      expect(originHas(origin, 'refs/heads/upstream')).toBe(false)
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'a merge that brings the boundary in is refused, and AGENTHYDRA_PUSH_PUBLIC=1 does not override it',
    () => {
      commit(repo, { 'notes.md': 'own work\n' }, 'own work')
      git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'upstream')
      const r = push(
        repo,
        { AGENTHYDRA_VISIBILITY_STUB: 'public', AGENTHYDRA_PUSH_PUBLIC: '1' },
        'main',
      )
      expect(r.status).not.toBe(0)
      expect(r.output).toContain("carries upstream's relicensing commit")
      expect(r.output).toContain('refs/heads/main')
      expect(git(origin, 'rev-list', '--count', 'main')).toBe('1')
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    "a tag on the import commit or on upstream's history is refused, even to a private remote; a tag on a later commit lands",
    () => {
      const base = git(repo, 'rev-parse', 'main')
      git(repo, 'tag', 'v2.0.4', base)
      const onImport = push(repo, PRIVATE, 'refs/tags/v2.0.4')
      expect(onImport.status).not.toBe(0)
      expect(onImport.output).toContain("a pushed tag is one of upstream's")
      expect(onImport.output).toContain(
        `refs/tags/v2.0.4: it points at ${base.slice(0, 8)}, whose tree is upstream's`,
      )
      expect(originHas(origin, 'refs/tags/v2.0.4')).toBe(false)

      git(repo, 'tag', '-a', '-m', "upstream's", 'v2.0.3', upstreamBefore)
      const onUpstream = push(repo, PRIVATE, 'refs/tags/v2.0.3')
      expect(onUpstream.status).not.toBe(0)
      expect(onUpstream.output).toContain("a pushed tag is one of upstream's")
      expect(onUpstream.output).toContain(
        `refs/tags/v2.0.3: it points at ${upstreamBefore.slice(0, 8)}, in the history of ${upstreamBase.slice(0, 8)}`,
      )
      expect(originHas(origin, upstreamBefore)).toBe(false)

      const own = commit(repo, { 'notes.md': 'own work\n' }, 'own work')
      git(repo, 'tag', 'checkpoint', own)
      const landed = push(repo, PRIVATE, 'main', 'refs/tags/checkpoint')
      expect(landed.status).toBe(0)
      expect(originHas(origin, 'refs/tags/checkpoint')).toBe(true)
    },
    HOOK_TEST_TIMEOUT * 3,
  )

  test(
    "a branch carrying upstream's history is refused, even to a private remote, and so is a merge that brings it in, override or not",
    () => {
      const refused = push(repo, PRIVATE, 'upstream-history')
      expect(refused.status).not.toBe(0)
      expect(refused.output).toContain("a pushed ref carries upstream's history")
      expect(refused.output).toContain(
        `refs/heads/upstream-history: its history contains ${upstreamBase.slice(0, 8)}`,
      )
      expect(originHas(origin, upstreamBase)).toBe(false)

      commit(repo, { 'notes.md': 'own work\n' }, 'own work')
      git(repo, 'merge', '-q', '--no-edit', '--allow-unrelated-histories', 'upstream-history')
      const merged = push(
        repo,
        { AGENTHYDRA_VISIBILITY_STUB: 'public', AGENTHYDRA_PUSH_PUBLIC: '1' },
        'main',
      )
      expect(merged.status).not.toBe(0)
      expect(merged.output).toContain("a pushed ref carries upstream's history")
      expect(merged.output).toContain('refs/heads/main')
      expect(git(origin, 'rev-list', '--count', 'main')).toBe('1')
      expect(originHas(origin, upstreamBase)).toBe(false)
    },
    HOOK_TEST_TIMEOUT * 2,
  )

  test(
    'a branch on a root of its own is refused before the audit runs, and so is a merge of one, override or not',
    () => {
      const base = git(repo, 'rev-parse', 'main')
      git(repo, 'checkout', '-q', '--orphan', 'stray')
      const stray = commit(repo, { 'notes.md': 'nothing to see\n' }, 'another root')
      const r = push(repo, PRIVATE, 'stray')
      expect(r.status).not.toBe(0)
      expect(r.output).toContain(
        "a pushed ref carries upstream's history, or history from another root",
      )
      expect(r.output).toContain(
        `refs/heads/stray: its history has the root commit ${stray.slice(0, 8)}, not only the import commit ${base.slice(0, 8)}`,
      )
      expect(r.output).not.toContain('audit:public')
      expect(originHas(origin, stray)).toBe(false)

      // Merged into main, the stray root is under a commit that is built on the base. The checkout
      // writes the hook back as it was committed, before it was made executable.
      git(repo, 'checkout', '-q', '-f', 'main')
      chmodSync(join(repo, '.githooks', 'pre-push'), 0o755)
      git(repo, 'merge', '-q', '--no-edit', '--allow-unrelated-histories', 'stray')
      const merged = push(
        repo,
        { AGENTHYDRA_VISIBILITY_STUB: 'public', AGENTHYDRA_PUSH_PUBLIC: '1' },
        'main',
      )
      expect(merged.status).not.toBe(0)
      expect(merged.output).toContain(
        `refs/heads/main: its history has the root commit ${stray.slice(0, 8)}, not only the import commit ${base.slice(0, 8)}`,
      )
      expect(git(origin, 'rev-list', '--count', 'main')).toBe('1')
      expect(originHas(origin, stray)).toBe(false)
    },
    HOOK_TEST_TIMEOUT * 2,
  )

  test(
    "a tag on upstream's older history that shares nothing with its last MIT commit is refused by its root",
    () => {
      // As in a clone that fetched one of upstream's older tags without 3a65ba8e: a commit on a root
      // of its own, not in upstreamBase's history, with another tree.
      const base = git(repo, 'rev-parse', 'main')
      const older = execFileSync(
        'git',
        ['commit-tree', `${upstreamBefore}^{tree}`, '-m', 'older'],
        {
          cwd: repo,
          encoding: 'utf8',
          env: envFor({
            GIT_AUTHOR_NAME: 'Fixture',
            GIT_AUTHOR_EMAIL: NOREPLY,
            GIT_COMMITTER_NAME: 'Fixture',
            GIT_COMMITTER_EMAIL: NOREPLY,
          }),
        },
      ).trim()
      git(repo, 'tag', 'v2.0.3', older)
      const r = push(repo, PRIVATE, 'refs/tags/v2.0.3')
      expect(r.status).not.toBe(0)
      expect(r.output).not.toContain("a pushed tag is one of upstream's")
      expect(r.output).toContain(
        `refs/tags/v2.0.3: its history has the root commit ${older.slice(0, 8)}, not only the import commit ${base.slice(0, 8)}`,
      )
      expect(originHas(origin, older)).toBe(false)
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'a clean push is audited and lands',
    () => {
      const sha = commit(repo, { 'notes.md': 'nothing to see\n' }, 'clean work')
      const r = push(repo, PRIVATE, 'main')
      expect(r.output).toContain('push to origin (1 new commits)')
      expect(r.output).toContain('✓ clean')
      expect(r.status).toBe(0)
      expect(git(origin, 'rev-parse', 'main')).toBe(sha)
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'a push that would publish a mailbox is refused without printing it, and lands once that finding is allowed',
    () => {
      const sha = commit(repo, { 'docs/contact.md': `Write to ${MAILBOX}.\n` }, 'contact page')
      const refused = push(repo, PRIVATE, 'main')
      expect(refused.status).not.toBe(0)
      expect(refused.output).toContain('pii.email')
      expect(refused.output).toContain('docs/contact.md:1')
      expect(refused.output).toContain(fingerprint(MAILBOX))
      expect(refused.output).toContain('audit:public found something this push would publish')
      expect(refused.output).not.toContain(MAILBOX)
      expect(originHas(origin, sha)).toBe(false)

      const entry = {
        rule: 'pii.email',
        path: 'docs/contact.md',
        fp: fingerprint(MAILBOX),
        reason: 'A synthetic mailbox at a name no registry hands out.',
      }
      writeFileSync(allowFile, JSON.stringify({ entries: [entry] }))
      const landed = push(repo, PRIVATE, 'main')
      expect(landed.output).toContain('1 finding(s) allowed')
      expect(landed.status).toBe(0)
      expect(git(origin, 'rev-parse', 'main')).toBe(sha)
    },
    HOOK_TEST_TIMEOUT * 2,
  )

  test(
    'an audit that cannot load its token formats refuses the push as "could not run", not as a finding',
    () => {
      // As on a machine whose only runtime cannot load TypeScript: the import of secrets.ts fails.
      rmSync(join(repo, 'server', 'src', 'secrets.ts'))
      const sha = commit(repo, { 'notes.md': 'nothing to see\n' }, 'clean work')
      const r = push(repo, PRIVATE, 'main')
      expect(r.status).not.toBe(0)
      expect(r.output).toContain('server/src/secrets.ts could not be loaded')
      expect(r.output).toContain('audit:public could not run')
      expect(r.output).not.toContain('found something')
      expect(originHas(origin, sha)).toBe(false)
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'a public push with the override is announced and still audited',
    () => {
      commit(repo, { 'docs/contact.md': `Write to ${MAILBOX}.\n` }, 'contact page')
      const r = push(
        repo,
        { AGENTHYDRA_VISIBILITY_STUB: 'public', AGENTHYDRA_PUSH_PUBLIC: '1' },
        'main',
      )
      expect(r.output).toContain('# WARNING: THIS REPOSITORY IS **PUBLIC**')
      expect(r.output).toContain('announced, proceeding')
      expect(r.output).toContain('audit:public found something this push would publish')
      expect(r.status).not.toBe(0)
      expect(git(origin, 'rev-list', '--count', 'main')).toBe('1')
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'a commit email that is not noreply is refused, and an allow entry for it stops the audit instead',
    () => {
      const personal = j('someone', '@', 'mail-fixture', '.zz')
      const sha = commit(repo, { 'notes.md': 'work\n' }, 'work', personal)
      const refused = push(repo, PRIVATE, 'main')
      expect(refused.status).not.toBe(0)
      expect(refused.output).toContain('commit.email')
      expect(refused.output).not.toContain(personal)

      // commit.email cannot be allowed: the allowlist itself is refused, and so is the push.
      const entry = {
        rule: 'commit.email',
        path: '(commit)',
        fp: fingerprint(personal),
        reason: 'tried anyway',
      }
      writeFileSync(allowFile, JSON.stringify({ entries: [entry] }))
      const unrunnable = push(repo, PRIVATE, 'main')
      expect(unrunnable.output).toContain('audit:public could not run')
      expect(unrunnable.status).not.toBe(0)
      expect(originHas(origin, sha)).toBe(false)
    },
    HOOK_TEST_TIMEOUT * 2,
  )

  test(
    'a commit git cherry-pick -x made is refused without naming the commit it was picked from',
    () => {
      git(repo, 'checkout', '-q', '-b', 'side')
      const source = commit(repo, { 'side.md': 'side work\n' }, 'side work')
      git(repo, 'checkout', '-q', 'main')
      git(repo, 'cherry-pick', '-x', source)
      const picked = git(repo, 'rev-parse', 'HEAD')
      const refused = push(repo, PRIVATE, 'main')
      expect(refused.status).not.toBe(0)
      expect(refused.output).toContain('commit.trailer')
      expect(refused.output).toContain('(cherry-pick)')
      expect(refused.output).toContain('audit:public found something this push would publish')
      expect(refused.output).not.toContain(source.slice(0, 7))
      expect(originHas(origin, picked)).toBe(false)

      // The same change picked without -x carries no line naming its source, and goes out.
      git(repo, 'reset', '-q', '--hard', 'HEAD~1')
      git(repo, 'cherry-pick', source)
      const plain = git(repo, 'rev-parse', 'HEAD')
      const pushed = push(repo, PRIVATE, 'main')
      expect(pushed.output).not.toContain('commit.trailer')
      expect(pushed.status).toBe(0)
      expect(originHas(origin, plain)).toBe(true)
    },
    HOOK_TEST_TIMEOUT * 2,
  )

  test(
    "a credited co-author with a noreply address goes out; a tool's own trailer does not",
    () => {
      const tooled = commit(
        repo,
        { 'rewritten.md': 'a contribution, rewritten\n' },
        'Rewritten\n\nCo-authored-by: Example Owner <owner@users.noreply.github.com>\nGenerated-by: Some Tool',
      )
      const refused = push(repo, PRIVATE, 'main')
      expect(refused.status).not.toBe(0)
      expect(refused.output).toContain('commit.trailer')
      expect(refused.output).toContain('(trailer Generated-by)')
      expect(refused.output).toContain('✗ 1 finding(s)') // the credit beside it is none
      expect(originHas(origin, tooled)).toBe(false)

      // The same change with only its author's credit is publishable.
      git(
        repo,
        'commit',
        '-q',
        '--amend',
        '-m',
        'Rewritten\n\nCo-authored-by: Example Owner <owner@users.noreply.github.com>',
      )
      const credited = git(repo, 'rev-parse', 'HEAD')
      expect(git(repo, 'log', '-1', '--format=%(trailers)')).toBe(
        'Co-authored-by: Example Owner <owner@users.noreply.github.com>',
      )
      const pushed = push(repo, PRIVATE, 'main')
      expect(pushed.output).not.toContain('commit.trailer')
      expect(pushed.status).toBe(0)
      expect(originHas(origin, credited)).toBe(true)
    },
    HOOK_TEST_TIMEOUT * 2,
  )
})
