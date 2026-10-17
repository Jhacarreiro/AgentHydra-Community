// tests/audit-public.test.ts - scripts/audit-public.mjs, the public-safety gate. Each rule fires on a
// synthetic example of what it exists to stop and stays quiet on the look-alike that is fine; the
// tree, history and push modes read what they say they read; an allow entry clears exactly one value
// in one file; and nothing the audit finds is ever printed.
//
// EVERY FIXTURE IS SYNTHETIC, AND EVERY ONE THAT MUST FIRE IS BUILT AT RUN TIME. The tree audit reads
// this file too, so a literal private address, token, mailbox, home path or upstream name written
// here would be a finding against it. The look-alikes that must stay quiet use names that are fine
// anyway: RFC 5737 documentation addresses, example.invalid, C:\Users\me. Token-shaped values are
// random characters behind a prefix split in two, so no test run shares a value with another.
//
// The git-backed tests build throwaway repositories under one scratch folder and never touch this
// repository's own index or history; the last two read this repository's tree and history as they are.

import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type AuditContext,
  applyAllow,
  auditHistory,
  auditTree,
  compileRules,
  fingerprint,
  LICENSE_BOUNDARY,
  licenseBoundaries,
  licenseFindings,
  loadAuditFiles,
  MESSAGE_PATH,
  pushRevArgs,
  type Rule,
  scanPath,
  scanText,
} from '../scripts/audit-public.mjs'
import { PATTERNS } from '../server/src/secrets'
import { REPO_ROOT } from './repo-root'

// Real git in throwaway repos, and in the last tests a run over this whole repository (about 4 s
// here). A loaded Windows CI box has run git-backed tests ~9x slower than a desk.
const GIT_TEST_TIMEOUT = 60_000
const SCRIPT = join(REPO_ROOT, 'scripts', 'audit-public.mjs')

const ROOT = mkdtempSync(join(tmpdir(), 'ah-audit-'))
const FILE_ROOT = realpathSync.native(ROOT)
let seq = 0
function scratch(name: string): string {
  const dir = join(FILE_ROOT, `${name}-${seq++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

// --- synthetic values, assembled here so this file never holds one -----------------------------

const j = (...parts: string[]) => parts.join('')
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
function rand(n: number, alphabet = ALNUM): string {
  const bytes = randomBytes(n)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const HEX = '0123456789abcdef'

const TOKENS: Array<[kind: string, value: string]> = [
  ['github-token', j('gh', 'p_', rand(36))],
  ['github-token', j('github', '_pat_', rand(30))],
  ['api-token', j('s', 'k-', rand(40))],
  ['aws-access-key-id', j('AK', 'IA', rand(16, UPPER))],
  ['gitlab-token', j('glp', 'at-', rand(24))],
  ['slack-token', j('xo', 'xb-', rand(24))],
  ['google-api-key', j('AI', 'za', rand(35))],
  ['npm-token', j('np', 'm_', rand(36))],
  ['stripe-key', j('sk', '_live_', rand(24))],
  ['huggingface-token', j('h', 'f_', rand(34))],
  ['jwt', [j('ey', 'J', rand(20)), j('ey', 'J', rand(24)), rand(30)].join('.')],
]
const PEM_HEAD = j('-----BEGIN ', 'PRIVATE KEY-----')
const PEM_FOOT = j('-----END ', 'PRIVATE KEY-----')
const pemBlock = () =>
  [PEM_HEAD, randomBytes(48).toString('base64'), randomBytes(12).toString('base64'), PEM_FOOT].join(
    '\n',
  )

const IP = {
  ten: [10, 20, 30, 40].join('.'),
  b172: [172, 20, 1, 9].join('.'),
  b192: [192, 168, 7, 9].join('.'),
  linkLocal: [169, 254, 3, 4].join('.'),
  cgnat: [100, 100, 1, 2].join('.'),
}
const MAILBOX = j('pat.person', '@', 'mail-fixture', '.zz')
const NAME = j('qa', 'person') // a home-folder account name that is no placeholder
const TAILNET = j('box.tail0fix', '.ts', '.net')
const LAN_HOST = j('qa-box', '.', 'lan')
const WIN_MACHINE = j('DESK', 'TOP-', 'Q7W3K9Z')

const AUDIT = loadAuditFiles()
const CONFIG = AUDIT.config
const RULES_PLAIN = compileRules(CONFIG)

function rulesOf(found: Array<{ rule: string }>): string[] {
  return found.map((f) => f.rule)
}

// --- the rules, one by one ----------------------------------------------------------------------

describe('secret.token', () => {
  test("reuses server/src/secrets.ts's PATTERNS, every one of them", () => {
    const sources = new Set(RULES_PLAIN.map((r: Rule) => r.re.source))
    for (const p of PATTERNS) expect(sources.has(p.source.source)).toBe(true)
  })

  test.each(TOKENS)('%s is found, named by its kind and fingerprint only', (kind, value) => {
    const found = scanText(`const k = "${value}"\n`, 'src/config.ts', RULES_PLAIN)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ rule: 'secret.token', line: 1, note: kind })
    expect(found[0]?.fp).toBe(fingerprint(value))
    expect(JSON.stringify(found)).not.toContain(value)
  })

  test('a PEM block is fingerprinted whole, so one allowed key never allows another', () => {
    const a = pemBlock()
    const b = pemBlock()
    const [fa] = scanText(`key: \`${a}\`\n`, 'tests/x.test.ts', RULES_PLAIN)
    const [fb] = scanText(`key: \`${b}\`\n`, 'tests/x.test.ts', RULES_PLAIN)
    expect(fa?.note).toBe('private-key')
    expect(fb?.note).toBe('private-key')
    expect(fa?.fp).not.toBe(fb?.fp)
    // A header with no body is a string naming the format: its own kind, still a finding.
    const [header] = scanText(`expect(text).toStartWith('${PEM_HEAD}')\n`, 'a.ts', RULES_PLAIN)
    expect(header).toMatchObject({ rule: 'secret.token', note: 'private-key-header' })
    expect(header?.fp).toBe(fingerprint(PEM_HEAD))
  })

  test('look-alikes stay quiet: a short prefix, a word with a dash, a redacted shape', () => {
    const text = [
      'sk-short',
      'the task-runner-for-everything-at-once list',
      'ghp_ alone',
      'redacted: sk-…[redacted 51 chars]',
    ].join('\n')
    expect(scanText(text, 'docs/a.md', RULES_PLAIN)).toEqual([])
  })
})

