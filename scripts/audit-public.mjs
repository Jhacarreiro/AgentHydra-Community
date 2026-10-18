#!/usr/bin/env node
// scripts/audit-public.mjs - audit:public, the gate between this repository and the public.
//
// AgentHydra Community is a public repository built from 3a65ba8e, the last commit upstream published
// under MIT. Whatever is pushed to it is published, history included, so this checks for what nobody
// should publish by accident: a token or a private key, a credential file, an address on a private
// network, an email address, a path that names someone's account, upstream's own service hosts and
// private repositories, a machine name from a home or office network, and a binary nobody can say
// where it came from. It reads git objects, never the working tree, so it judges exactly what a push
// or a clone carries.
//
// MODES (any combination; with none, `--tree HEAD --history <base>..HEAD`)
//   --tree REV        Every file tracked at REV: the text of every file git grep -I calls text, every
//                     path, and every binary blob against scripts/binary-provenance.json.
//   --history A..B    Every commit in the range: author, committer and trailer emails must be noreply
//                     addresses; the message and the lines each commit ADDS (git log -p -U0) go
//                     through the content rules, so a secret added in one commit and removed in the
//                     next is still caught; each binary a commit adds or changes needs provenance.
//                     A message may name upstream's hosts, private repositories and denylisted
//                     folders (it says what a commit takes out, and each name is in the base
//                     already); the other rules read it as they read a file.
//   --push REMOTE     What .githooks/check-public-push.mjs calls. stdin carries git's pre-push lines
//                     ("<local ref> <local sha> <remote ref> <remote sha>"), and the commits read are
//                     the ones the push carries: reachable from a pushed sha, not from the base, not
//                     from what the remote already has. Then as --history.
//
// NOTHING IT FINDS IS PRINTED. A finding names its rule, its file and line, and a fingerprint: the
// first 16 hex digits of the sha256 of what matched. A secret printed by its own detector is a secret
// published in a CI log, and an email or a home path in that log is the leak the rule exists to stop.
// The only text shown is a token's kind, or the denylist entry that matched (which is in the config
// file already).
//
// FINE ON PURPOSE. scripts/audit-public.allow.json holds the findings someone has looked at and found
// harmless: {rule, path, fp, reason}, matched on all three, so an entry clears that one value in that
// one file and nothing else. It never holds the value itself. commit.email and license.boundary cannot
// be allowed at all: a published address cannot be unpublished, and the licence line is not a matter
// of opinion. An entry that clears nothing is stale, and a stale entry would quietly clear its value
// again if it ever came back. A run that reads the tree at a commit and every commit from the base up
// to that same commit (the default run, and CI's) has seen everything an entry can match, so there a
// stale entry fails the run with exit 1 and a message of its own. A --tree or a --history run alone
// reads half of that, and only counts the entries it did not use.
//
// THE RUNNER'S OWN NAME. git user.name and the OS account name are read at run time and looked for as
// well (rule pii.local-name), so nobody has to write their own name into the repository to keep it
// out. A name of two words or more is looked for anywhere; a single word only as a path segment, where
// an account name sits. Common account names (root, runner and the placeholders) are not names.
//
// KNOWN LIMITS. Matching is by shape. A password typed as prose, a key format nobody has published,
// or a secret split across string pieces is not found. infra.internal-host only looks inside strings
// and comments of source files (elsewhere `.local` is a property), so a host name in the middle of a
// multi-line string is missed. Exit codes: 0 clean, 1 a finding, 2 the audit itself could not run.
//
// Self-contained: node or bun, no dependencies. The token formats are server/src/secrets.ts's PATTERNS
// (bun runs .ts natively; node strips its types from 22.18 on) plus the formats below. A runtime that
// cannot load that file gets exit 2, not a crash: without the formats nothing is known to be clean.

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Loaded here rather than by a static import, which would fail before main() could say why, with
// exit 1, and a hook reads exit 1 as "found something".
const serverSecrets = await import('../server/src/secrets.ts').then(
  (m) => (Array.isArray(m.PATTERNS) ? { patterns: m.PATTERNS } : { problem: 'it has no PATTERNS' }),
  (err) => ({ problem: err instanceof Error ? err.message : String(err) }),
)

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
export const CONFIG_FILE = 'scripts/audit-public.config.json'
export const ALLOW_FILE = 'scripts/audit-public.allow.json'
export const PROVENANCE_FILE = 'scripts/binary-provenance.json'
/** The path a finding in a commit message is filed under (allow entries use it too). */
export const MESSAGE_PATH = '(commit message)'
const COMMIT_PATH = '(commit)'
/**
 * Upstream's relicensing commit, the one that moved AgentHydra from MIT to PolyForm Noncommercial 1.0.0.
 * It is built in, as in .githooks/check-public-push.mjs, so no config edit can turn license.boundary
 * off: the config's licenseBoundary may name a further commit, never take this one away.
 */
export const LICENSE_BOUNDARY = 'aee9dfc4f7dd0228d8e1740be90b646b30204f37'
const COMMIT_ID = /^[0-9a-f]{40}$/
const MAX_BUFFER = 1 << 30

export const RULES = {
  'secret.token': 'a token, an API key or a private key',
  'secret.file': 'a credential or app-state file',
  'net.private-ipv4': 'an address on a private network (10/8, 172.16/12, 192.168/16, 169.254/16)',
  'net.tailscale': 'a Tailscale address (in 100.64/10, the shared address space) or a *.ts.net name',
  'pii.email': 'an email address that is not a noreply or documentation address',
  'pii.path': 'a home folder with a real account name in it, or a folder on the path denylist',
  'pii.local-name': 'the name of whoever runs this audit (git user.name or the OS account)',
  'infra.host': "one of upstream's own service hosts, outside the historical files",
  'infra.internal-host': 'a machine name from a private network (.local, .lan, .internal, ...)',
  'infra.account-id': 'a 32-hex account or zone id',
  'infra.private-repo': "the name of one of upstream's private repositories",
  'binary.provenance': 'a binary with no entry in scripts/binary-provenance.json, or a changed one',
  'commit.email': 'a commit author, committer or trailer email that is not a noreply address',
  'license.boundary': 'history that contains the commit that took upstream off MIT',
}
const NOT_ALLOWABLE = new Set(['commit.email', 'license.boundary'])

