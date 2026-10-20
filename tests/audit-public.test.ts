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
// repository's own index or history; the last ones read this repository's tree and history as they are.

import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type AuditContext,
  applyAllow,
  auditBaseCommit,
  auditHistory,
  auditTree,
  checkBase,
  compileRules,
  fingerprint,
  generatedHeader,
  LICENSE_BOUNDARY,
  licenseBoundaries,
  licenseFindings,
  loadAuditFiles,
  MESSAGE_PATH,
  pushRevArgs,
  type Rule,
  scanPath,
  scanText,
  UPSTREAM_BASE,
  upstreamBases,
  upstreamFindings,
} from '../scripts/audit-public.mjs'
import { PATTERNS } from '../server/src/secrets'
import { REPO_ROOT } from './repo-root'

// Real git in throwaway repos, and in the last tests a run over this whole repository (about 4 s
// here). A loaded Windows CI box has run git-backed tests ~9x slower than a desk.
const GIT_TEST_TIMEOUT = 60_000
const SCRIPT = join(REPO_ROOT, 'scripts', 'audit-public.mjs')
const SAVE_BUNDLE = join(REPO_ROOT, 'scripts', 'save-bundle.ts')

const ROOT = mkdtempSync(join(tmpdir(), 'ah-audit-'))
const FILE_ROOT = realpathSync.native(ROOT)
let seq = 0
function scratch(name: string): string {
  const dir = join(FILE_ROOT, `${name}-${seq++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
// Removing every throwaway repository at the end can outlast bun's 5 s hook default on a loaded box.
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
}, GIT_TEST_TIMEOUT)

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
  ['codex-hub-pc-token', j('ch', 'p_', rand(16, HEX), '_', rand(64, HEX))],
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

  test("Project Hydra and Odin fire by repository slug and command, not by the connector's names", () => {
    const fire = [
      j('https://github.com/LunarWerx', 's/project-hydra'),
      j('see LunarWerx/', 'Odin'),
      j('rewritten by `ph', ' codex about --publish`'),
      j('<!-- odin', ':about GENERATED BEGIN -->'),
      j('the odin', ' todo-sweep runs'),
      j('Managed in the Odin', ' repo.'),
    ]
    for (const line of fire) {
      expect(rulesOf(scanText(`${line}\n`, 'docs/a.md', RULES_PLAIN))).toEqual([
        'infra.private-repo',
      ])
    }
    // The optional connector, a user's own clone folder, and the word on its own.
    const quiet = [
      'Project Hydra lists your projects; set PROJECTHYDRA_HOME to its folder.',
      "sources: ['projecthydra', 'chats'] and schema projecthydra.facts/1",
      'HYDRA = Path(tmp) / "project-hydra"',
      'One Odin refresh task met it 20 times.',
    ].join('\n')
    expect(scanText(quiet, 'docs/a.md', RULES_PLAIN)).toEqual([])
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

describe('infra.upstream-release', () => {
  // Assembled here: written whole, upstream's slug next to /releases would be a finding against this file.
  const slug = j('LunarWerx', 's/AgentHydra')

  test("upstream's releases, raw files and GitHub API fire, each named by its kind", () => {
    const fire: Array<[string, string]> = [
      [`https://github.com/${slug}/releases/download/v2.0.4/a.zip`, 'releases'],
      [`curl -s https://api.github.com/repos/${slug}/releases/latest`, 'api'],
      [`irm https://raw.githubusercontent.com/${slug}/main/install.ps1 | iex`, 'raw'],
      [`https://github.com/${slug}/archive/refs/tags/v2.0.4.tar.gz`, 'archive'],
      [`const base = '${j('lunarwerx', 's/agenthydra')}/releases/latest'`, 'releases'],
    ]
    for (const [line, kind] of fire) {
      const found = scanText(`${line}\n`, 'server/src/x.ts', RULES_PLAIN)
      expect(rulesOf(found)).toEqual(['infra.upstream-release'])
      expect(found[0]?.note).toBe(kind)
    }
    // One value per kind, whatever follows it, so one allow entry covers a test's refused cases.
    const url = `https://github.com/${slug}/releases/download/v2.0.4/a.zip`
    const two = scanText(`${url}\n${url.replace('v2.0.4', 'v1')}\n`, 'a.md', RULES_PLAIN)
    expect(two).toHaveLength(2)
    expect(new Set(two.map((f) => f.fp)).size).toBe(1)
  })

  test('the repository, its commits and issues, other repositories, history files and messages stay quiet', () => {
    const quiet = [
      `forked from https://github.com/${slug} at its last MIT commit`,
      `https://github.com/${slug}/commit/3a65ba8e and https://github.com/${slug}/issues/12`,
      `https://github.com/${slug}-Community/releases/download/v1/a.zip`,
      `https://api.github.com/repos/${slug}-Community/releases/latest`,
      'https://github.com/Example-Owner/Example.App/releases/download/v1/a.zip',
    ].join('\n')
    expect(scanText(quiet, 'docs/a.md', RULES_PLAIN)).toEqual([])
    const named = `https://github.com/${slug}/releases/tag/v2.0.4\n`
    expect(scanText(named, 'CHANGELOG.md', RULES_PLAIN)).toEqual([])
    expect(scanText(named, MESSAGE_PATH, RULES_PLAIN)).toEqual([])
    expect(scanText(named, 'scripts/audit-public.config.json', RULES_PLAIN)).toEqual([])
  })
})

describe('file.generated', () => {
  test('build outputs, minified files, source maps and compiled Python are found by their path', () => {
    for (const path of [
      'dist/index.js',
      'desk2/web/build/app.js',
      'out/AgentHydra-2026.10.0-windows-x64.zip',
      'misc/tray-host-native/target/release/host.exe',
      'web/vendor/lib.min.js',
      'web/vendor/lib.min.css',
      'web/app.js.map',
      'hswarm/__pycache__/keys.cpython-312.pyc',
      'tools/x.pyc',
    ]) {
      expect(rulesOf(scanPath(path))).toEqual(['file.generated'])
      expect(scanPath(path)[0]?.fp).toBe(fingerprint(path))
    }
    for (const path of [
      'scripts/build.ts',
      'scripts/build-natives.ts',
      'docs/output.md',
      'src/distance.ts',
      'targets.md',
      'src/map.ts',
      'web/minimal.js',
      'docs/out-of-band.md',
    ]) {
      expect(scanPath(path)).toEqual([])
    }
  })

  test("a generated marker in a file's first five lines fires; a lockfile, a later line and prose do not", () => {
    const marker = j('// Code generated by protoc-gen-go. DO NOT', ' EDIT.')
    expect(generatedHeader('api/x.pb.go', `${marker}\npackage api\n`)).toMatchObject([
      { rule: 'file.generated', path: 'api/x.pb.go', line: 1, fp: fingerprint('api/x.pb.go') },
    ])
    const fire = [
      ['src/types.ts', j('/* auto', '-generated from schema.json */\n')],
      ['a.py', j('"""A module."""\n# This file was automatically ', 'generated\n')],
      ['web/a.js', j('/** @gene', 'rated */\n')],
    ]
    for (const [path, head] of fire)
      expect(rulesOf(generatedHeader(path, head))).toEqual(['file.generated'])
    const lock = j('# This file is automatically @gene', 'rated by Cargo.\n')
    expect(generatedHeader('desk2/launcher/host/Cargo.lock', lock)).toEqual([])
    expect(generatedHeader('a.ts', `${'// a line\n'.repeat(5)}${marker}\n`)).toEqual([])
    expect(
      generatedHeader('a.ts', '// Generated from the live registry, not a hand-written list.\n'),
    ).toEqual([])
    expect(generatedHeader('a.md', 'Please do not edit the generated files by hand.\n')).toEqual([])
  })
})