describe('secret.file', () => {
  test.each([
    'home/.credentials.json',
    'codex/auth.json',
    'profiles/session.dpapi',
    '.netrc',
    'keys/id_ed25519',
    'certs/server.pem',
    'certs/server.key',
    'store.p12',
    '.env',
    '.env.local',
    'chrome/Cookies',
    'pw/storage-state.json',
    'data/agenthydra.db',
  ])('%s is a finding by its name alone', (path) => {
    expect(rulesOf(scanPath(path))).toEqual(['secret.file'])
  })

  test.each([
    '.env.example',
    'server/src/auth.ts',
    'keys/id_ed25519.pub',
    'tests/fixtures/sample.db',
    'docs/keys.md',
  ])('%s is fine', (path) => {
    expect(scanPath(path)).toEqual([])
  })

  test('an .npmrc with a saved token, not one that reads it from the environment', () => {
    const saved = j('//registry.npmjs.org/:_auth', 'Token=', rand(30))
    expect(rulesOf(scanText(`${saved}\n`, '.npmrc', RULES_PLAIN))).toEqual(['secret.file'])
    const fromEnv = j('//registry.npmjs.org/:_auth', 'Token=$', '{NPM_TOKEN}')
    expect(scanText(`${fromEnv}\n`, '.npmrc', RULES_PLAIN)).toEqual([])
  })
})

describe('net.private-ipv4 and net.tailscale', () => {
  test('each private range, the link-local range and Tailscale CGNAT addresses fire', () => {
    const text = [IP.ten, IP.b172, IP.b192, IP.linkLocal, IP.cgnat]
      .map((a) => `host ${a}`)
      .join('\n')
    expect(rulesOf(scanText(text, 'a.md', RULES_PLAIN))).toEqual([
      'net.private-ipv4',
      'net.private-ipv4',
      'net.private-ipv4',
      'net.private-ipv4',
      'net.tailscale',
    ])
    const [ts] = scanText(`ssh ${TAILNET}\n`, 'a.md', RULES_PLAIN)
    expect(ts?.rule).toBe('net.tailscale')
  })

  test('documentation, loopback and public addresses, and version strings stay quiet', () => {
    const text = [
      'http://192.0.2.10:7787',
      '198.51.100.7 and 203.0.113.9',
      '127.0.0.1 0.0.0.0 8.8.8.8',
      'v10.1.2.3 and 1.10.0.5.2 and 999.168.1.1',
      'node.example.ts.net',
    ].join('\n')
    expect(scanText(text, 'a.md', RULES_PLAIN)).toEqual([])
  })
})

