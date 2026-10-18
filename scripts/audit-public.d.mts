// Types for audit-public.mjs, so tests can import it under `tsc` (the same sibling-declaration shape
// as release-notes.d.mts and .githooks/check-public-push.d.mts).

export const CONFIG_FILE: string
export const ALLOW_FILE: string
export const PROVENANCE_FILE: string
/** THIRD-PARTY-NOTICES.md: asset.license counts a file it names by path as covered. */
export const NOTICES_FILE: string
/** The path a finding in a commit message is filed under. */
export const MESSAGE_PATH: string
/** Upstream's relicensing commit; built in, so the config can add a boundary but not remove this. */
export const LICENSE_BOUNDARY: string
/** Upstream's last MIT commit, whose history this repository does not carry; built in like
 *  LICENSE_BOUNDARY, so the config's upstreamBase can add a commit but not remove this one. */
export const UPSTREAM_BASE: string

/** Every rule id, with the sentence the report shows for it. */
export const RULES: { readonly [rule: string]: string }

export interface AuditConfig {
  /** The import commit: the root of this repository's history, with baseTree as its tree. */
  base: string
  /** The tree of upstream's last MIT commit, which the import commit has unchanged. */
  baseTree: string
  /** Upstream's last MIT commit, whose history this repository does not carry. */
  upstreamBase?: string
  licenseBoundary?: string
  placeholderUsers: string[]
  commitEmails?: string[]
  allowedEmails: string[]
  allowedEmailDomains: string[]
  historicalPaths?: string[]
  upstreamHosts?: string[]
  /** Upstream's repository slugs (regular expressions) whose release, raw and API links are findings. */
  upstreamRepos?: string[]
  privateRepos?: string[]
  pathDenylist?: string[]
  publicInternalHosts?: string[]
  internalHostPrefixes?: string[]
}

export interface AllowEntry {
  rule: string
  path: string
  fp: string
  reason: string
}

export interface ProvenanceEntry {
  path: string
  blob: string
  sha256: string
  source: string
  build: string
  license: string
}

export interface Finding {
  rule: string
  path: string
  /** 1-based; 0 for a finding about a whole file or a commit. */
  line: number
  col?: number
  fp: string
  note?: string
  commit?: string
  /** The allowlist reason, once applyAllow has matched an entry. */
  allowed?: string
}

export interface Rule {
  id: string
  re: RegExp
  when?: (path: string) => boolean
  check: (
    m: RegExpMatchArray,
    text: string,
    path: string,
  ) => { value: string; note?: string; rule?: string } | null
}

export interface AuditContext {
  config: AuditConfig
  provenance: ProvenanceEntry[]
  rules: Rule[]
}

/** The audit could not run (exit 2), as opposed to a finding (exit 1). */
export class AuditError extends Error {}

/** The first 16 hex digits of the sha256 of `value`. */
export function fingerprint(value: string): string

export function loadAuditFiles(paths?: {
  config?: string
  allow?: string
  provenance?: string
  notices?: string
}): {
  config: AuditConfig
  allow: AllowEntry[]
  provenance: ProvenanceEntry[]
  /** THIRD-PARTY-NOTICES.md's text, or '' when there is none. */
  notices: string
}

/** git user.name and the OS account name, as pii.local-name looks for them. */
export function runnerNames(cwd: string): string[]

export function compileRules(
  config: AuditConfig,
  options?: { localNames?: string[]; notices?: string; provenance?: ProvenanceEntry[] },
): Rule[]

export function scanText(
  text: string,
  path: string,
  rules: Rule[],
  options?: { lineNumbers?: number[] },
): Finding[]

export function scanPath(path: string): Finding[]

/** file.generated for a file whose first lines (`head`) say it is generated; lockfiles never are. */
export function generatedHeader(path: string, head: string): Finding[]

export function auditTree(
  cwd: string,
  rev: string,
  ctx: AuditContext,
): { findings: Finding[]; stats: { files: number; binaries: number } }

export function auditHistory(
  cwd: string,
  revArgs: string[],
  ctx: AuditContext,
): { findings: Finding[]; commits: Array<{ sha: string }> }

/** LICENSE_BOUNDARY, plus the config's licenseBoundary when it names another commit. */
export function licenseBoundaries(config?: Partial<AuditConfig>): string[]

/** A license.boundary finding for each of `commits` with one of `boundaries` in its history. */
export function licenseFindings(cwd: string, boundaries: string[], commits: string[]): Finding[]

/** UPSTREAM_BASE, plus the config's upstreamBase when it names another commit. */
export function upstreamBases(config?: Partial<AuditConfig>): string[]

/** An upstream.history finding for each of `commits` that shares a commit with one of `bases`; none
 *  for a base this clone does not have. */
export function upstreamFindings(cwd: string, bases: string[], commits: string[]): Finding[]

/** license.boundary's and upstream.history's findings for `commits`, from the config's commits. */
export function lineageFindings(
  cwd: string,
  config: Partial<AuditConfig>,
  commits: string[],
): Finding[]

/** The base's provenance: in this clone, a root commit, with the config's baseTree, and the only root
 *  of every one of `tips`' history. Returns its sha; throws AuditError (exit 2) saying what is wrong. */
export function checkBase(cwd: string, config: AuditConfig, tips?: string[]): string

/** The base's own author, committer and message, read as any commit's are (its tree is not). */
export function auditBaseCommit(cwd: string, base: string, ctx: AuditContext): Finding[]

/** The git log arguments for what a pre-push hook's ref lines carry, or null when nothing is new. */
export function pushRevArgs(
  cwd: string,
  refLines: string,
  remoteName: string,
  base: string,
): { include: string[]; args: string[] } | null

/** Marks each finding an entry clears; returns the entries nothing matched. */
export function applyAllow(findings: Finding[], allow: AllowEntry[]): AllowEntry[]

/** Whether the run reads the tree at a commit, the base and every commit from `base` to it, so an
 *  allow entry nothing matched is stale. */
export function readsEverything(
  cwd: string,
  modes: { tree: string[]; history: string[] },
  base: string,
): boolean

/** The command line run: prints the report and returns the exit code (0, 1 or 2). */
export function main(argv?: string[], options?: { stdin?: string }): number