// The formats a repository scan needs on top of server/src/secrets.ts's. The PEM pattern is wider
// than the server's (ENCRYPTED, DSA, PGP blocks); where both match, the finding is reported once.
const EXTRA_TOKEN_PATTERNS = [
  { kind: 'private-key', source: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: 'aws-access-key-id', source: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', source: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { kind: 'gitlab-token', source: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'slack-token', source: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  {
    kind: 'slack-webhook',
    source: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
  },
  { kind: 'discord-webhook', source: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/g },
  { kind: 'google-api-key', source: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'npm-token', source: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'stripe-key', source: /\b[rs]k_live_[0-9A-Za-z]{16,}/g },
  { kind: 'huggingface-token', source: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { kind: 'jwt', source: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
]

// Paths whose very presence is the problem. A .env template is the one kind of .env meant to ship.
const SECRET_FILES = [
  [/(?:^|\/)\.credentials\.json$/i, 'a CLI login'],
  [/(?:^|\/)auth\.json$/i, 'a saved login'],
  [/(?:^|\/)session\.dpapi$/i, 'a sealed session'],
  [/(?:^|\/)(?:\.netrc|_netrc|\.git-credentials|\.pypirc)$/i, 'saved credentials'],
  [/(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:_[\w-]+)?$/i, 'an SSH private key'],
  [/\.(?:pem|key|p12|pfx|ppk|jks|keystore|kdbx)$/i, 'a key or certificate store'],
  [/(?:^|\/)\.env(?:\.(?!example$|sample$|template$)[^/]+)?$/i, 'an environment file'],
  [/(?:^|\/)(?:Cookies|cookies\.(?:sqlite|txt|json|db))$/i, 'a cookie store'],
  [/(?:^|\/)storage-?state[^/]*\.json$/i, 'a saved browser session'],
]
const DATABASE_FILE = /\.(?:db|sqlite|sqlite3|db-wal|db-shm)$/i
const FIXTURE_DIR = /(?:^|\/)(?:fixtures?|testdata|__fixtures__)\//i
const NPMRC = /(?:^|\/)\.npmrc$/i
const NPMRC_TOKEN = /_(?:authToken|auth|password)\s*=\s*(?!\$\{)\S+/g

// An email "domain" that ends in one of these is a file name (logo@2x.png) or a systemd unit
// (name@instance.service), not a mail domain.
const FILE_EXTENSIONS = new Set(
  'png jpg jpeg gif svg webp ico bmp js mjs cjs ts tsx jsx mts cts json jsonl md css scss less html htm vue py rs go cs java kt rb php sh ps1 psm1 bat cmd toml yml yaml xml txt log lock patch diff map wasm node gz tgz zip exe dll so dylib woff woff2 ttf otf pdf csv sql service socket timer target mount automount slice scope swap'.split(
    ' ',
  ),
)
// Source files, where a dotted name is a property access unless it sits in a string or a comment.
const CODE_FILE =
  /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|cs|java|kt|swift|rb|php|ps1|psm1|sh|bash|zsh|lua|c|h|cc|cpp|hpp)$/i
const C_FAMILY = /\.(?:[cm]?[jt]sx?|vue|svelte|go|rs|cs|java|kt|swift|c|h|cc|cpp|hpp)$/i
// Account names that are machines' and tools', not people's.
const SYSTEM_ACCOUNTS = new Set(
  'root unknown admin administrator runner runneradmin ubuntu vscode codespace codespaces node docker git github jenkins nobody daemon system guest build builder user default public ci dev test owner'.split(
    ' ',
  ),
)

// --- small helpers -----------------------------------------------------------------------------

/** The first 16 hex digits of the sha256 of `value`: how a finding is named without being shown. */
export function fingerprint(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** `*` matches any run of characters; nothing else is special. Case-insensitive. */
function globRe(glob) {
  return new RegExp(`^${glob.split('*').map(escapeRe).join('.*')}$`, 'i')
}

function stripAccents(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '')
}

// Each base letter of a name, widened to its accented forms, so "Zoe" also finds "Zoë".
const ACCENTED = {
  a: 'aàáâãäåā',
  c: 'cçć',
  e: 'eèéêëē',
  i: 'iìíîïī',
  n: 'nñ',
  o: 'oòóôõöøō',
  u: 'uùúûüū',
  y: 'yýÿ',
}
function accentTolerant(word) {
  let out = ''
  for (const ch of stripAccents(word).toLowerCase()) {
    out += ACCENTED[ch] ? `[${ACCENTED[ch]}]` : escapeRe(ch)
  }
  return out
}

function git(cwd, args, { input, allowFail = false, encoding = 'utf8' } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    input,
    encoding: encoding === 'buffer' ? undefined : encoding,
    maxBuffer: MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (r.error) throw new AuditError(`git ${args[0]} could not run: ${r.error.message}`)
  if (r.status !== 0 && !allowFail) {
    const err = String(r.stderr || '').trim().split('\n')[0]
    throw new AuditError(`git ${args.join(' ')} failed (exit ${r.status}): ${err}`)
  }
  return r
}

function gitText(cwd, args, opts) {
  return String(git(cwd, args, opts).stdout)
}

/** The audit itself could not run (exit 2), as opposed to a finding (exit 1). */
export class AuditError extends Error {}

/** A path git printed C-quoted ("a\tb", octal escapes for non-ASCII), back to the path itself. */
function unquotePath(s) {
  if (!s.startsWith('"')) return s
  const bytes = []
  const body = s.slice(1, -1)
  const SIMPLE = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, '\\': 92 }
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'))
      continue
    }
    const next = body[i + 1]
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(body.slice(i + 1, i + 4), 8))
      i += 3
    } else {
      bytes.push(SIMPLE[next] ?? next.charCodeAt(0))
      i += 1
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

// --- configuration ----------------------------------------------------------------------------

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new AuditError(`${what} ${file} could not be read: ${err.message}`)
  }
}