describe('pii.email', () => {
  test('a mailbox fires, in prose and behind mailto:', () => {
    const found = scanText(
      `write to ${MAILBOX} or <a href="mailto:${MAILBOX}">`,
      'a.md',
      RULES_PLAIN,
    )
    expect(rulesOf(found)).toEqual(['pii.email', 'pii.email'])
    expect(found[0]?.fp).toBe(fingerprint(MAILBOX.toLowerCase()))
  })

  test('noreply, documentation domains and the shapes that are not mailboxes stay quiet', () => {
    const text = [
      '12345678+someone@users.noreply.github.com',
      'noreply@vendor.example and no-reply@service.example',
      'ann@example.com, Owner@Sub.Example.ORG, t@example.invalid, x@dev.test',
      'git@github.com:owner/repo.git',
      'icon@2x.png, bun-types@1.4.2.patch, worker@autostart.service',
      'https://user@host.zz/repo.git and https://user:pass@host.zz/',
      'ssh:ci@build-host.zz',
    ].join('\n')
    expect(scanText(text, 'a.md', RULES_PLAIN)).toEqual([])
  })
})

describe('pii.path', () => {
  test('a home folder with a real account name fires, one fingerprint for every spelling', () => {
    const spellings = [
      j('C:\\Users\\', NAME, '\\proj'),
      j('C:\\\\Users\\\\', NAME, '\\\\proj'),
      j('c:/users/', NAME, '/proj'),
    ]
    const found = scanText(spellings.join('\n'), 'a.md', RULES_PLAIN)
    expect(rulesOf(found)).toEqual(['pii.path', 'pii.path', 'pii.path'])
    expect(new Set(found.map((f) => f.fp)).size).toBe(1)
    const posix = scanText(j('/Users/', NAME, '/x\n/home/', NAME, '/x\n'), 'a.md', RULES_PLAIN)
    expect(rulesOf(posix)).toEqual(['pii.path', 'pii.path'])
  })

  test('placeholders, variables and URL paths stay quiet', () => {
    const text = [
      'C:\\Users\\me\\Desktop and C:/Users/Me/x and C:\\Users\\RUNNER~1\\AppData',
      '/Users/me/x /home/runner/work /home/linuxbrew/.linuxbrew',
      'C:\\Users\\%USERNAME%\\x and /home/$USER/x and C:\\Users\\<you>\\x',
      'https://site.example/home/page and /api/users/42',
    ].join('\n')
    expect(scanText(text, 'a.md', RULES_PLAIN)).toEqual([])
  })

  test('a folder on the path denylist fires in any spelling, except in the config that lists it', () => {
    const entry = CONFIG.pathDenylist?.[0] ?? ''
    expect(entry).not.toBe('')
    const [drive, folder] = entry.split('\\')
    const text = [
      `${drive}\\${folder}\\app`,
      `${drive}/${folder}/app`,
      `${drive}\\\\${folder}`,
    ].join('\n')
    const found = scanText(text, 'a.md', RULES_PLAIN)
    expect(rulesOf(found)).toEqual(['pii.path', 'pii.path', 'pii.path'])
    expect(new Set(found.map((f) => f.fp)).size).toBe(1)
    expect(scanText(text, 'scripts/audit-public.config.json', RULES_PLAIN)).toEqual([])
  })
})

describe('pii.local-name', () => {
  const fullName = j('Zo', 'ë Qwer', 'tz')
  const account = j('qz', 'acct')
  const rules = compileRules(CONFIG, { localNames: [fullName, account, 'root', 'unknown'] })

  test("the runner's full name fires however it is joined, accents or not", () => {
    const plain = fullName.normalize('NFD').replace(/\p{M}/gu, '')
    const text = [fullName, plain.toLowerCase(), plain.replace(' ', '.'), plain.replace(' ', '')]
      .map((n) => `by ${n} here`)
      .join('\n')
    const found = scanText(text, 'a.md', rules).filter((f) => f.rule === 'pii.local-name')
    expect(found).toHaveLength(4)
    expect(new Set(found.map((f) => f.fp)).size).toBe(1)
  })

  test('a one-word account name fires only as a path segment', () => {
    const found = scanText(j('/srv/', account, '/data\nD:\\', account, '\\x\n'), 'a.md', rules)
    expect(rulesOf(found)).toEqual(['pii.local-name', 'pii.local-name'])
    expect(scanText(`the ${account} setting\n`, 'a.md', rules)).toEqual([])
  })

  test('account names that are machines and tools are not names', () => {
    expect(
      compileRules(CONFIG, { localNames: ['root', 'runner', 'unknown', 'me', 'x'] }),
    ).toHaveLength(RULES_PLAIN.length)
  })
})

