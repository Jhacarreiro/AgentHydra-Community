// Types for check-public-push.mjs, so tests/githooks/ can import its parsers under `tsc` (the
// same sibling-declaration shape the kit uses for instance-pointer.mjs).
export interface Visibility {
  verdict: 'public' | 'private' | 'unknown'
  reason: string
}

export interface PushRef {
  localRef: string
  localSha: string
  remoteRef: string
  remoteSha: string
  isDelete: boolean
}

/** owner/repo from any URL shape git accepts for GitHub, or null for anything else. */
export function parseGithubSlug(url: string): { owner: string; repo: string } | null

/** Fail-closed: anything that is not provably private answers 'public' or 'unknown'. */
export function lookupVisibility(
  url: string,
  env?: Record<string, string | undefined>,
): Promise<Visibility>

/** The refs git is about to push, from the pre-push hook's stdin. */
export function parseRefLines(text: string): PushRef[]

/** Open sections of the work queue; a missing file is an empty queue. */
export function openTodoSections(todoPath: string): string[]

/** Rule 4: upstream's relicensing commit, which no pushed ref may have in its history. */
export const LICENSE_BOUNDARY: string

/** Rule 4's commits: LICENSE_BOUNDARY plus the audit config's licenseBoundary, when it names another. */
export function licenseBoundaries(cwd?: string): string[]

/** Rule 4: the pushed refs whose history holds one of `boundaries`. Fail-closed on an unclear answer. */
export function licenseRefusals(
  refs: PushRef[],
  boundaries: string[],
  cwd?: string,
): Array<{ ref: string; why: string }>

/** Rules 6 and 7: 3a65ba8e, the last commit upstream published under MIT. Its history is upstream's,
 *  and this repository does not carry it. */
export const UPSTREAM_BASE: string

/** Rule 6: 3a65ba8e's tree, which the import commit at the root of this repository's history has. */
export const UPSTREAM_TREE: string

/** Rules 6 and 7's commits: UPSTREAM_BASE plus the audit config's upstreamBase, when it names another. */
export function upstreamBases(cwd?: string): string[]

/** Rule 6's trees: UPSTREAM_TREE plus the audit config's baseTree, when it names another. */
export function upstreamTrees(cwd?: string): string[]

/** Rule 6: where a commit keeps the release workflow a tag on it runs. */
export const RELEASE_WORKFLOW: string

/** Rule 6: the pushed tags that point at one of `bases` or at a commit in its history (upstream's own
 *  tags), at a commit whose tree is one of `trees` (the import commit), or at a commit whose
 *  RELEASE_WORKFLOW is the one in one of `trees`. Fail-closed on an unclear answer; only the trees
 *  and the workflow are checked for a base that is not in this clone. */
export function upstreamTagRefusals(
  refs: PushRef[],
  upstream: { bases?: string[]; trees?: string[] },
  cwd?: string,
): Array<{ ref: string; why: string }>

/** Rule 7: the pushed refs whose history shares a commit with one of `bases`. Fail-closed on an
 *  unclear answer; none for a base that is not in this clone. */
export function upstreamHistoryRefusals(
  refs: PushRef[],
  bases: string[],
  cwd?: string,
): Array<{ ref: string; why: string }>

/** Rule 7: the import commit, the one root of this repository's history; the audit config's base
 *  names it, and this is the value for a checkout without that config. */
export const IMPORT_COMMIT: string

/** Rule 7's root: the audit config's base when it names a full commit id, else IMPORT_COMMIT. */
export function importCommit(cwd?: string): string

/** Rule 7: the pushed refs whose history has a root commit other than `root` (a shallow clone's
 *  cut-off commits count as such). Fail-closed on an unclear answer; none when this clone does not
 *  have `root`. */
export function foreignRootRefusals(
  refs: PushRef[],
  root: string,
  cwd?: string,
): Array<{ ref: string; why: string }>

/** Rule 5: audit-public.mjs --push over the hook's ref lines: 0 clean, 1 a finding, 2 no verdict (it
 *  could not run, start or finish); 0 when there is no script. */
export function runPushAudit(refText: string, remote: string, cwd?: string): number