/**
 * The three files that steer the audit, checked for shape. They are read from beside this script
 * (the checkout's own copy) unless a path is given: the audit as it stands here judges what it reads.
 */
export function loadAuditFiles({ config, allow, provenance } = {}) {
  const root = resolve(SCRIPTS_DIR, '..')
  const cfg = readJson(config ?? join(root, CONFIG_FILE), 'the audit config')
  const allowDoc = readJson(allow ?? join(root, ALLOW_FILE), 'the allowlist')
  const provDoc = readJson(provenance ?? join(root, PROVENANCE_FILE), 'the binary provenance list')
  for (const key of ['base', 'placeholderUsers', 'allowedEmails', 'allowedEmailDomains']) {
    if (cfg[key] === undefined) throw new AuditError(`the audit config has no "${key}"`)
  }
  if (cfg.licenseBoundary !== undefined && !COMMIT_ID.test(String(cfg.licenseBoundary).toLowerCase())) {
    throw new AuditError('the audit config\'s "licenseBoundary" is not a full 40-hex commit id')
  }
  const entries = allowDoc.entries ?? []
  for (const [i, e] of entries.entries()) {
    const where = `allowlist entry ${i + 1}`
    if (!RULES[e.rule]) throw new AuditError(`${where} names no known rule (${e.rule})`)
    if (NOT_ALLOWABLE.has(e.rule)) throw new AuditError(`${where}: ${e.rule} cannot be allowed`)
    if (typeof e.path !== 'string' || !e.path) throw new AuditError(`${where} has no path`)
    if (!/^[0-9a-f]{16}$/.test(e.fp ?? '')) throw new AuditError(`${where} has no 16-hex fp`)
    if (typeof e.reason !== 'string' || e.reason.trim().length < 10) {
      throw new AuditError(`${where} has no reason (say why it is fine, in a sentence)`)
    }
  }
  const binaries = provDoc.binaries ?? []
  for (const [i, b] of binaries.entries()) {
    for (const key of ['path', 'blob', 'sha256', 'source', 'build', 'license']) {
      if (typeof b[key] !== 'string' || !b[key].trim()) {
        throw new AuditError(`binary-provenance entry ${i + 1} has no "${key}"`)
      }
    }
  }
  return { config: cfg, allow: entries, provenance: binaries }
}

/** git user.name and the OS account: the names pii.local-name looks for, minus account names. */
export function runnerNames(cwd) {
  const names = []
  const r = spawnSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8' })
  if (r.status === 0 && r.stdout.trim()) names.push(r.stdout.trim())
  try {
    names.push(userInfo().username)
  } catch {
    if (process.env.USERNAME || process.env.USER) names.push(process.env.USERNAME || process.env.USER)
  }
  return names
}

// --- rules ------------------------------------------------------------------------------------

/**
 * Every content rule, compiled for one run. A rule is a global regex and a check that turns a match
 * into { value } (what is fingerprinted), or null when the match is fine. `rule` and `note` in the
 * result override the rule id and add the one piece of text that may be shown.
 */