describe('infra rules', () => {
  const upstream = CONFIG.upstreamHosts?.[0] ?? ''
  const privateRepo = CONFIG.privateRepos?.[0] ?? ''

  test("upstream's hosts fire, with every name under them, outside the historical files", () => {
    expect(upstream).not.toBe('')
    const text = `see https://api.${upstream}/v1 and ${upstream}\n`
    const found = scanText(text, 'server/src/x.ts', RULES_PLAIN)
    expect(rulesOf(found)).toEqual(['infra.host', 'infra.host'])
    expect(found[0]?.note).toBe(upstream)
    expect(scanText(text, 'CHANGELOG.md', RULES_PLAIN)).toEqual([])
    expect(scanText(text, 'scripts/audit-public.config.json', RULES_PLAIN)).toEqual([])
  })

  test("upstream's private repository names fire", () => {
    expect(privateRepo).not.toBe('')
    const found = scanText(`node ../../${privateRepo}/sync.mjs\n`, 'package.json', RULES_PLAIN)
    expect(rulesOf(found)).toEqual(['infra.private-repo'])
  })

  test('a home or office network name fires in prose and in a string, not as a property', () => {
    expect(rulesOf(scanText(`ssh ${LAN_HOST}\n`, 'docs/a.md', RULES_PLAIN))).toEqual([
      'infra.internal-host',
    ])
    expect(rulesOf(scanText(`const h = '${LAN_HOST}'\n`, 'a.ts', RULES_PLAIN))).toEqual([
      'infra.internal-host',
    ])
    expect(rulesOf(scanText(`// on ${LAN_HOST}\n`, 'a.ts', RULES_PLAIN))).toEqual([
      'infra.internal-host',
    ])
    // Assembled, because this file is code too: written whole, each would sit in a string here.
    const code = [
      j('if (props.', 'local?.servers) return input.', 'local === true'),
      j('const settings = "settings.', 'local.json"'),
    ].join('\n')
    expect(scanText(code, 'a.ts', RULES_PLAIN)).toEqual([])
    const bound = j('<component :is="icons.', 'local" />\n')
    expect(scanText(bound, 'a.vue', RULES_PLAIN)).toEqual([])
  })

  test('names that are the same everywhere, and placeholders, stay quiet', () => {
    const text = 'host.docker.internal, api.svc.cluster.local, Example-Mac.local, test-pc.lan\n'
    expect(scanText(text, 'a.md', RULES_PLAIN)).toEqual([])
    expect(
      scanText('DESKTOP-EXAMPLE and DESKTOP-NATIVE-CONTROL.md\n', 'a.md', RULES_PLAIN),
    ).toEqual([])
  })

  test("a Windows machine's generated name fires", () => {
    expect(rulesOf(scanText(`on ${WIN_MACHINE}\n`, 'a.md', RULES_PLAIN))).toEqual([
      'infra.internal-host',
    ])
  })

  test('a 32-hex id next to account or zone wording fires; a placeholder or a lone hash does not', () => {
    const id = rand(32, HEX)
    expect(rulesOf(scanText(`ACCOUNT_ID = "${id}"\n`, 'a.py', RULES_PLAIN))).toEqual([
      'infra.account-id',
    ])
    const quiet = [
      `account = "${'0123456789abcdef'.repeat(2)}"`,
      `etag ${id}`,
      `account sha256 ${rand(64, HEX)}`,
    ].join('\n')
    expect(scanText(quiet, 'a.py', RULES_PLAIN)).toEqual([])
  })
})