describe('asset.license', () => {
  const svg = j(
    '<svg xmlns="http://www.w3.org/2000/svg"><!-- Example Icons Pro by Example Co. Lic',
    'ense: commercial --><path d="M0 0h1"/></svg>\n',
  )
  const css = j(
    '/*! example-grid v1.2 | (c) 20',
    '24 Example Co. | MIT */\n.grid { display: grid }\n',
  )

  test("a licence or copyright in an SVG's or a stylesheet's comment fires", () => {
    expect(rulesOf(scanText(svg, 'web/icons/star.svg', RULES_PLAIN))).toEqual(['asset.license'])
    expect(rulesOf(scanText(css, 'web/vendor/grid.css', RULES_PLAIN))).toEqual(['asset.license'])
    const scss = j('// grid\n/* Copy', 'right 2024 Example Co. */\n.a { b: c }\n')
    expect(rulesOf(scanText(scss, 'web/vendor/grid.scss', RULES_PLAIN))).toEqual(['asset.license'])
    const rdf = j(
      '<svg><metadata><cc:lic',
      'ense rdf:resource="https://example.test/l"/></metadata></svg>\n',
    )
    expect(rulesOf(scanText(rdf, 'a.svg', RULES_PLAIN))).toEqual(['asset.license'])
  })

  test('a comment with no licence, a file that is no asset, and a file a notice or provenance names stay quiet', () => {
    const plain = '<svg><!-- drawn for this repository --><path d="M0 0"/></svg>\n'
    expect(scanText(plain, 'a.svg', RULES_PLAIN)).toEqual([])
    expect(scanText('.a { color: red } /* the big row */\n', 'a.css', RULES_PLAIN)).toEqual([])
    expect(scanText(css, 'web/vendor/grid.ts', RULES_PLAIN)).toEqual([])
    const noticed = compileRules(CONFIG, {
      notices: 'example-grid ships as `web/vendor/grid.css`.\n',
    })
    expect(scanText(css, 'web/vendor/grid.css', noticed)).toEqual([])
    expect(rulesOf(scanText(css, 'web/vendor/other.css', noticed))).toEqual(['asset.license'])
    const entry = {
      path: 'web/icons/star.svg',
      blob: 'b',
      sha256: 's',
      source: 's',
      build: 'b',
      license: 'l',
    }
    const recorded = compileRules(CONFIG, { provenance: [entry] })
    expect(scanText(svg, 'web/icons/star.svg', recorded)).toEqual([])
  })

  test("the audit's own run reads THIRD-PARTY-NOTICES.md for the paths it covers", () => {
    expect(AUDIT.notices).toContain('desk2/hydra/public/fonts/inter-latin.woff2')
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
    expect(write([{ ...ok, rule: 'commit.trailer' }])).toThrow('cannot be allowed')
    expect(write([{ ...ok, rule: 'license.boundary' }])).toThrow('cannot be allowed')
    expect(write([{ ...ok, rule: 'upstream.history' }])).toThrow('cannot be allowed')
  })

  test('a config without baseTree, or with an object id that is not a full one, stops the audit', () => {
    const file = join(scratch('base-config'), 'config.json')
    const load = (config: unknown) => {
      writeFileSync(file, JSON.stringify(config))
      return () => loadAuditFiles({ config: file })
    }
    expect(load(CONFIG)).not.toThrow()
    expect(load({ ...CONFIG, baseTree: undefined })).toThrow('no "baseTree"')
    expect(load({ ...CONFIG, base: CONFIG.base.slice(0, 8) })).toThrow('"base" is not a full')
    expect(load({ ...CONFIG, baseTree: 'HEAD^{tree}' })).toThrow('"baseTree" is not a full')
    expect(load({ ...CONFIG, upstreamBase: 'main' })).toThrow('"upstreamBase" is not a full')
  })

  test("this repository's own files: the base and its tree, upstream's base, the boundary, and entries that hold no values", () => {
    // The import commit, its tree (upstream's 3a65ba8e tree, unchanged), and upstream's commit.
    expect(CONFIG.base).toBe('c81335b7e90a85880cffbb54e51743a459cc7172')
    expect(CONFIG.baseTree).toBe('d6eda7b9e375d15e916c7a001099fa96051d6cc2')
    expect(CONFIG.upstreamBase).toBe('3a65ba8e6497c16732f627fc8934723839c82fdd')
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

  test(
    'a build output or a generated header is found once per file; a lockfile is not',
    () => {
      const dir = repo('generated')
      const marker = j('// Code generated by a tool. DO NOT', ' EDIT.')
      commit(
        dir,
        {
          'dist/app.js': `${marker}\nexport {}\n`,
          'src/gen.ts': `${marker}\nexport const a = 1\n`,
          'Cargo.lock': j('# This file is automatically @gene', 'rated by Cargo.\n'),
          'src/ok.ts': 'export const b = 2\n',
        },
        'init',
      )
      const { findings } = auditTree(dir, 'HEAD', ctxWith())
      expect(findings.map((f) => `${f.rule} ${f.path} ${f.line}`).sort()).toEqual([
        'file.generated dist/app.js 0',
        'file.generated src/gen.ts 1',
      ])
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
    'a commit that writes a generated header is found; one that edits further down the file is not',
    () => {
      const dir = repo('generated-history')
      const base = commit(dir, { 'a.ts': 'one\n' }, 'base')
      const marker = j('/* auto', '-generated: do not change by hand */')
      const added = commit(dir, { 'src/gen.ts': `${marker}\nexport const a = 1\n` }, 'add')
      commit(dir, { 'src/gen.ts': `${marker}\nexport const a = 2\n` }, 'edit')
      const history = auditHistory(dir, [`${base}..HEAD`], ctxWith())
      expect(history.findings).toHaveLength(1)
      expect(history.findings[0]).toMatchObject({
        rule: 'file.generated',
        path: 'src/gen.ts',
        line: 1,
        commit: added,
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
    "a trailer passes only as a credit with a GitHub noreply address; git cherry-pick -x's line never does",
    () => {
      const dir = repo('trailers')
      const base = commit(dir, { 'a.md': 'a\n' }, 'base')
      // The line cherry-pick -x writes, from git itself: it names a commit of another branch.
      git(dir, NOREPLY, 'checkout', '-q', '-b', 'elsewhere')
      const source = commit(dir, { 'b.md': 'b\n' }, 'Picked: a change\n\nIts body.')
      git(dir, NOREPLY, 'checkout', '-q', 'main')
      git(dir, NOREPLY, 'cherry-pick', '-x', source)
      const picked = git(dir, NOREPLY, 'rev-parse', 'HEAD')
      // A contribution a maintainer rewrote credits its author, in any case, folded or not.
      const credited = commit(
        dir,
        {},
        [
          'Credited',
          '',
          'A body.',
          '',
          `Co-authored-by: Example Owner <${NOREPLY}>`,
          `signed-off-by: Fixture <${NOREPLY}>`,
          'REVIEWED-BY: Example Reviewer',
          `  <${NOREPLY}>`,
        ].join('\n'),
      )
      // A tool's own trailers: a noreply address that is not GitHub's passes commit.email, not this.
      const tooled = commit(
        dir,
        {},
        [
          'Tooled',
          '',
          'A body.',
          '',
          'Co-Authored-By: Some Tool <noreply@example.invalid>',
          'Tool-Session: https://example.invalid/session/1',
          'Generated-by: Some Tool',
        ].join('\n'),
      )
      // A credit with no address, and a line in the block that is no trailer at all.
      const loose = commit(
        dir,
        {},
        `Loose\n\nA body.\n\nReported by a user\nSigned-off-by: Fixture\nSigned-off-by: Fixture <${NOREPLY}>`,
      )
      // A credit whose address is no noreply one is commit.email's finding, and only that.
      const personal = commit(
        dir,
        {},
        'Personal\n\nA body.\n\nCo-authored-by: Someone <someone@example.invalid>',
      )
      // Mine: and Swept: lists pass in a bundle's message only.
      const listed = commit(dir, {}, 'Listed\n\nA body.\n\nMine:\n  a.md\nSwept:\n  b.md')
      // Quoted in the middle of a message, the line still names the commit.
      const quoted = commit(
        dir,
        {},
        `Quoted\n\nIt said\n(cherry picked from commit ${source})\nonce.\n\nThe end.`,
      )
      // Prose with colons is no trailer: a colon after a phrase, or in a paragraph before the last.
      const prose = commit(
        dir,
        {},
        'Prose: a subject\n\nNote: not the last paragraph.\n\nThe fix: a test.',
      )

      const { findings } = auditHistory(dir, [`${base}..HEAD`], ctxWith())
      const trailers = findings.filter((f) => f.rule === 'commit.trailer')
      expect(trailers.map((f) => [f.commit, f.path, f.line, f.note])).toEqual([
        [quoted, MESSAGE_PATH, 4, 'cherry-pick'],
        [listed, MESSAGE_PATH, 5, 'trailer Mine'],
        [listed, MESSAGE_PATH, 7, 'trailer Swept'],
        [loose, MESSAGE_PATH, 5, 'trailer block'],
        [loose, MESSAGE_PATH, 6, 'trailer Signed-off-by with no GitHub noreply address'],
        [tooled, MESSAGE_PATH, 5, 'trailer Co-Authored-By with no GitHub noreply address'],
        [tooled, MESSAGE_PATH, 6, 'trailer Tool-Session'],
        [tooled, MESSAGE_PATH, 7, 'trailer Generated-by'],
        [picked, MESSAGE_PATH, 5, 'cherry-pick'],
      ])
      expect(trailers.map((f) => f.fp)).toEqual([
        fingerprint(`(cherry picked from commit ${source})`),
        fingerprint('Mine:\na.md'),
        fingerprint('Swept:\nb.md'),
        fingerprint('Reported by a user'),
        fingerprint('Signed-off-by: Fixture'),
        fingerprint('Co-Authored-By: Some Tool <noreply@example.invalid>'),
        fingerprint('Tool-Session: https://example.invalid/session/1'),
        fingerprint('Generated-by: Some Tool'),
        fingerprint(`(cherry picked from commit ${source})`),
      ])
      expect(findings.filter((f) => f.commit === credited)).toEqual([])
      expect(findings.filter((f) => f.commit === prose)).toEqual([])
      expect(findings.filter((f) => f.commit === personal)).toMatchObject([
        {
          rule: 'commit.email',
          note: 'trailer Co-authored-by',
          fp: fingerprint('someone@example.invalid'),
        },
      ])
      expect(findings.filter((f) => !['commit.trailer', 'commit.email'].includes(f.rule))).toEqual(
        [],
      )

      // Not allowable: an entry for it clears nothing.
      const entry = {
        rule: 'commit.trailer',
        path: MESSAGE_PATH,
        fp: trailers[0]?.fp ?? '',
        reason: 'tried',
      }
      applyAllow(trailers, [entry])
      expect(trailers.some((f) => f.allowed)).toBe(false)
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    "a tool's trailers are findings wherever they sit, where git reads no trailer block too",
    () => {
      const dir = repo('tool-trailers')
      const base = commit(dir, {}, 'base')
      const tool = 'Co-Authored-By: Some Tool (a model) <noreply@example.invalid>'
      const session = 'Some-Session: https://example.invalid/code/session_0123456789abcdef'
      // Under a prose line, with no blank line between them.
      const glued = commit(dir, {}, `Glued\n\nThe last paragraph is prose.\n${session}`)
      const gluedTwo = commit(
        dir,
        {},
        `Glued two\n\nThe body, one paragraph,\nends here.\n${tool}\n${session}`,
      )
      // In a paragraph of their own that one prose line ends.
      const thenProse = commit(
        dir,
        {},
        `Then prose\n\nA body.\n\n${tool}\n${session}\nGenerated with a tool.`,
      )
      // In a paragraph before the last.
      const middle = commit(dir, {}, `Middle\n\nA body.\n\n${tool}\n${session}\n\nThe end.`)
      // A change id and a key with a hyphen, under prose: Gerrit's and a tool's.
      const changeId = `Change-Id: I${'0123456789abcdef'.repeat(2)}01234567`
      const gerrit = commit(
        dir,
        {},
        `Gerrit\n\nA body that ends here.\n${changeId}\nGenerated-by: Some Tool`,
      )
      // A credit with a personal address, under prose, is commit.email's finding only.
      const personal = commit(
        dir,
        {},
        'Personal\n\nA body.\nCo-authored-by: Someone <someone@example.invalid>',
      )
      // Prose that looks like it passes: a hyphenated word and a colon in the subject or a paragraph
      // before the last, a wrapped line that starts with a lowercase one, an id or a URL inside a
      // sentence, and a credit with a GitHub noreply address, under prose or in the middle.
      const prose = commit(
        dir,
        {},
        [
          'Pre-push: a subject with a hyphenated word before its colon',
          '',
          'Windows-only: a sentence that starts a paragraph before the last.',
          `Co-authored-by: Example Owner <${NOREPLY}>`,
          '',
          'The last paragraph is prose, wrapped where a line starts with a',
          'mingw-w64: word, and it names 0123abcd and https://example.invalid/x in a sentence.',
          `Co-authored-by: Example Owner <${NOREPLY}>`,
        ].join('\n'),
      )
      // git reads none of these as a trailer block.
      for (const sha of [glued, gluedTwo, thenProse, middle, gerrit, personal, prose]) {
        expect(git(dir, NOREPLY, 'log', '-1', '--format=%(trailers)', sha)).toBe('')
      }

      const { findings } = auditHistory(dir, [`${base}..HEAD`], ctxWith())
      const trailers = findings.filter((f) => f.rule === 'commit.trailer')
      const credit = 'trailer Co-Authored-By with no GitHub noreply address'
      expect(trailers.map((f) => [f.commit, f.path, f.line, f.note])).toEqual([
        [gerrit, MESSAGE_PATH, 4, 'trailer Change-Id'],
        [gerrit, MESSAGE_PATH, 5, 'trailer Generated-by'],
        [middle, MESSAGE_PATH, 5, credit],
        [middle, MESSAGE_PATH, 6, 'trailer Some-Session'],
        [thenProse, MESSAGE_PATH, 5, credit],
        [thenProse, MESSAGE_PATH, 6, 'trailer Some-Session'],
        [gluedTwo, MESSAGE_PATH, 5, credit],
        [gluedTwo, MESSAGE_PATH, 6, 'trailer Some-Session'],
        [glued, MESSAGE_PATH, 4, 'trailer Some-Session'],
      ])
      expect(trailers.map((f) => f.fp)).toEqual([
        fingerprint(changeId),
        fingerprint('Generated-by: Some Tool'),
        ...[1, 2, 3].flatMap(() => [fingerprint(tool), fingerprint(session)]),
        fingerprint(session),
      ])
      expect(findings.filter((f) => f.commit === prose)).toEqual([])
      expect(findings.filter((f) => f.commit === personal)).toMatchObject([
        {
          rule: 'commit.email',
          note: 'trailer Co-authored-by',
          fp: fingerprint('someone@example.invalid'),
        },
      ])
      // commit.email lets the tool's address through: it is a noreply one.
      expect(findings.filter((f) => f.rule === 'commit.email' && f.commit !== personal)).toEqual([])
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    "GitHub's merge of a pull request may carry a title shaped like a trailer, but not a tool's trailer",
    () => {
      const dir = repo('pr-merge-title')
      const base = commit(dir, {}, 'base')
      // A real merge GitHub committed, with the given message.
      const merge = (branch: string, message: string, email = 'noreply@github.com') => {
        git(dir, NOREPLY, 'checkout', '-q', '-b', branch)
        commit(dir, { [`${branch}.txt`]: branch }, `Work on ${branch}`)
        git(dir, NOREPLY, 'checkout', '-q', 'main')
        git(dir, email, 'merge', '-q', '--no-ff', '-m', message, branch)
        return git(dir, NOREPLY, 'rev-parse', 'HEAD')
      }
      merge('release', 'Merge pull request #24 from Example/release\n\nRelease: prepare 2026.10.2')
      const tool = merge('tool', 'Merge pull request #25 from Example/tool\n\nTool-Session: abc')
      const link = merge(
        'link',
        'Merge pull request #26 from Example/link\n\nSee: https://example.invalid/x',
      )
      const local = merge(
        'local',
        'Merge pull request #27 from Example/local\n\nRelease: prepare 2026.10.3',
        NOREPLY,
      )
      const plain = commit(
        dir,
        {},
        'Merge pull request #28 from Example/plain\n\nRelease: prepare 2026.10.4',
      )
      const { findings } = auditHistory(dir, [`${base}..HEAD`], ctxWith())
      const trailers = findings.filter((f) => f.rule === 'commit.trailer')
      expect(trailers.map((f) => [f.commit, f.note])).toEqual([
        [plain, 'trailer Release'],
        [local, 'trailer Release'],
        [link, 'trailer See'],
        [tool, 'trailer Tool-Session'],
      ])
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    'a last paragraph of Note: sentences is prose, though git reads it as trailers; a Fixes: #12 is not',
    () => {
      const dir = repo('note-lines')
      const base = commit(dir, {}, 'base')
      const notes = [
        'Note: the Mac build is not made in CI.',
        'Note: the Windows build needs the signing key.',
      ]
      const list = commit(dir, {}, `Notes\n\nA body.\n\n${notes.join('\n')}`)
      const one = commit(dir, {}, `Note one\n\nA body.\n\n${notes[0]}`)
      expect(git(dir, NOREPLY, 'log', '-1', '--format=%(trailers)', list)).toBe(notes.join('\n'))
      expect(git(dir, NOREPLY, 'log', '-1', '--format=%(trailers)', one)).toBe(notes[0])
      // A one-word key is a trailer still when its value is no sentence, or names a URL, an
      // address or an id; a key with a hyphen is one whatever its value.
      const closes = commit(dir, {}, 'Closes\n\nA body.\n\nFixes: #12')
      const named = commit(
        dir,
        {},
        [
          'Named',
          '',
          'A body.',
          '',
          'Tool: Some Tool',
          'See: the log at https://example.invalid/log/1 for it.',
          'Picked: from 0123abcd4 of another branch.',
          'Mail: write to someone@example.invalid about it.',
          'Follow-up: the tray build is next, in a commit of its own.',
        ].join('\n'),
      )

      const { findings } = auditHistory(dir, [`${base}..HEAD`], ctxWith())
      expect(findings.map((f) => [f.rule, f.commit, f.line, f.note])).toEqual([
        ['commit.trailer', named, 5, 'trailer Tool'],
        ['commit.trailer', named, 6, 'trailer See'],
        ['commit.trailer', named, 7, 'trailer Picked'],
        ['commit.trailer', named, 8, 'trailer Mail'],
        ['commit.trailer', named, 9, 'trailer Follow-up'],
        ['commit.trailer', closes, 5, 'trailer Fixes'],
      ])
      expect(findings[findings.length - 1]?.fp).toBe(fingerprint('Fixes: #12'))
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    'a commit save:bundle makes is publishable: git reads its Mine: and Swept: lists as trailers, and they pass',
    () => {
      // scripts/save-bundle.ts itself, through the real commit-msg hook, as on a contributor's PC.
      const dir = repo('bundle')
      mkdirSync(join(dir, '.githooks'))
      for (const name of ['commit-msg', 'check-bundle-message.mjs']) {
        copyFileSync(join(REPO_ROOT, '.githooks', name), join(dir, '.githooks', name))
      }
      chmodSync(join(dir, '.githooks', 'commit-msg'), 0o755)
      for (const [key, value] of [
        ['core.hooksPath', '.githooks'],
        ['user.email', NOREPLY],
        ['user.name', 'Fixture'],
        ['commit.gpgsign', 'false'],
      ]) {
        git(dir, NOREPLY, 'config', key, value)
      }
      const base = commit(dir, {}, 'base')
      const saveBundle = (files: Record<string, string>, ...args: string[]) => {
        for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body)
        const r = spawnSync(process.execPath, [SAVE_BUNDLE, ...args], {
          cwd: dir,
          encoding: 'utf8',
          timeout: GIT_TEST_TIMEOUT,
        })
        expect(r.stderr).toContain('swept from other sessions')
        expect(r.status).toBe(0)
        return git(dir, NOREPLY, 'rev-parse', 'HEAD')
      }
      const lists = saveBundle({ 'mine.md': 'm\n', 'other.md': 'o\n' }, '--mine', 'mine.md')
      expect(git(dir, NOREPLY, 'log', '-1', '--format=%(trailers)')).toBe(
        'Mine:\n  mine.md\nSwept:\n  other.md',
      )
      const credit = `Co-authored-by: Example Owner <${NOREPLY}>`
      const credited = saveBundle(
        { 'more.md': 'm\n', 'peer.md': 'p\n' },
        '--mine',
        'more.md',
        '--trailer',
        credit,
      )
      expect(git(dir, NOREPLY, 'log', '-1', '--format=%(trailers)')).toBe(credit)
      const history = auditHistory(dir, [`${base}..HEAD`], ctxWith())
      expect(history.commits.map((c) => c.sha)).toEqual([credited, lists])
      expect(history.findings).toEqual([])

      // A trailer of a tool's own, passed through --trailer, is still a finding.
      const tooled = saveBundle(
        { 'last.md': 'l\n', 'theirs.md': 't\n' },
        '--mine',
        'last.md',
        '--trailer',
        'Generated-by: Some Tool',
      )
      expect(
        auditHistory(dir, [`${base}..HEAD`], ctxWith()).findings.map((f) => [f.commit, f.note]),
      ).toEqual([[tooled, 'trailer Generated-by']])
    },
    GIT_TEST_TIMEOUT * 2,
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
    "a regenerated picture's earlier bytes pass history only as its entry's previous bytes, and never the tree",
    () => {
      const dir = repo('regenerated')
      const base = commit(dir, {}, 'base')
      const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
      const first = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), randomBytes(32)])
      const second = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), randomBytes(32)])
      commit(dir, { 'shot.png': first }, 'first picture')
      const firstBlob = git(dir, NOREPLY, 'rev-parse', 'HEAD:shot.png')
      commit(dir, { 'shot.png': second }, 'regenerated')
      const current = {
        path: 'shot.png',
        blob: git(dir, NOREPLY, 'rev-parse', 'HEAD:shot.png'),
        sha256: sha(second),
        source: 's',
        build: 'b',
        license: 'l',
      }

      const without = auditHistory(dir, [`${base}..HEAD`], ctxWith({ provenance: [current] }))
      expect(without.findings.map((f) => f.fp)).toEqual([sha(first).slice(0, 16)])

      const recorded = { ...current, previous: [{ blob: firstBlob, sha256: sha(first) }] }
      expect(
        auditHistory(dir, [`${base}..HEAD`], ctxWith({ provenance: [recorded] })).findings,
      ).toEqual([])

      // The tree's picture must be the current one: previous bytes there are a change.
      commit(dir, { 'shot.png': first }, 'back to the first')
      expect(
        auditTree(dir, 'HEAD', ctxWith({ provenance: [recorded] })).findings.map((f) => f.note),
      ).toEqual(['changed since its provenance entry'])
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

describe('the base', () => {
  /** A repository like this one: the import commit (a root, with `tree`), then a commit of its own. */
  function imported(
    name: string,
    importEmail = NOREPLY,
    importFiles: Record<string, string> = { 'README.md': 'upstream\n' },
  ) {
    const dir = repo(name)
    const base = commit(dir, importFiles, 'the import commit', importEmail)
    const tree = git(dir, NOREPLY, 'rev-parse', `${base}^{tree}`)
    const own = commit(dir, { 'notes.md': 'own work\n' }, 'own work')
    return { dir, base, tree, own, config: { ...CONFIG, base, baseTree: tree } }
  }

  test(
    'a root commit with baseTree as its tree, under every commit read, is the base',
    () => {
      const { dir, base, own, config } = imported('base-ok')
      expect(checkBase(dir, config, [own, base])).toBe(base)
      expect(checkBase(dir, { ...config, base: base.toUpperCase() }, [own])).toBe(base)
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    'a base with a parent, a base with another tree, and a commit not built on the base each stop the audit',
    () => {
      const { dir, base, tree, own, config } = imported('base-wrong')
      // Its parent would be history before the import commit: upstream's.
      const ownTree = git(dir, NOREPLY, 'rev-parse', `${own}^{tree}`)
      expect(() => checkBase(dir, { ...config, base: own, baseTree: ownTree }, [own])).toThrow(
        `the base ${own.slice(0, 8)} is not a root commit (it has 1 parent)`,
      )
      // A root with another tree is not upstream's tree unchanged.
      expect(() => checkBase(dir, { ...config, baseTree: ownTree }, [own])).toThrow(
        `the base ${base.slice(0, 8)} has the tree ${tree.slice(0, 8)}, not the config's baseTree ${ownTree.slice(0, 8)}`,
      )
      // A commit on another root has no start for the history audit.
      git(dir, NOREPLY, 'checkout', '-q', '--orphan', 'elsewhere')
      const stray = commit(dir, { 'README.md': 'upstream\n' }, 'another root, with the same tree')
      expect(() => checkBase(dir, config, [own, stray])).toThrow(
        `${stray.slice(0, 8)} is not built on the base ${base.slice(0, 8)}`,
      )
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    'another root under a commit built on the base stops the audit: a merge of unrelated history',
    () => {
      const { dir, base, own, config } = imported('base-roots')
      // A root of its own, merged in: the tip still descends from the base, but what the merge
      // brings does not.
      git(dir, NOREPLY, 'checkout', '-q', '--orphan', 'unrelated')
      git(dir, NOREPLY, 'rm', '-rq', '--cached', '.')
      const stray = commit(dir, { 'other.md': 'other\n' }, 'a root of its own')
      git(dir, NOREPLY, 'checkout', '-q', '-f', 'main')
      git(dir, NOREPLY, 'merge', '-q', '--no-edit', '--allow-unrelated-histories', 'unrelated')
      const merged = git(dir, NOREPLY, 'rev-parse', 'HEAD')
      expect(git(dir, NOREPLY, 'merge-base', '--is-ancestor', base, merged)).toBe('')
      expect(checkBase(dir, config, [own])).toBe(base)
      expect(() => checkBase(dir, config, [own, merged])).toThrow(
        `the history of ${merged.slice(0, 8)} has the root commit ${stray.slice(0, 8)} besides the base ${base.slice(0, 8)}`,
      )
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    'a commit whose history a shallow fetch cut off stops the audit, though the base is whole',
    () => {
      const { dir, base, own, config } = imported('base-cut')
      git(dir, NOREPLY, 'checkout', '-q', '-b', 'side')
      commit(dir, { 'side.md': 'one\n' }, 'side, one')
      const tip = commit(dir, { 'side.md': 'two\n' }, 'side, two')
      const url = pathToFileURL(dir).href
      const clone = scratch('base-cut-clone')
      git(clone, NOREPLY, 'clone', '-q', '--no-local', '--single-branch', '-b', 'main', url, '.')
      git(clone, NOREPLY, 'fetch', '-q', '--depth', '1', 'origin', 'side')
      expect(checkBase(clone, config, [own])).toBe(base)
      expect(() => checkBase(clone, config, [tip])).toThrow(
        `this shallow clone cuts the history of ${tip.slice(0, 8)} off at ${tip.slice(0, 8)}`,
      )
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    'a clone without the base, or with it at the edge of a shallow history, stops the audit',
    () => {
      const { dir, base, own, config } = imported('base-shallow')
      const url = pathToFileURL(dir).href
      const shallow = scratch('base-shallow-clone')
      git(shallow, NOREPLY, 'clone', '-q', '--depth', '1', url, '.')
      expect(() => checkBase(shallow, config, [own])).toThrow(
        `the base ${base.slice(0, 8)} (the import commit) is not in this clone`,
      )
      // The clone has `own`, but not its parent: whether it is a root cannot be told.
      const ownTree = git(dir, NOREPLY, 'rev-parse', `${own}^{tree}`)
      expect(() => checkBase(shallow, { ...config, base: own, baseTree: ownTree }, [own])).toThrow(
        `the base ${own.slice(0, 8)} is at the edge of this shallow clone`,
      )
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    "the base's own author, committer and message are read; its tree is not",
    () => {
      const { dir, base, config } = imported('base-meta', MAILBOX)
      const ctx = ctxWith({ config })
      const found = auditBaseCommit(dir, base, ctx)
      expect(rulesOf(found)).toEqual(['commit.email', 'commit.email'])
      expect(found.every((f) => f.commit === base)).toBe(true)
      expect(found.map((f) => f.fp)).toEqual([fingerprint(MAILBOX), fingerprint(MAILBOX)])

      // The tree it imports is not read as added lines, even with a value in it.
      const tree = imported('base-meta-tree', NOREPLY, { 'docs/hosts.md': `${IP.ten}\n` })
      expect(auditBaseCommit(tree.dir, tree.base, ctxWith({ config: tree.config }))).toEqual([])

      // Its trailers are read as any commit's: a credit passes, a tool's own does not.
      const trailed = imported('base-meta-trailer')
      git(trailed.dir, NOREPLY, 'checkout', '-q', '--orphan', 'retold')
      git(
        trailed.dir,
        NOREPLY,
        'commit',
        '-q',
        '-m',
        `the import\n\nCo-authored-by: Fixture <${NOREPLY}>\nGenerated-by: Some Tool`,
      )
      const retold = git(trailed.dir, NOREPLY, 'rev-parse', 'HEAD')
      expect(
        auditBaseCommit(trailed.dir, retold, ctxWith({ config: trailed.config })),
      ).toMatchObject([
        { rule: 'commit.trailer', commit: retold, line: 4, note: 'trailer Generated-by' },
      ])
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    'the default run and --push check the base before they read anything, and exit 2 when it is wrong',
    () => {
      const { dir, base, own, config } = imported('base-cli', MAILBOX)
      const files = scratch('base-cli-files')
      const cfg = join(files, 'config.json')
      const allow = join(files, 'allow.json')
      const provenance = join(files, 'provenance.json')
      writeFileSync(allow, JSON.stringify({ entries: [] }))
      writeFileSync(provenance, JSON.stringify({ binaries: [] }))
      const run = (args: string[], input = '') =>
        spawnSync(
          process.execPath,
          [
            SCRIPT,
            ...args,
            '-C',
            dir,
            '--config',
            cfg,
            '--allow',
            allow,
            '--provenance',
            provenance,
            '--no-local-names',
          ],
          {
            encoding: 'utf8',
            input,
            timeout: GIT_TEST_TIMEOUT,
            env: { ...process.env, GITHUB_ACTIONS: '' },
          },
        )
      const pushLine = `refs/heads/main ${own} refs/heads/main ${'0'.repeat(40)}\n`

      // The right base: the run reads on, and the base's own author is a finding.
      const baseFinding = new RegExp(`commit\\.email +${base.slice(0, 8)} \\(commit\\)`)
      writeFileSync(cfg, JSON.stringify(config))
      const full = run([])
      expect(full.stderr).toContain(`history ${base}..HEAD (1 commits)`)
      expect(full.stderr).toMatch(baseFinding)
      expect(full.stderr).not.toContain(MAILBOX)
      expect(full.status).toBe(1)
      const pushed = run(['--push', 'origin'], pushLine)
      expect(pushed.stderr).toContain('push to origin (1 new commits)')
      expect(pushed.stderr).toMatch(baseFinding)
      expect(pushed.status).toBe(1)

      // A merge of unrelated history: the tip is built on the base, but the default run and --push
      // stop there, before reading anything.
      git(dir, NOREPLY, 'checkout', '-q', '--orphan', 'unrelated')
      git(dir, NOREPLY, 'rm', '-rq', '--cached', '.')
      const stray = commit(dir, { 'other.md': 'other\n' }, 'a root of its own')
      git(dir, NOREPLY, 'checkout', '-q', '-f', '-b', 'merged', own)
      git(dir, NOREPLY, 'merge', '-q', '--no-edit', '--allow-unrelated-histories', 'unrelated')
      const merged = git(dir, NOREPLY, 'rev-parse', 'HEAD')
      const mergedLine = `refs/heads/main ${merged} refs/heads/main ${own}\n`
      for (const r of [run([]), run(['--push', 'origin'], mergedLine)]) {
        expect(r.stderr).toContain(`has the root commit ${stray.slice(0, 8)} besides the base`)
        expect(r.stderr).not.toContain('tree HEAD')
        expect(r.status).toBe(2)
      }
      git(dir, NOREPLY, 'checkout', '-q', 'main')

      // A base with a parent: neither the default run nor --push reads anything.
      const ownTree = git(dir, NOREPLY, 'rev-parse', `${own}^{tree}`)
      writeFileSync(cfg, JSON.stringify({ ...config, base: own, baseTree: ownTree }))
      for (const r of [run([]), run(['--push', 'origin'], pushLine)]) {
        expect(r.stderr).toContain(`audit:public could not run: the base ${own.slice(0, 8)}`)
        expect(r.stderr).toContain('is not a root commit')
        expect(r.stderr).not.toContain('tree HEAD')
        expect(r.status).toBe(2)
      }

      // Another tree: a range from the base is checked first; a range from a later commit is not
      // every commit after the base, and reads on.
      writeFileSync(cfg, JSON.stringify({ ...config, baseTree: ownTree }))
      const fromBase = run(['--history', `${base}..HEAD`])
      expect(fromBase.stderr).toContain("not the config's baseTree")
      expect(fromBase.status).toBe(2)
      expect(run(['--history', `${own}..HEAD`]).status).toBe(0)
    },
    GIT_TEST_TIMEOUT,
  )
})

describe('upstream.history', () => {
  test("upstream's last MIT commit is built in: the config can add one, never take it away", () => {
    expect(CONFIG.upstreamBase).toBe(UPSTREAM_BASE)
    expect(upstreamBases({})).toEqual([UPSTREAM_BASE])
    expect(upstreamBases({ upstreamBase: UPSTREAM_BASE.toUpperCase() })).toEqual([UPSTREAM_BASE])
    const other = 'ab'.repeat(20)
    expect(upstreamBases({ upstreamBase: other })).toEqual([UPSTREAM_BASE, other])
  })

  test(
    "a commit that shares upstream's history is a finding, whatever it shares; a clone without upstream's commit has none",
    () => {
      // Upstream's history in miniature, then the import commit (its tree, no parent) and own work.
      const dir = repo('upstream-history')
      git(dir, NOREPLY, 'checkout', '-q', '--orphan', 'upstream')
      const before = commit(dir, { 'a.md': 'a\n' }, 'upstream, before its last MIT commit')
      const upstreamBase = commit(dir, { 'b.md': 'b\n' }, "upstream's last MIT commit")
      const tree = git(dir, NOREPLY, 'rev-parse', `${upstreamBase}^{tree}`)
      const base = git(dir, NOREPLY, 'commit-tree', tree, '-m', 'the import commit')
      git(dir, NOREPLY, 'checkout', '-q', '-B', 'main', base)
      const own = commit(dir, { 'c.md': 'c\n' }, 'own work')
      const config = { ...CONFIG, base, baseTree: tree, upstreamBase }
      const ctx = ctxWith({ config })

      expect(auditTree(dir, own, ctx).findings).toEqual([])
      expect(upstreamFindings(dir, [upstreamBase], [base, own])).toEqual([])

      // A clone of this repository's own branch has none of upstream's commits: nothing to find.
      const clone = scratch('upstream-history-clone')
      const url = pathToFileURL(dir).href
      git(clone, NOREPLY, 'clone', '-q', '--single-branch', '--no-tags', '-b', 'main', url, '.')
      expect(
        spawnSync('git', ['cat-file', '-e', `${upstreamBase}^{commit}`], { cwd: clone }).status,
      ).not.toBe(0)
      expect(upstreamFindings(clone, [upstreamBase], [own])).toEqual([])

      // A merge of upstream's branch brings its history in; so does a branch from before the base.
      git(dir, NOREPLY, 'merge', '-q', '--no-edit', '--allow-unrelated-histories', 'upstream')
      const merged = git(dir, NOREPLY, 'rev-parse', 'HEAD')
      const found = auditTree(dir, 'HEAD', ctx).findings
      expect(rulesOf(found)).toEqual(['upstream.history'])
      expect(found[0]).toMatchObject({
        commit: merged,
        note: `contains ${upstreamBase.slice(0, 8)}`,
      })
      const older = upstreamFindings(dir, [upstreamBase], [before])
      expect(older.map((f) => f.note)).toEqual([
        `contains ${before.slice(0, 8)}, before ${upstreamBase.slice(0, 8)}`,
      ])

      // The default run finds it on the tree's commit and on the history's tip, and --push on the
      // pushed commit.
      const files = scratch('upstream-history-files')
      writeFileSync(join(files, 'config.json'), JSON.stringify(config))
      writeFileSync(join(files, 'allow.json'), JSON.stringify({ entries: [] }))
      writeFileSync(join(files, 'provenance.json'), JSON.stringify({ binaries: [] }))
      const run = (args: string[], input = '') =>
        spawnSync(
          process.execPath,
          [
            SCRIPT,
            ...args,
            '-C',
            dir,
            '--config',
            join(files, 'config.json'),
            '--allow',
            join(files, 'allow.json'),
            '--provenance',
            join(files, 'provenance.json'),
            '--no-local-names',
            '--json',
          ],
          { encoding: 'utf8', input, timeout: GIT_TEST_TIMEOUT },
        )
      const lineage = (r: ReturnType<typeof run>) =>
        (JSON.parse(r.stdout) as { findings: Array<{ rule: string; commit?: string }> }).findings
          .filter((f) => f.rule === 'upstream.history')
          .map((f) => f.commit)
      // The default run and --push check the base first and stop there (exit 2): upstream's history
      // has a root of its own. --tree, and a range that starts after the base, read on and find it
      // on the tree's commit and on the range's end.
      const full = run([])
      expect(full.status).toBe(2)
      expect(full.stderr).toContain(`has the root commit ${before.slice(0, 8)} besides the base`)
      const pushed = run(['--push', 'origin'], `refs/heads/main ${merged} refs/heads/main ${own}\n`)
      expect(pushed.status).toBe(2)
      expect(pushed.stderr).toContain(`has the root commit ${before.slice(0, 8)} besides the base`)
      const later = run(['--tree', 'HEAD', '--history', `${own}..HEAD`])
      expect(later.status).toBe(1)
      expect(lineage(later)).toEqual([merged, merged])
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    "a clone without upstream's last MIT commit can hold its older history; the base check stops it",
    () => {
      // Upstream in miniature as above, and a clone of this repository's branch alone, into which
      // one of upstream's older commits is fetched on its own, as `git fetch upstream tag <older>`
      // would: it brings that commit's history, not upstreamBase.
      const dir = repo('upstream-older')
      git(dir, NOREPLY, 'checkout', '-q', '--orphan', 'upstream')
      const before = commit(dir, { 'a.md': 'a\n' }, 'upstream, before its last MIT commit')
      const upstreamBase = commit(dir, { 'b.md': 'b\n' }, "upstream's last MIT commit")
      const tree = git(dir, NOREPLY, 'rev-parse', `${upstreamBase}^{tree}`)
      const base = git(dir, NOREPLY, 'commit-tree', tree, '-m', 'the import commit')
      git(dir, NOREPLY, 'checkout', '-q', '-B', 'main', base)
      const own = commit(dir, { 'c.md': 'c\n' }, 'own work')
      git(dir, NOREPLY, 'tag', 'older', before)
      const config = { ...CONFIG, base, baseTree: tree, upstreamBase }

      const clone = scratch('upstream-older-clone')
      const url = pathToFileURL(dir).href
      git(
        clone,
        NOREPLY,
        'clone',
        '-q',
        '--no-local',
        '--single-branch',
        '--no-tags',
        '-b',
        'main',
        url,
        '.',
      )
      git(clone, NOREPLY, 'fetch', '-q', '--no-tags', 'origin', 'refs/tags/older:refs/tags/older')
      git(clone, NOREPLY, 'merge', '-q', '--no-edit', '--allow-unrelated-histories', 'older')
      const merged = git(clone, NOREPLY, 'rev-parse', 'HEAD')
      expect(
        spawnSync('git', ['cat-file', '-e', `${upstreamBase}^{commit}`], { cwd: clone }).status,
      ).not.toBe(0)

      // upstream.history has nothing to look for here; the base check does not need it.
      expect(upstreamFindings(clone, [upstreamBase], [merged])).toEqual([])
      expect(() => checkBase(clone, config, [merged])).toThrow(
        `the history of ${merged.slice(0, 8)} has the root commit ${before.slice(0, 8)} besides the base ${base.slice(0, 8)}`,
      )
      expect(() => checkBase(clone, config, [before])).toThrow(
        `${before.slice(0, 8)} is not built on the base ${base.slice(0, 8)}`,
      )
      expect(checkBase(clone, config, [own])).toBe(base)
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
    'a full run fails on an allow entry that clears nothing; a tree or history run alone only counts it',
    () => {
      const dir = repo('stale')
      const base = commit(dir, { 'README.md': 'base\n' }, 'base')
      const kept = j('gh', 'p_', rand(36)) // in the tree at HEAD
      const gone = j('gh', 'p_', rand(36)) // added, then taken out again: only in a commit
      const never = j('gh', 'p_', rand(36)) // nowhere at all
      const added = commit(
        dir,
        { 'src/a.ts': `export const t = "${kept}"\nexport const u = "${gone}"\n` },
        'add',
      )
      commit(dir, { 'src/a.ts': `export const t = "${kept}"\n` }, 'take one out')

      const files = scratch('stale-files')
      const config = join(files, 'config.json')
      const allow = join(files, 'allow.json')
      const provenance = join(files, 'provenance.json')
      const baseTree = git(dir, NOREPLY, 'rev-parse', `${base}^{tree}`)
      writeFileSync(config, JSON.stringify({ ...CONFIG, base, baseTree }))
      writeFileSync(provenance, JSON.stringify({ binaries: [] }))
      const entry = (value: string, reason: string) => ({
        rule: 'secret.token',
        path: 'src/a.ts',
        fp: fingerprint(value),
        reason,
      })
      const inTree = entry(kept, 'synthetic token in the tree')
      const inHistory = entry(gone, 'synthetic token in an earlier commit')
      const stale = entry(never, 'synthetic token that is nowhere')
      const run = (...modes: string[]) =>
        spawnSync(
          process.execPath,
          [
            SCRIPT,
            ...modes,
            '-C',
            dir,
            '--config',
            config,
            '--allow',
            allow,
            '--provenance',
            provenance,
            '--no-local-names',
          ],
          {
            encoding: 'utf8',
            timeout: GIT_TEST_TIMEOUT,
            env: { ...process.env, GITHUB_ACTIONS: '' },
          },
        )

      writeFileSync(allow, JSON.stringify({ entries: [inTree, inHistory, stale] }))
      const full = run()
      expect(full.status).toBe(1)
      expect(full.stderr).toContain('1 stale allowlist entry: it clears nothing')
      expect(full.stderr).toMatch(/stale allowlist entry: secret\.token +src\/a\.ts/)
      expect(full.stderr).toContain(stale.fp)
      expect(full.stderr).not.toContain(inTree.fp)
      expect(full.stderr).not.toContain(inHistory.fp)
      expect(full.stderr).not.toContain('✓ clean')
      expect(full.stderr).not.toContain('matched nothing here')
      // The same two halves named on the command line are a full run as well.
      expect(run('--tree', 'HEAD', '--history', `${base}..HEAD`).status).toBe(1)
      const doc = JSON.parse(run('--json').stdout) as {
        ok: boolean
        findings: Array<{ allowed?: string }>
        staleAllow: unknown[]
      }
      expect(doc.ok).toBe(false)
      expect(doc.findings.length).toBeGreaterThan(0)
      expect(doc.findings.every((f) => Boolean(f.allowed))).toBe(true)
      expect(doc.staleAllow).toEqual([stale])

      // Half a run cannot tell an entry the other half needs from one nobody needs.
      const tree = run('--tree', 'HEAD')
      expect(tree.status).toBe(0)
      expect(tree.stderr).toContain('✓ clean')
      expect(tree.stderr).toContain('(2 allowlist entries matched nothing here)')
      expect(run('--history', `${base}..HEAD`).status).toBe(0)
      // History from a later commit than the base is not every commit since it.
      expect(run('--tree', 'HEAD', '--history', `${added}..HEAD`).status).toBe(0)

      writeFileSync(allow, JSON.stringify({ entries: [inTree, inHistory] }))
      const fixed = run()
      expect(fixed.status).toBe(0)
      expect(fixed.stderr).toContain('✓ clean: 3 finding(s) allowed')
      expect(fixed.stderr).not.toContain('stale')
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
    "the base is the import commit: a root commit with upstream's tree, under HEAD",
    () => {
      expect(checkBase(REPO_ROOT, CONFIG, [git(REPO_ROOT, NOREPLY, 'rev-parse', 'HEAD')])).toBe(
        CONFIG.base,
      )
    },
    GIT_TEST_TIMEOUT,
  )

  test.skipIf(!hasCommit(UPSTREAM_BASE))(
    "where upstream's commit is in this clone (a remote of upstream's), HEAD shares none of its history",
    () => {
      // Only ancestry is read here (git merge-base), never a file of upstream's.
      const head = git(REPO_ROOT, NOREPLY, 'rev-parse', 'HEAD')
      expect(upstreamFindings(REPO_ROOT, upstreamBases(CONFIG), [head])).toEqual([])
    },
    GIT_TEST_TIMEOUT,
  )

  test.skipIf(!hasCommit(CONFIG.base))(
    'every commit since the import commit passes the history audit',
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

  test.skipIf(!hasCommit(CONFIG.base))(
    'every allowlist entry clears something in the tree or in a commit since the import commit',
    () => {
      const r = spawnSync(process.execPath, [SCRIPT, '--json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: GIT_TEST_TIMEOUT,
        maxBuffer: 64 * 1024 * 1024,
      })
      expect([0, 1]).toContain(r.status ?? 2)
      const doc = JSON.parse(r.stdout) as { scope: string[]; staleAllow: unknown[] }
      expect(doc.scope).toHaveLength(2)
      expect(doc.staleAllow).toEqual([])
    },
    GIT_TEST_TIMEOUT,
  )
})