export function compileRules(config, { localNames = [] } = {}) {
  const lower = (s) => s.toLowerCase()
  const placeholders = new Set((config.placeholderUsers ?? []).map(lower))
  const emailGlobs = (config.allowedEmails ?? []).map(globRe)
  const emailDomains = (config.allowedEmailDomains ?? []).map(lower)
  const historical = new Set(config.historicalPaths ?? [])
  const selfExempt = new Set([CONFIG_FILE])
  // A commit message that names one of upstream's hosts, private repositories or denylisted folders
  // says what the commit takes out. Each of those names is in the base commit already, so the message
  // publishes nothing new. Every other rule reads a message as it reads a file.
  const describes = (path) => path === MESSAGE_PATH
  const publicInternal = (config.publicInternalHosts ?? []).map(globRe)
  const hostPrefixes = (config.internalHostPrefixes ?? []).map(lower)
  const rules = []

  if (!serverSecrets.patterns) {
    throw new AuditError(
      `server/src/secrets.ts could not be loaded (${serverSecrets.problem}), so the token formats are ` +
        'unknown. Run the audit with bun, or with node 22.18 or later.',
    )
  }
  for (const p of [...serverSecrets.patterns, ...EXTRA_TOKEN_PATTERNS]) {
    const pem = p.kind === 'private-key'
    rules.push({
      id: 'secret.token',
      re: new RegExp(p.source.source, 'g'),
      check: (m, text) => (pem ? pemFinding(m, text) : { value: m[0], note: p.kind }),
    })
  }

  rules.push({
    id: 'secret.file',
    re: NPMRC_TOKEN,
    when: (path) => NPMRC.test(path),
    check: (m) => ({ value: m[0], note: 'an .npmrc with a saved token' }),
  })

  rules.push({
    id: 'net.private-ipv4',
    re: /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\w|\.\d)/g,
    check: (m) => {
      const o = m.slice(1, 5).map(Number)
      if (o.some((n) => n > 255)) return null
      const [a, b] = o
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
        return { value: m[0] }
      }
      if (a === 169 && b === 254) return { value: m[0] }
      if (a === 100 && b >= 64 && b <= 127) return { value: m[0], rule: 'net.tailscale' }
      return null
    },
  })
  rules.push({
    id: 'net.tailscale',
    re: /(?<![\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net(?![\w-])/gi,
    check: (m) => (isPlaceholderHost(m[0], hostPrefixes) ? null : { value: lower(m[0]) }),
  })

  rules.push({
    id: 'pii.email',
    re: /(?<![\w.%+-])[A-Za-z0-9][A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g,
    check: (m, text) => {
      const before = text.slice(Math.max(0, m.index - 7), m.index)
      // user@host after "//" or "user:" is a URL's or an ssh target's user part, not a mailbox.
      if (before.endsWith('//') || (before.endsWith(':') && !/mailto:$/i.test(before))) return null
      const labels = lower(m[1]).split('.')
      const tld = labels[labels.length - 1]
      if (!/^[a-z]{2,}$/.test(tld) || FILE_EXTENSIONS.has(tld)) return null
      if (!/[a-z]/.test(labels[labels.length - 2])) return null // pkg@1.4.2.patch
      const addr = lower(m[0])
      const domain = labels.join('.')
      if (emailGlobs.some((g) => g.test(addr))) return null
      if (emailDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) return null
      return { value: addr }
    },
  })

  const homeUser = (user) => {
    const u = user.replace(/\.+$/, '')
    if (!u || /^[%$*…]/.test(u) || /^\.+$/.test(u) || u === '...') return null
    return placeholders.has(lower(u)) ? null : u
  }
  rules.push({
    id: 'pii.path',
    re: /(?<![A-Za-z0-9])([A-Za-z]):(?:\\{1,4}|\/)Users(?:\\{1,4}|\/)([^\\/\s"'`<>:*?|,;()[\]{}]+)/gi,
    check: (m) => {
      const u = homeUser(m[2])
      return u ? { value: `${lower(m[1])}:/users/${lower(u)}` } : null
    },
  })
  rules.push({
    id: 'pii.path',
    re: /(?<![\w.~$:-])\/(Users|home)\/([^\\/\s"'`<>:*?|,;()[\]{}]+)/g,
    check: (m) => {
      const u = homeUser(m[2])
      return u ? { value: `/${lower(m[1])}/${lower(u)}` } : null
    },
  })
  for (const entry of config.pathDenylist ?? []) {
    const segments = entry.split(/[\\/]+/).filter(Boolean).map(escapeRe)
    rules.push({
      id: 'pii.path',
      re: new RegExp(`(?<![\\w])${segments.join('(?:\\\\{1,4}|/)')}(?![\\w-])`, 'gi'),
      when: (path) => !selfExempt.has(path) && !describes(path),
      check: () => ({ value: lower(entry.replace(/[\\/]+/g, '/')) }),
    })
  }

  for (const rule of localNameRules(localNames, placeholders)) rules.push(rule)

  for (const host of config.upstreamHosts ?? []) {
    rules.push({
      id: 'infra.host',
      re: new RegExp(`(?<![\\w-])(?:[a-z0-9-]+\\.)*${escapeRe(host)}(?![\\w-])`, 'gi'),
      when: (path) => !historical.has(path) && !selfExempt.has(path) && !describes(path),
      check: (m) => ({ value: lower(m[0]), note: host }),
    })
  }
  for (const name of config.privateRepos ?? []) {
    rules.push({
      id: 'infra.private-repo',
      re: new RegExp(`(?<![\\w-])(?:${name})(?![\\w-])`, 'gi'),
      when: (path) => !selfExempt.has(path) && !describes(path),
      check: (m) => ({ value: lower(m[0]), note: name }),
    })
  }

  rules.push({
    id: 'infra.internal-host',
    re: /(?<![\w.@-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:local|lan|internal|corp|home\.arpa)(?![\w-]|\.[a-z0-9])/gi,
    check: (m, text, path) => {
      const host = lower(m[0])
      if (isPlaceholderHost(host, hostPrefixes)) return null
      if (publicInternal.some((g) => g.test(host))) return null
      if (CODE_FILE.test(path) && !inStringOrComment(text, m.index, path)) return null
      return { value: host }
    },
  })
  rules.push({
    id: 'infra.internal-host',
    re: /\b(?:DESKTOP|LAPTOP)-[A-Z0-9]{7}\b/g,
    check: (m) => (/EXAMPLE|TEST/.test(m[0]) ? null : { value: lower(m[0]) }),
  })
  rules.push({
    id: 'infra.account-id',
    re: /\b[0-9a-f]{32}\b/g,
    check: (m, text) => {
      if (/^(.{1,16})\1+$/.test(m[0])) return null // 0123456789abcdef twice: a placeholder
      const lineStart = text.lastIndexOf('\n', m.index) + 1
      const before = text.slice(Math.max(lineStart, m.index - 40), m.index)
      return /account|zone/i.test(before) ? { value: m[0] } : null
    },
  })
  return rules
}

function isPlaceholderHost(host, prefixes) {
  const labels = host.toLowerCase().split('.')
  if (labels.some((l) => l === 'example' || l === 'test' || l === 'invalid')) return true
  return prefixes.some((p) => labels[0].startsWith(p))
}

function localNameRules(names, placeholders) {
  const rules = []
  const seen = new Set()
  for (const raw of names) {
    const name = String(raw || '').trim()
    const key = stripAccents(name).toLowerCase()
    if (key.length < 3 || seen.has(key)) continue
    seen.add(key)
    if (SYSTEM_ACCOUNTS.has(key) || placeholders.has(key)) continue
    const words = name.split(/\s+/).filter(Boolean)
    const value = key.replace(/\s+/g, ' ')
    if (words.length >= 2) {
      // A full name, anywhere, however it is joined: "Jane Doe", "jane.doe", "janedoe".
      const body = words.map(accentTolerant).join('[\\s._-]?')
      rules.push({
        id: 'pii.local-name',
        re: new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'giu'),
        check: () => ({ value }),
      })
    } else {
      // One word could be anything in prose; as a path segment it is an account.
      rules.push({
        id: 'pii.local-name',
        re: new RegExp(`(?<=[\\\\/])${accentTolerant(name)}(?=$|[\\\\/"'\`\\s:,;)\\]}])`, 'gimu'),
        check: () => ({ value }),
      })
    }
  }
  return rules
}

/**
 * A PEM header and, when its END line follows with a body, the whole block: the block is what gets
 * fingerprinted, so allowing one test key never allows another key in the same file. A header with
 * no body (a string that names the format) is reported as its own kind.
 */
function pemFinding(m, text) {
  const label = m[0].slice('-----BEGIN '.length, -'-----'.length)
  const endMarker = `-----END ${label}-----`
  const end = text.indexOf(endMarker, m.index)
  if (end > 0) {
    const between = text.slice(m.index + m[0].length, end)
    const lines = between.split('\n').length
    const body = between.replace(/\\[nr]/g, '').replace(/[^A-Za-z0-9+/=]/g, '')
    if (lines <= 200 && body.length >= 32) {
      const block = text
        .slice(m.index, end + endMarker.length)
        .replace(/\r/g, '')
        .split('\n')
        .map((l) => l.trim())
        .join('\n')
      return { value: block, note: 'private-key' }
    }
  }
  return { value: m[0], note: 'private-key-header' }
}

/**
 * Is `index` inside a string literal or a comment on its line? A line-local guess, on purpose. In a
 * Vue template, a bound attribute's value (:is="...", v-if="...", @click="...") is code, not text.
 */
function inStringOrComment(text, index, path = '') {
  const start = text.lastIndexOf('\n', index - 1) + 1
  const line = text.slice(start, index)
  // `#` opens a comment in Python, shell and PowerShell; in JS it is a private name.
  const hash = !C_FAMILY.test(path)
  if (/^\s*(?:\*|<!--|--|;)/.test(line) || (hash && /^\s*#/.test(line))) return true
  const vue = path.endsWith('.vue')
  let quote = ''
  let attr = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
      continue
    }
    if (attr && c === attr) attr = ''
    else if (c === '"' || c === "'" || c === '`') {
      const bound = /(?:^|\s)(?::[\w.-]+|v-[\w:.-]+|@[\w.:-]+|#[\w-]+)=$/
      if (vue && !attr && bound.test(line.slice(0, i))) attr = c
      else quote = c
    } else if (c === '/' && (line[i + 1] === '/' || line[i + 1] === '*')) return true
    else if (hash && c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return true
    else if (line.startsWith('<!--', i)) return true
  }
  return quote !== ''
}

// --- scanning ---------------------------------------------------------------------------------

function lineStarts(text) {
  const starts = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

function lineAt(starts, index) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= index) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Every content finding in `text`, filed under `path`. `lineNumbers` maps a 0-based line of `text`
 * to the line number reported (history passes the added lines' real numbers); by default line i is
 * reported as i + 1.
 */
export function scanText(text, path, rules, { lineNumbers } = {}) {
  const out = []
  const seen = new Set()
  let starts = null
  for (const rule of rules) {
    if (rule.when && !rule.when(path)) continue
    rule.re.lastIndex = 0
    for (const m of text.matchAll(rule.re)) {
      const hit = rule.check(m, text, path)
      if (!hit) continue
      starts ??= lineStarts(text)
      const li = lineAt(starts, m.index)
      const id = hit.rule ?? rule.id
      const key = `${id}\0${m.index}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        rule: id,
        path,
        line: lineNumbers ? lineNumbers[li] : li + 1,
        col: m.index - starts[li] + 1,
        fp: fingerprint(hit.value),
        note: hit.note,
      })
    }
  }
  return out.sort((a, b) => a.line - b.line || a.col - b.col)
}

/** The path rules: a file whose name alone says it holds a credential or app state. */
export function scanPath(path) {
  for (const [re, what] of SECRET_FILES) {
    if (re.test(path)) return [{ rule: 'secret.file', path, line: 0, fp: fingerprint(path), note: what }]
  }
  if (DATABASE_FILE.test(path) && !FIXTURE_DIR.test(path)) {
    return [{ rule: 'secret.file', path, line: 0, fp: fingerprint(path), note: 'a database' }]
  }
  return []
}

/**
 * Provenance for one binary blob: null when its entry matches, else the finding. The tree needs an
 * entry for every path; history also accepts the same bytes recorded under another path (a move).
 */
function binaryFinding(path, blob, sha256, provenance, { anyPath = false, ...extra } = {}) {
  const fp = sha256.slice(0, 16)
  const byPath = provenance.find((b) => b.path === path)
  const base = { rule: 'binary.provenance', path, line: 0, fp, ...extra }
  if (!byPath) {
    if (anyPath && provenance.some((b) => b.blob === blob && b.sha256 === sha256)) return null
    return { ...base, note: 'no provenance entry' }
  }
  if (byPath.blob !== blob || byPath.sha256 !== sha256) {
    return { ...base, note: 'changed since its provenance entry' }
  }
  return null
}

/** Read blobs by id in one `git cat-file --batch`, as Buffers keyed by id. */
function readBlobs(cwd, ids) {
  const out = new Map()
  if (ids.length === 0) return out
  const buf = git(cwd, ['cat-file', '--batch'], { input: `${ids.join('\n')}\n`, encoding: 'buffer' })
    .stdout
  let off = 0
  while (off < buf.length) {
    const nl = buf.indexOf(10, off)
    const [id, type, size] = buf.toString('latin1', off, nl).split(' ')
    if (type === 'missing') {
      off = nl + 1
      continue
    }
    const n = Number(size)
    out.set(id, buf.subarray(nl + 1, nl + 1 + n))
    off = nl + 1 + n + 1
  }
  return out
}

function emptyTree(cwd) {
  return gitText(cwd, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).trim()
}

function resolveCommit(cwd, rev) {
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFail: true })
  const sha = String(r.stdout).trim()
  if (r.status !== 0 || !sha) throw new AuditError(`${rev} is not a commit in this repository`)
  return sha
}

/** license.boundary's commits: LICENSE_BOUNDARY, plus the config's licenseBoundary when it names another. */
export function licenseBoundaries(config) {
  const out = [LICENSE_BOUNDARY]
  const extra = String(config?.licenseBoundary ?? '').toLowerCase()
  if (COMMIT_ID.test(extra) && !out.includes(extra)) out.push(extra)
  return out
}

/** A license.boundary finding for each of `commits` that has one of `boundaries` in its history. */
export function licenseFindings(cwd, boundaries, commits) {
  const out = []
  for (const boundary of boundaries) {
    const present = git(cwd, ['cat-file', '-e', `${boundary}^{commit}`], { allowFail: true })
    if (present.status !== 0) continue // not in this clone, so nothing here can contain it
    for (const sha of commits) {
      const r = git(cwd, ['merge-base', '--is-ancestor', boundary, sha], { allowFail: true })
      if (r.status === 0) {
        out.push({
          rule: 'license.boundary',
          path: COMMIT_PATH,
          commit: sha,
          line: 0,
          fp: fingerprint(boundary),
          note: `contains ${boundary.slice(0, 8)}`,
        })
      } else if (r.status !== 1) {
        throw new AuditError(`could not tell whether ${sha.slice(0, 8)} contains ${boundary.slice(0, 8)}`)
      }
    }
  }
  return out
}

/** --tree: every tracked path, every text file's content, every binary. */
export function auditTree(cwd, rev, ctx) {
  const commit = resolveCommit(cwd, rev)
  const entries = gitText(cwd, ['ls-tree', '-r', '-z', '--full-tree', commit])
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      const [mode, type, id] = line.slice(0, tab).split(' ')
      return { mode, type, id, path: line.slice(tab + 1) }
    })
  const findings = []
  for (const e of entries) findings.push(...scanPath(e.path))

  const binaryPaths = new Set(
    gitText(cwd, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--numstat',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      emptyTree(cwd),
      commit,
    ])
      .split('\0')
      .filter((rec) => rec.startsWith('-\t-\t'))
      .map((rec) => rec.slice(4)),
  )
  const blobs = entries.filter((e) => e.type === 'blob')
  const texts = blobs.filter((e) => !binaryPaths.has(e.path))
  const bins = blobs.filter((e) => binaryPaths.has(e.path))
  const content = readBlobs(cwd, [...new Set(blobs.map((e) => e.id))])

  for (const e of texts) {
    const buf = content.get(e.id)
    if (buf?.length) findings.push(...scanText(buf.toString('utf8'), e.path, ctx.rules))
  }
  for (const e of bins) {
    const f = binaryFinding(e.path, e.id, sha256Hex(content.get(e.id) ?? ''), ctx.provenance)
    if (f) findings.push(f)
  }
  const binarySet = new Set(bins.map((e) => e.path))
  for (const b of ctx.provenance) {
    if (!binarySet.has(b.path)) {
      findings.push({
        rule: 'binary.provenance',
        path: b.path,
        line: 0,
        fp: String(b.sha256).slice(0, 16),
        note: 'provenance entry for a binary that is not tracked',
      })
    }
  }
  findings.push(...licenseFindings(cwd, licenseBoundaries(ctx.config), [commit]))
  return { findings, stats: { files: entries.length, binaries: bins.length } }
}

/**
 * The commits of a revision range (git log arguments, e.g. ['A..B'] or [sha, '--not', base]), each
 * with its metadata and the lines it adds, read in two passes: one for messages, one for patches.
 */
function readHistory(cwd, revArgs) {
  const meta = gitText(cwd, [
    'log',
    '-z',
    '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B',
    ...revArgs,
    '--',
  ]).split('\0')
  const commits = new Map()
  const order = []
  for (let i = 0; i + 5 < meta.length; i += 6) {
    const [sha, , authorEmail, , committerEmail, body] = meta.slice(i, i + 6)
    const id = sha.replace(/^\n/, '')
    if (!/^[0-9a-f]{40,64}$/.test(id)) continue
    commits.set(id, { sha: id, authorEmail, committerEmail, body, files: new Map() })
    order.push(id)
  }
  const nonce = randomBytes(12).toString('hex')
  const out = gitText(cwd, [
    '-c',
    'core.quotePath=false',
    '-c',
    'log.showSignature=false',
    'log',
    `--format=format:${nonce} %H`,
    '--raw',
    '--numstat',
    '-p',
    '-U0',
    '--no-abbrev',
    '--no-renames',
    '--no-relative',
    '--diff-merges=first-parent',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    ...revArgs,
    '--',
  ])
  let commit = null
  let file = null
  let newLine = 0
  let inHunk = false
  const fileOf = (path) => {
    let f = commit.files.get(path)
    if (!f) {
      f = { path, lines: [], numbers: [], binary: false, blob: null, status: '' }
      commit.files.set(path, f)
    }
    return f
  }
  for (const line of out.split('\n')) {
    if (line.startsWith(`${nonce} `)) {
      commit = commits.get(line.slice(nonce.length + 1).trim()) ?? null
      file = null
      inHunk = false
      continue
    }
    if (!commit) continue
    if (line.startsWith('diff --git ')) {
      file = null
      inHunk = false
      continue
    }
    if (inHunk && file) {
      if (line.startsWith('+')) {
        file.lines.push(line.slice(1))
        file.numbers.push(newLine++)
        continue
      }
      if (line.startsWith('-') || line.startsWith('\\') || line.startsWith(' ')) continue
    }
    if (line.startsWith('@@ ')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      newLine = m ? Number(m[1]) : 0
      inHunk = Boolean(file)
      continue
    }
    if (line.startsWith('+++ ')) {
      // git ends this header with a TAB when the path holds a space, so that patch can tell where
      // the name stops. The TAB is not part of the path: a path with a TAB of its own is C-quoted.
      const target = line.slice(4).replace(/\t$/, '')
      file = target === '/dev/null' ? null : fileOf(unquotePath(target).replace(/^b\//, ''))
      continue
    }
    if (line.startsWith(':')) {
      const tab = line.indexOf('\t')
      const [, , , blob, status] = line.slice(1, tab).split(' ')
      const f = fileOf(unquotePath(line.slice(tab + 1)))
      f.blob = blob
      f.status = status
      continue
    }
    const num = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(line)
    if (num && !inHunk) {
      if (num[1] === '-') fileOf(unquotePath(num[3])).binary = true
    }
  }
  return order.map((sha) => commits.get(sha))
}

function commitEmailFindings(c, globs) {
  const out = []
  const check = (email, note) => {
    const e = String(email || '').toLowerCase()
    if (globs.some((g) => g.test(e))) return
    out.push({ rule: 'commit.email', path: COMMIT_PATH, commit: c.sha, line: 0, fp: fingerprint(e), note })
  }
  check(c.authorEmail, 'author')
  check(c.committerEmail, 'committer')
  for (const line of c.body.split('\n')) {
    const m = /^([A-Za-z][\w-]*):[ \t]+.*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(line)
    if (m) check(m[2], `trailer ${m[1]}`)
  }
  return out
}

/** --history and --push: metadata, messages, added lines and binaries of every commit in range. */
export function auditHistory(cwd, revArgs, ctx) {
  const commitGlobs = (ctx.config.commitEmails ?? ctx.config.allowedEmails).map(globRe)
  const commits = readHistory(cwd, revArgs)
  const findings = []
  const binaries = []
  for (const c of commits) {
    findings.push(...commitEmailFindings(c, commitGlobs))
    for (const f of scanText(c.body, MESSAGE_PATH, ctx.rules)) findings.push({ ...f, commit: c.sha })
    for (const file of c.files.values()) {
      if (file.status === 'D') continue
      for (const f of scanPath(file.path)) findings.push({ ...f, commit: c.sha })
      if (file.binary) {
        if (file.blob && !/^0+$/.test(file.blob)) binaries.push({ commit: c.sha, file })
        continue
      }
      if (file.lines.length === 0) continue
      const text = file.lines.join('\n')
      for (const f of scanText(text, file.path, ctx.rules, { lineNumbers: file.numbers })) {
        // A PEM header among the added lines is judged on the whole file as the commit left it:
        // the body may sit on lines this commit did not touch.
        if (f.note === 'private-key' || f.note === 'private-key-header') {
          findings.push({ ...pemFromBlob(cwd, c.sha, file.path, f), commit: c.sha })
        } else {
          findings.push({ ...f, commit: c.sha })
        }
      }
    }
  }
  const content = readBlobs(cwd, [...new Set(binaries.map((b) => b.file.blob))])
  for (const { commit, file } of binaries) {
    const sha = sha256Hex(content.get(file.blob) ?? '')
    const f = binaryFinding(file.path, file.blob, sha, ctx.provenance, { anyPath: true, commit })
    if (f) findings.push(f)
  }
  return { findings, commits }
}

function pemFromBlob(cwd, sha, path, finding) {
  const r = git(cwd, ['show', `${sha}:${path}`], { allowFail: true })
  if (r.status !== 0) return finding
  const text = String(r.stdout)
  const starts = lineStarts(text)
  const from = starts[finding.line - 1] ?? 0
  const re = new RegExp(EXTRA_TOKEN_PATTERNS[0].source.source, 'g')
  re.lastIndex = from
  const m = re.exec(text)
  if (!m) return finding
  const hit = pemFinding(m, text)
  return { ...finding, fp: fingerprint(hit.value), note: hit.note }
}

/** --push: the revision arguments for what a pre-push hook's ref lines carry. */
export function pushRevArgs(cwd, refLines, remoteName, base) {
  const include = []
  const exclude = [base]
  for (const line of refLines.split('\n')) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/)
    if (!localSha || /^0+$/.test(localSha)) continue
    const commit = String(
      git(cwd, ['rev-parse', '--verify', '--quiet', `${localSha}^{commit}`], { allowFail: true })
        .stdout,
    ).trim()
    if (commit) include.push(commit)
    if (remoteSha && !/^0+$/.test(remoteSha)) {
      const there = git(cwd, ['cat-file', '-e', `${remoteSha}^{commit}`], { allowFail: true })
      if (there.status === 0) exclude.push(remoteSha)
    }
  }
  if (include.length === 0) return null
  const remotes = /^[\w.-]+$/.test(remoteName || '') ? [`--remotes=${remoteName}`] : []
  return { include, args: [...include, '--not', ...exclude, ...remotes] }
}

// --- running and reporting --------------------------------------------------------------------

/** Mark each finding an allow entry clears; return the entries nothing matched. */
export function applyAllow(findings, allow) {
  const byKey = new Map(allow.map((e) => [`${e.rule}\0${e.path}\0${e.fp}`, e]))
  const used = new Set()
  for (const f of findings) {
    if (NOT_ALLOWABLE.has(f.rule)) continue
    const key = `${f.rule}\0${f.path}\0${f.fp}`
    if (byKey.has(key)) {
      f.allowed = byKey.get(key).reason
      used.add(key)
    }
  }
  return allow.filter((e) => !used.has(`${e.rule}\0${e.path}\0${e.fp}`))
}

/**
 * Whether a run read everything an allow entry can match: the tree at some commit, and a --history
 * range from the base to that same commit. Only then is an entry that cleared nothing stale; a
 * --tree run alone does not read the commits, and a --history run alone does not read the tree.
 */
export function readsEverything(cwd, { tree, history }, base) {
  if (!tree.length || !history.length) return false
  const trees = new Set(tree.map((rev) => resolveCommit(cwd, rev)))
  const from = resolveCommit(cwd, base)
  return history.some((range) => {
    if (range.includes('...') || !range.includes('..')) return false
    const [start, tip] = range.split('..')
    return resolveCommit(cwd, start || 'HEAD') === from && trees.has(resolveCommit(cwd, tip || 'HEAD'))
  })
}

/** GitHub's workflow-command escaping: the message, and a property value (which also escapes , :). */
function ghData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}
function ghProp(s) {
  return ghData(s).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

function describe(f) {
  const where = f.line ? `${f.path}:${f.line}` : f.path
  const commit = f.commit ? `${f.commit.slice(0, 8)} ` : ''
  return `${f.rule.padEnd(20)} ${commit}${where}  fp ${f.fp}${f.note ? `  (${f.note})` : ''}`
}

function parseArgs(argv) {
  const opts = { tree: [], history: [], push: null, json: false, suggest: false, cwd: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new AuditError(`${a} needs a value`)
      return v
    }
    if (a === '--tree') opts.tree.push(value())
    else if (a === '--history') opts.history.push(value())
    else if (a === '--push') opts.push = value()
    else if (a === '--json') opts.json = true
    else if (a === '--suggest-allow') opts.suggest = true
    else if (a === '-C' || a === '--cwd') opts.cwd = resolve(value())
    else if (a === '--config') opts.config = resolve(value())
    else if (a === '--allow') opts.allow = resolve(value())
    else if (a === '--provenance') opts.provenance = resolve(value())
    else if (a === '--no-local-names') opts.noLocalNames = true
    else throw new AuditError(`unknown argument ${a}`)
  }
  return opts
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** The whole command line run. Returns the exit code; prints the report. */
export function main(argv = process.argv.slice(2), { stdin } = {}) {
  const started = Date.now()
  let opts
  try {
    opts = parseArgs(argv)
    const files = loadAuditFiles(opts)
    const ctx = {
      config: files.config,
      provenance: files.provenance,
      rules: compileRules(files.config, {
        localNames: opts.noLocalNames ? [] : runnerNames(opts.cwd),
      }),
    }
    if (!opts.tree.length && !opts.history.length && !opts.push) {
      opts.tree.push('HEAD')
      opts.history.push(`${files.config.base}..HEAD`)
    }
    const findings = []
    const scope = []
    for (const rev of opts.tree) {
      const r = auditTree(opts.cwd, rev, ctx)
      findings.push(...r.findings)
      scope.push(`tree ${rev} (${r.stats.files} files, ${r.stats.binaries} binaries)`)
    }
    for (const range of opts.history) {
      const r = auditHistory(opts.cwd, [range], ctx)
      const tip = range.includes('..') ? range.split(/\.\.\.?/)[1] || 'HEAD' : range
      const tipCommit = resolveCommit(opts.cwd, tip)
      findings.push(...licenseFindings(opts.cwd, licenseBoundaries(files.config), [tipCommit]))
      findings.push(...r.findings)
      scope.push(`history ${range} (${r.commits.length} commits)`)
    }
    if (opts.push) {
      resolveCommit(opts.cwd, files.config.base)
      const push = pushRevArgs(opts.cwd, stdin ?? readStdin(), opts.push, files.config.base)
      if (push) {
        const r = auditHistory(opts.cwd, push.args, ctx)
        findings.push(...licenseFindings(opts.cwd, licenseBoundaries(files.config), push.include))
        findings.push(...r.findings)
        scope.push(`push to ${opts.push} (${r.commits.length} new commits)`)
      } else {
        scope.push(`push to ${opts.push} (nothing to read)`)
      }
    }
    const unused = applyAllow(findings, files.allow)
    const stale = readsEverything(opts.cwd, opts, files.config.base) ? unused : []
    return report(findings, unused, stale, scope, opts, Date.now() - started)
  } catch (err) {
    if (err instanceof AuditError) {
      console.error(`audit:public could not run: ${err.message}`)
      return 2
    }
    throw err
  }
}

function describeEntry(e) {
  return `${e.rule.padEnd(20)} ${e.path}  fp ${e.fp}`
}

/** `stale` is `unused` when the run read everything (readsEverything), else empty. */
function report(findings, unused, stale, scope, opts, ms) {
  const open = findings.filter((f) => !f.allowed)
  const allowedCount = findings.length - open.length
  const failed = open.length > 0 || stale.length > 0
  if (opts.json) {
    const doc = { ok: !failed, scope, findings, unusedAllow: unused, staleAllow: stale }
    console.log(JSON.stringify(doc, null, 2))
    return failed ? 1 : 0
  }
  if (opts.suggest) {
    const seen = new Set()
    const entries = []
    for (const f of open) {
      const key = `${f.rule}\0${f.path}\0${f.fp}`
      if (NOT_ALLOWABLE.has(f.rule) || seen.has(key)) continue
      seen.add(key)
      entries.push({ rule: f.rule, path: f.path, fp: f.fp, reason: '' })
    }
    console.log(JSON.stringify(entries, null, 2))
    return open.length ? 1 : 0
  }
  const out = [`audit:public: ${scope.join('; ')}`]
  const annotations = []
  for (const f of open) {
    out.push(`  ✗ ${describe(f)}`)
    const loc = `file=${ghProp(f.path)}${f.line ? `,line=${f.line}` : ''}`
    const msg = `${RULES[f.rule]}; fp ${f.fp}${f.note ? ` (${f.note})` : ''}`
    annotations.push(`::error ${loc},title=${ghProp(f.rule)}::${ghData(msg)}`)
  }
  for (const e of stale) {
    out.push(`  ✗ stale allowlist entry: ${describeEntry(e)}`)
    const msg = `stale entry: ${e.rule} in ${e.path} (fp ${e.fp}) clears nothing; take it out`
    annotations.push(`::error file=${ghProp(ALLOW_FILE)},title=allowlist.stale::${ghData(msg)}`)
  }
  // In GitHub Actions each finding is also an annotation on the file and line it names.
  if (process.env.GITHUB_ACTIONS === 'true' && annotations.length) console.log(annotations.join('\n'))
  const secs = (ms / 1000).toFixed(1)
  if (open.length) {
    const rules = [...new Set(open.map((f) => f.rule))]
    out.push(
      '',
      `✗ ${open.length} finding(s), ${allowedCount} allowed by ${ALLOW_FILE}, in ${secs} s.`,
      ...rules.map((r) => `    ${r}: ${RULES[r]}`),
      '  Fix them, or, for one that is really fine, add {rule, path, fp, reason} to the allowlist',
      '  (--suggest-allow prints the entries without their reasons). Never paste the value itself.',
    )
  } else if (!stale.length) {
    out.push(`✓ clean: ${allowedCount} finding(s) allowed by ${ALLOW_FILE}, in ${secs} s.`)
  } else {
    out.push('', `No finding is open (${allowedCount} allowed by ${ALLOW_FILE}), in ${secs} s.`)
  }
  if (stale.length) {
    const one = stale.length === 1
    const entries = `${stale.length} stale allowlist entr${one ? 'y' : 'ies'}`
    out.push(
      `✗ ${entries}: ${one ? 'it clears' : 'they clear'} nothing in the tree or in any commit`,
      `  since the base. Take ${one ? 'it' : 'them'} out of ${ALLOW_FILE}: an entry nobody`,
      '  needs would clear its value again if it came back.',
    )
  } else if (unused.length) {
    out.push(`  (${unused.length} allowlist entr${unused.length === 1 ? 'y' : 'ies'} matched nothing here)`)
  }
  console.error(out.join('\n'))
  return failed ? 1 : 0
}

const invokedDirectly =
  process.argv[1] && /audit-public\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))
if (invokedDirectly) {
  try {
    process.exitCode = main()
  } catch (err) {
    console.error(`audit:public crashed: ${err instanceof Error ? err.stack : err}`)
    process.exitCode = 2 // fail closed: a crashed gate must not read as a pass
  }
}