describe('the allowlist and the config files', () => {
  test('an entry clears one value in one file for one rule, and nothing else', () => {
    const value = j('gh', 'p_', rand(36))
    const other = j('gh', 'p_', rand(36))
    const text = `a = "${value}"\nb = "${other}"\n`
    const here = scanText(text, 'tests/a.test.ts', RULES_PLAIN)
    const there = scanText(text, 'src/a.ts', RULES_PLAIN)
    const entry = {
      rule: 'secret.token',
      path: 'tests/a.test.ts',
      fp: fingerprint(value),
      reason: 'a synthetic test token',
    }
    const unused = applyAllow([...here, ...there], [entry])
    expect(unused).toEqual([])
    expect(here.map((f) => Boolean(f.allowed))).toEqual([true, false])
    expect(there.map((f) => Boolean(f.allowed))).toEqual([false, false])
    expect(applyAllow([], [entry])).toEqual([entry])
  })

  test('commit.email and license.boundary findings cannot be allowed', () => {
    const f = { rule: 'commit.email', path: '(commit)', line: 0, fp: fingerprint('a') }
    applyAllow([f], [{ rule: 'commit.email', path: '(commit)', fp: f.fp, reason: 'xxxxxxxxxxx' }])
    expect(f).not.toHaveProperty('allowed')
  })

  test('a malformed allow entry stops the audit rather than clearing anything', () => {
    const dir = scratch('allow')
    const write = (entries: unknown[]) => {
      writeFileSync(join(dir, 'allow.json'), JSON.stringify({ entries }))
      return () => loadAuditFiles({ allow: join(dir, 'allow.json') })
    }
    const ok = {
      rule: 'pii.email',
      path: 'a.md',
      fp: '0123456789abcdef',
      reason: 'a sentence here',
    }
    expect(write([ok])).not.toThrow()
    expect(write([{ ...ok, rule: 'no.such-rule' }])).toThrow('no known rule')
    expect(write([{ ...ok, fp: MAILBOX }])).toThrow('16-hex fp')
    expect(write([{ ...ok, reason: '' }])).toThrow('no reason')
    expect(write([{ ...ok, rule: 'commit.email' }])).toThrow('cannot be allowed')
  })

  test("this repository's own files: the base, the boundary, and entries that hold no values", () => {
    expect(CONFIG.base).toBe('3a65ba8e6497c16732f627fc8934723839c82fdd')
    expect(CONFIG.licenseBoundary).toBe('aee9dfc4f7dd0228d8e1740be90b646b30204f37')
    for (const e of AUDIT.allow) {
      expect(Object.keys(e).sort()).toEqual(['fp', 'path', 'reason', 'rule'])
    }
    for (const b of AUDIT.provenance) {
      expect(b.blob).toMatch(/^[0-9a-f]{40}$/)
      expect(b.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

// --- the modes, on throwaway repositories --------------------------------------------------------

const NOREPLY = 'fixture@users.noreply.github.com'

function git(cwd: string, email: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      `user.email=${email}`,
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
    { cwd, encoding: 'utf8', timeout: GIT_TEST_TIMEOUT },
  ).trim()
}

function repo(name: string): string {
  const dir = scratch(name)
  git(dir, NOREPLY, 'init', '-q', '-b', 'main')
  return dir
}

function commit(
  dir: string,
  files: Record<string, string | Buffer>,
  message: string,
  email = NOREPLY,
) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  git(dir, email, 'add', '-A')
  git(dir, email, 'commit', '-q', '--allow-empty', '-m', message)
  return git(dir, email, 'rev-parse', 'HEAD')
}

function ctxWith(overrides: Partial<AuditContext> = {}): AuditContext {
  return { config: CONFIG, provenance: [], rules: RULES_PLAIN, ...overrides }
}

describe('--tree', () => {
  test(
    "every text file's content, every path, and every binary against its provenance",
    () => {
      const dir = repo('tree')
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
        randomBytes(64),
      ])
      commit(dir, { 'README.md': `mail ${MAILBOX}\n`, '.env': 'A=1\n', 'logo.png': png }, 'init')
      const first = auditTree(dir, 'HEAD', ctxWith())
      expect(first.stats).toEqual({ files: 3, binaries: 1 })
      expect(rulesOf(first.findings).sort()).toEqual([
        'binary.provenance',
        'pii.email',
        'secret.file',
      ])
      expect(first.findings.find((f) => f.rule === 'pii.email')).toMatchObject({
        path: 'README.md',
        line: 1,
      })

      const blob = git(dir, NOREPLY, 'rev-parse', 'HEAD:logo.png')
      const sha256 = createHash('sha256').update(png).digest('hex')
      const entry = { path: 'logo.png', blob, sha256, source: 's', build: 'b', license: 'l' }
      const recorded = auditTree(dir, 'HEAD', ctxWith({ provenance: [entry] }))
      expect(rulesOf(recorded.findings)).not.toContain('binary.provenance')

      commit(dir, { 'logo.png': Buffer.concat([png, Buffer.from([1])]) }, 'new logo')
      const changed = auditTree(dir, 'HEAD', ctxWith({ provenance: [entry] }))
      expect(changed.findings.find((f) => f.rule === 'binary.provenance')?.note).toBe(
        'changed since its provenance entry',
      )

      const stale = { ...entry, path: 'gone.png' }
      const staleRun = auditTree(dir, 'HEAD', ctxWith({ provenance: [stale] }))
      expect(staleRun.findings.map((f) => f.note)).toContain(
        'provenance entry for a binary that is not tracked',
      )
    },
    GIT_TEST_TIMEOUT,
  )
})

describe('--history', () => {
  test(
    'a token added in one commit and removed in the next is still found, at its own line',
    () => {
      const dir = repo('history')
      const base = commit(dir, { 'a.ts': 'one\n' }, 'base')
      const token = j('gh', 'p_', rand(36))
      const added = commit(dir, { 'a.ts': `one\ntwo\nconst t = "${token}"\n` }, 'add')
      commit(dir, { 'a.ts': 'one\ntwo\n' }, 'remove')

      const tree = auditTree(dir, 'HEAD', ctxWith())
      expect(tree.findings).toEqual([])
      const history = auditHistory(dir, [`${base}..HEAD`], ctxWith())
      expect(history.commits).toHaveLength(2)
      expect(history.findings).toHaveLength(1)
      expect(history.findings[0]).toMatchObject({
        rule: 'secret.token',
        path: 'a.ts',
        line: 3,
        commit: added,
        fp: fingerprint(token),
      })
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    'author, committer and trailer emails must be noreply; a message is read like a file',
    () => {
      const dir = repo('emails')
      const base = commit(dir, {}, 'base')
      commit(dir, {}, 'not noreply', 't@example.invalid')
      commit(dir, {}, `fine\n\nCo-authored-by: Someone <someone@example.invalid>`)
      commit(dir, {}, `points at ${IP.b192} in its message`)
      const { findings } = auditHistory(dir, [`${base}..HEAD`], ctxWith())
      const notes = findings.filter((f) => f.rule === 'commit.email').map((f) => f.note)
      expect(notes.sort()).toEqual(['author', 'committer', 'trailer Co-authored-by'])
      expect(findings.find((f) => f.rule === 'net.private-ipv4')).toMatchObject({
        path: MESSAGE_PATH,
        line: 1,
      })
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    'a message may name the upstream hosts, private repositories and folders a commit takes out; a file may not',
    () => {
      const host = CONFIG.upstreamHosts?.[0] ?? ''
      const privateRepo = CONFIG.privateRepos?.[0] ?? ''
      const folder = CONFIG.pathDenylist?.[0] ?? ''
      expect([host, privateRepo, folder]).not.toContain('')
      const names = `api.${host}, ${privateRepo} and ${folder}\n`
      const dir = repo('messages')
      const base = commit(dir, {}, 'base')
      const described = commit(dir, {}, `Services: nothing reads ${names}\nany more.`)
      expect(auditHistory(dir, [`${base}..HEAD`], ctxWith()).findings).toEqual([])

      // The same names in a file the commit adds are findings, and in a message every other rule
      // still reads: a home folder, a private address and a mailbox.
      const home = j('C:\\Users\\', NAME, '\\x')
      commit(dir, { 'notes.md': names }, `Notes: moved from ${home} to ${IP.b172}, ask ${MAILBOX}`)
      const { findings } = auditHistory(dir, [`${described}..HEAD`], ctxWith())
      const where = (path: string) =>
        findings
          .filter((f) => f.path === path)
          .map((f) => f.rule)
          .sort()
      expect(where('notes.md')).toEqual(['infra.host', 'infra.private-repo', 'pii.path'])
      expect(where(MESSAGE_PATH)).toEqual(['net.private-ipv4', 'pii.email', 'pii.path'])
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    'a binary a commit adds needs provenance, even when a later commit removes it',
    () => {
      const dir = repo('binaries')
      const base = commit(dir, {}, 'base')
      const bytes = Buffer.concat([Buffer.from([0, 1, 2, 0]), randomBytes(32)])
      commit(dir, { 'tool.exe': bytes }, 'add a binary')
      git(dir, NOREPLY, 'rm', '-q', 'tool.exe')
      git(dir, NOREPLY, 'commit', '-q', '-m', 'remove it')
      const { findings } = auditHistory(dir, [`${base}..HEAD`], ctxWith())
      expect(findings).toHaveLength(1)
      expect(findings[0]).toMatchObject({ rule: 'binary.provenance', path: 'tool.exe' })
      expect(findings[0]?.fp).toBe(createHash('sha256').update(bytes).digest('hex').slice(0, 16))
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    'a path with a space is the same file in tree and history, so one allow entry clears it in both',
    () => {
      const dir = repo('spaces')
      const base = commit(dir, {}, 'base')
      // git ends a patch header for such a path with a TAB; that TAB must not become part of it.
      const paths = ['docs/my notes.md', 'docs/café menu.md']
      commit(dir, Object.fromEntries(paths.map((p) => [p, `host ${IP.ten}\n`])), 'notes')
      const entries = paths.map((path) => ({
        rule: 'net.private-ipv4',
        path,
        fp: fingerprint(IP.ten),
        reason: 'a synthetic address',
      }))
      const tree = auditTree(dir, 'HEAD', ctxWith()).findings
      const history = auditHistory(dir, [`${base}..HEAD`], ctxWith()).findings
      for (const findings of [tree, history]) {
        expect(findings.map((f) => f.path).sort()).toEqual([...paths].sort())
        expect(applyAllow(findings, entries)).toEqual([])
        expect(findings.every((f) => Boolean(f.allowed))).toBe(true)
      }
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    'history that contains the license boundary is a finding',
    () => {
      const dir = repo('boundary')
      const base = commit(dir, {}, 'base')
      const boundary = commit(dir, {}, 'relicense')
      commit(dir, {}, 'after')
      const config = { ...CONFIG, licenseBoundary: boundary }
      const tree = auditTree(dir, 'HEAD', ctxWith({ config }))
      expect(rulesOf(tree.findings)).toEqual(['license.boundary'])
      const before = auditTree(dir, base, ctxWith({ config }))
      expect(before.findings).toEqual([])
    },
    GIT_TEST_TIMEOUT,
  )

  test('the relicensing commit is built in: the config can add a boundary, never take it away', () => {
    const without = { ...CONFIG, licenseBoundary: undefined }
    expect(licenseBoundaries(without)).toEqual([LICENSE_BOUNDARY])
    expect(licenseBoundaries({ licenseBoundary: LICENSE_BOUNDARY.toUpperCase() })).toEqual([
      LICENSE_BOUNDARY,
    ])
    const other = 'ab'.repeat(20)
    expect(licenseBoundaries({ licenseBoundary: other })).toEqual([LICENSE_BOUNDARY, other])

    // A config with no licenseBoundary still loads and still checks the built-in commit; one whose
    // licenseBoundary is no full commit id stops the audit.
    const file = join(scratch('boundary-config'), 'config.json')
    writeFileSync(file, JSON.stringify(without))
    expect(licenseBoundaries(loadAuditFiles({ config: file }).config)).toEqual([LICENSE_BOUNDARY])
    writeFileSync(
      file,
      JSON.stringify({ ...CONFIG, licenseBoundary: LICENSE_BOUNDARY.slice(0, 8) }),
    )
    expect(() => loadAuditFiles({ config: file })).toThrow('licenseBoundary')
  })

  test.skipIf(!hasCommit(LICENSE_BOUNDARY))(
    'with no licenseBoundary in the config, the relicensing commit is still a finding where it exists',
    () => {
      // Only ancestry is read here (git merge-base), never a file of upstream's later history.
      const commits = [LICENSE_BOUNDARY, CONFIG.base]
      const found = licenseFindings(REPO_ROOT, licenseBoundaries({}), commits)
      expect(found).toHaveLength(1)
      expect(found[0]).toMatchObject({ rule: 'license.boundary', commit: LICENSE_BOUNDARY })
    },
    GIT_TEST_TIMEOUT,
  )
})

describe('--push', () => {
  test(
    'only what the push carries is read: not the base, not what the remote already has',
    () => {
      const dir = repo('push')
      const origin = scratch('push-origin')
      git(origin, NOREPLY, 'init', '-q', '--bare')
      git(dir, NOREPLY, 'remote', 'add', 'origin', origin)
      const base = commit(dir, { 'old.md': `${MAILBOX}\n` }, 'inherited, before the base')
      const pushed = commit(dir, { 'pushed.md': `${IP.ten}\n` }, 'already on the remote')
      git(dir, NOREPLY, 'push', '-q', 'origin', 'main')
      const fresh = commit(dir, { 'new.md': 'clean\n' }, 'new')

      const line = (local: string, remote: string) =>
        `refs/heads/main ${local} refs/heads/main ${remote}\n`
      const zero = '0'.repeat(40)
      const tracked = pushRevArgs(dir, line(fresh, zero), 'origin', base)
      expect(tracked?.include).toEqual([fresh])
      const cleanRun = auditHistory(dir, tracked?.args ?? [], ctxWith())
      expect(cleanRun.commits.map((c) => c.sha)).toEqual([fresh])
      expect(cleanRun.findings).toEqual([])

      // A remote nothing tracks: everything after the base, and nothing before it.
      const untracked = pushRevArgs(dir, line(fresh, zero), 'elsewhere', base)
      const wide = auditHistory(dir, untracked?.args ?? [], ctxWith())
      expect(wide.commits.map((c) => c.sha).sort()).toEqual([fresh, pushed].sort())
      expect(rulesOf(wide.findings)).toEqual(['net.private-ipv4'])

      // The remote's own sha, as git hands it to the hook, excludes what it has.
      const byRemoteSha = pushRevArgs(dir, line(fresh, pushed), 'elsewhere', base)
      expect(auditHistory(dir, byRemoteSha?.args ?? [], ctxWith()).commits).toHaveLength(1)

      expect(
        pushRevArgs(dir, `(delete) ${zero} refs/heads/x ${pushed}\n`, 'origin', base),
      ).toBeNull()
    },
    GIT_TEST_TIMEOUT,
  )
})

describe('the command line', () => {
  test(
    'a finding exits 1 and prints its rule, place and fingerprint, never the value',
    () => {
      const dir = repo('cli')
      const token = j('gh', 'p_', rand(36))
      commit(
        dir,
        { 'src/a.ts': `export const t = "${token}"\nexport const m = "${MAILBOX}"\n` },
        'init',
      )
      const files = scratch('cli-files')
      const allow = join(files, 'allow.json')
      const provenance = join(files, 'provenance.json')
      writeFileSync(allow, JSON.stringify({ entries: [] }))
      writeFileSync(provenance, JSON.stringify({ binaries: [] }))
      const run = () =>
        spawnSync(
          process.execPath,
          [SCRIPT, '--tree', 'HEAD', '-C', dir, '--allow', allow, '--provenance', provenance],
          {
            encoding: 'utf8',
            timeout: GIT_TEST_TIMEOUT,
            env: { ...process.env, GITHUB_ACTIONS: '' },
          },
        )
      const r = run()
      const out = `${r.stdout}${r.stderr}`
      expect(r.status).toBe(1)
      expect(out).toContain('secret.token')
      expect(out).toContain('src/a.ts:1')
      expect(out).toContain(fingerprint(token))
      expect(out).toContain('pii.email')
      expect(out).not.toContain(token)
      expect(out).not.toContain(MAILBOX)

      const entries = [
        {
          rule: 'secret.token',
          path: 'src/a.ts',
          fp: fingerprint(token),
          reason: 'synthetic token',
        },
        {
          rule: 'pii.email',
          path: 'src/a.ts',
          fp: fingerprint(MAILBOX),
          reason: 'synthetic mailbox',
        },
      ]
      writeFileSync(allow, JSON.stringify({ entries }))
      const cleared = run()
      expect(cleared.status).toBe(0)
      expect(cleared.stderr).toContain('2 finding(s) allowed')

      writeFileSync(allow, '{ not json')
      expect(run().status).toBe(2)
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    'without the token formats of server/src/secrets.ts the audit could not run (exit 2), not "found"',
    () => {
      // A copy of the audit with its three files and no server/ beside it: the same failed import
      // as a node that cannot load TypeScript.
      const scripts = join(scratch('no-patterns'), 'scripts')
      mkdirSync(scripts)
      const own = [
        'audit-public.mjs',
        'audit-public.config.json',
        'audit-public.allow.json',
        'binary-provenance.json',
      ]
      for (const name of own) copyFileSync(join(REPO_ROOT, 'scripts', name), join(scripts, name))
      const r = spawnSync(process.execPath, [join(scripts, 'audit-public.mjs'), '--tree', 'HEAD'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: GIT_TEST_TIMEOUT,
      })
      expect(r.stderr).toContain('server/src/secrets.ts could not be loaded')
      expect(r.status).toBe(2)
    },
    GIT_TEST_TIMEOUT,
  )
})

// --- this repository, as it is -------------------------------------------------------------------

function hasCommit(sha: string): boolean {
  const r = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
    cwd: REPO_ROOT,
    timeout: GIT_TEST_TIMEOUT,
  })
  return r.status === 0
}

describe('this repository', () => {
  test(
    'the tree audit runs in seconds, and nothing it leaves open is a secret, an address or a mailbox',
    () => {
      const started = Date.now()
      const r = spawnSync(process.execPath, [SCRIPT, '--tree', 'HEAD', '--json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: GIT_TEST_TIMEOUT,
        maxBuffer: 64 * 1024 * 1024,
      })
      expect([0, 1]).toContain(r.status ?? 2)
      expect(Date.now() - started).toBeLessThan(45_000)
      const doc = JSON.parse(r.stdout) as {
        findings: Array<{ rule: string; path: string; allowed?: string }>
      }
      const open = doc.findings.filter((f) => !f.allowed)
      const never = [
        'secret.token',
        'secret.file',
        'net.private-ipv4',
        'net.tailscale',
        'pii.email',
      ]
      expect(open.filter((f) => never.includes(f.rule))).toEqual([])
      // The audit's own tests and files are clean under it.
      const own = ['tests/audit-public.test.ts', 'tests/githooks/check-public-push-audit.test.ts']
      expect(
        doc.findings.filter(
          (f) => own.includes(f.path) || f.path.startsWith('scripts/audit-public'),
        ),
      ).toEqual([])
    },
    GIT_TEST_TIMEOUT,
  )

  test.skipIf(!hasCommit(CONFIG.base))(
    'every commit since the MIT base passes the history audit',
    () => {
      const r = spawnSync(process.execPath, [SCRIPT, '--history', `${CONFIG.base}..HEAD`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: GIT_TEST_TIMEOUT,
      })
      expect(r.stderr).toContain('✓ clean')
      expect(r.status).toBe(0)
    },
    GIT_TEST_TIMEOUT,
  )
})
