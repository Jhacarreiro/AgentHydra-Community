// tests/githooks/check-public-push-audit.test.ts - rules 4 to 6 of the pre-push gate. A pushed ref
// whose history holds upstream's relicensing commit is refused on every remote, override or not, and
// so is a tag on the MIT base's own history; scripts/audit-public.mjs runs over what each push
// carries, so a push that would publish a mailbox never lands, lands once that one finding is in the
// allowlist, and is refused when the audit cannot run at all.
//
// The end-to-end tests drive the real, on-disk .githooks/pre-push, check-public-push.mjs,
// scripts/audit-public.mjs, its config and server/src/secrets.ts (copied fresh at test time) against a
// throwaway repo pushing to a throwaway bare origin, as pre-push-public-guard.test.ts does for rules 1
// to 3. The relicensing commit is not in a throwaway repo, so the sandbox's copy of the audit config
// names one of the sandbox's own commits as its licenseBoundary, and its base is the sandbox's first
// commit: rule 4 reads the boundary from there exactly as it reads the real one here. Visibility is
// stubbed through the environment, so nothing reaches the network or this repo's own remote.
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
import {
  baseCommit,
  LICENSE_BOUNDARY,
  licenseBoundaries,
  licenseRefusals,
  MIT_BASE,
  parseRefLines,
  runPushAudit,
  upstreamTagRefusals,
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
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

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

// --- rule 6's pieces, without a push -------------------------------------------------------------

describe("rule 6: upstream's tags", () => {
  test('the hook and the audit config name the same base commit', () => {
    expect(MIT_BASE).toMatch(/^[0-9a-f]{40}$/)
    expect(loadAuditFiles().config.base).toBe(MIT_BASE)
    expect(baseCommit(REPO_ROOT)).toBe(MIT_BASE)
    // A checkout without the config still knows the base.
    expect(baseCommit(scratch('no-config'))).toBe(MIT_BASE)
  })

  test(
    'a tag on the base or before it is refused; a later tag, a branch and a deletion are not',
    () => {
      const dir = scratch('upstream-tags')
      git(dir, 'init', '-q', '-b', 'main')
      const before = commit(dir, { 'a.txt': 'a\n' }, 'upstream, before the base')
      const base = commit(dir, { 'b.txt': 'b\n' }, 'the base')
      const own = commit(dir, { 'c.txt': 'c\n' }, 'own work')
      git(dir, 'tag', '-a', '-m', 'annotated', 'old-release', before)
      const tagObject = git(dir, 'rev-parse', 'old-release')

      const refs = parseRefLines(
        [
          `refs/tags/old-release ${tagObject} refs/tags/old-release ${ZERO}`,
          `refs/tags/at-base ${base} refs/tags/at-base ${ZERO}`,
          `refs/tags/own ${own} refs/tags/own ${ZERO}`,
          `refs/heads/main ${own} refs/heads/main ${ZERO}`,
          `refs/heads/old ${before} refs/heads/old ${ZERO}`,
          `(delete) ${ZERO} refs/tags/gone ${before}`,
        ].join('\n'),
      )
      const refused = upstreamTagRefusals(refs, base, dir)
      expect(refused.map((r) => r.ref)).toEqual(['refs/tags/old-release', 'refs/tags/at-base'])
      expect(refused[0]?.why).toContain(before.slice(0, 8))
      expect(refused[0]?.why).toContain(base.slice(0, 8))

      // A base this clone does not have cannot be in any tag's history.
      expect(upstreamTagRefusals(refs, 'cd'.repeat(20), dir)).toEqual([])
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

describe('.githooks/pre-push: rules 4 and 5, end to end', () => {
  const PRIVATE = { AGENTHYDRA_VISIBILITY_STUB: 'private' }
  let repo: string
  let origin: string
  let boundary: string
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

    // Byte-identical copies of the real files, read fresh every run, committed as the base.
    const files: Record<string, string> = {}
    for (const path of COPIED) files[path] = readFileSync(join(REPO_ROOT, path), 'utf8')
    const base = commit(repo, files, 'the hook and the audit, as this repository has them')
    chmodSync(join(repo, '.githooks', 'pre-push'), 0o755) // git on POSIX refuses a non-executable hook
    git(repo, 'push', '-q', '--no-verify', 'origin', 'main')

    git(repo, 'checkout', '-q', '-b', 'upstream')
    boundary = commit(repo, { LICENSE: 'relicensed\n' }, 'the relicensing commit, in miniature')
    git(repo, 'checkout', '-q', 'main')

    // The config, the allowlist and the provenance list are read from the working tree, as in this
    // repository; they stay out of the sandbox's commits so its base can name the commit before them.
    const real = JSON.parse(
      readFileSync(join(REPO_ROOT, 'scripts', 'audit-public.config.json'), 'utf8'),
    )
    const scripts = join(repo, 'scripts')
    writeFileSync(
      join(scripts, 'audit-public.config.json'),
      JSON.stringify({ ...real, base, licenseBoundary: boundary }, null, 2),
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
    "a tag on the base's own history is refused, even to a private remote; a tag on a later commit lands",
    () => {
      const base = git(repo, 'rev-parse', 'main')
      git(repo, 'tag', 'v2.0.4', base)
      const refused = push(repo, PRIVATE, 'refs/tags/v2.0.4')
      expect(refused.status).not.toBe(0)
      expect(refused.output).toContain("a pushed tag is one of upstream's")
      expect(refused.output).toContain(`refs/tags/v2.0.4: it points at ${base.slice(0, 8)}`)
      expect(originHas(origin, 'refs/tags/v2.0.4')).toBe(false)

      const own = commit(repo, { 'notes.md': 'own work\n' }, 'own work')
      git(repo, 'tag', 'checkpoint', own)
      const landed = push(repo, PRIVATE, 'main', 'refs/tags/checkpoint')
      expect(landed.status).toBe(0)
      expect(originHas(origin, 'refs/tags/checkpoint')).toBe(true)
    },
    HOOK_TEST_TIMEOUT * 2,
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
})
