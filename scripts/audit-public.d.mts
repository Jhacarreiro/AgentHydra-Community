// Types for audit-public.mjs, so tests can import it under `tsc` (the same sibling-declaration shape
// as release-notes.d.mts and .githooks/check-public-push.d.mts).

export const CONFIG_FILE: string
export const ALLOW_FILE: string
export const PROVENANCE_FILE: string
/** The path a finding in a commit message is filed under. */
export const MESSAGE_PATH: string
/** Upstream's relicensing commit; built in, so the config can add a boundary but not remove this. */
export const LICENSE_BOUNDARY: string

/** Every rule id, with the sentence the report shows for it. */
export const RULES: { readonly [rule: string]: string }

export interface AuditConfig {
  base: string
  licenseBoundary?: string
  placeholderUsers: string[]
  commitEmails?: string[]
  allowedEmails: string[]
  allowedEmailDomains: string[]
  historicalPaths?: string[]
  upstreamHosts?: string[]
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

export function loadAuditFiles(paths?: { config?: string; allow?: string; provenance?: string }): {
  config: AuditConfig
  allow: AllowEntry[]
  provenance: ProvenanceEntry[]
}

/** git user.name and the OS account name, as pii.local-name looks for them. */
export function runnerNames(cwd: string): string[]

export function compileRules(config: AuditConfig, options?: { localNames?: string[] }): Rule[]

export function scanText(
  text: string,
  path: string,
  rules: Rule[],
  options?: { lineNumbers?: number[] },
): Finding[]

export function scanPath(path: string): Finding[]

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

/** The git log arguments for what a pre-push hook's ref lines carry, or null when nothing is new. */
export function pushRevArgs(
  cwd: string,
  refLines: string,
  remoteName: string,
  base: string,
): { include: string[]; args: string[] } | null

/** Marks each finding an entry clears; returns the entries nothing matched. */
export function applyAllow(findings: Finding[], allow: AllowEntry[]): AllowEntry[]

/** Whether the run reads the tree at a commit and every commit from `base` to it, so an allow entry
 *  nothing matched is stale. */
export function readsEverything(
  cwd: string,
  modes: { tree: string[]; history: string[] },
  base: string,
): boolean

/** The command line run: prints the report and returns the exit code (0, 1 or 2). */
export function main(argv?: string[], options?: { stdin?: string }): number
