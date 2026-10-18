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

/** Rule 6: 3a65ba8e, the last commit upstream published under MIT, which this repository starts from. */
export const MIT_BASE: string

/** Rule 6's base: the audit config's base when it is a full commit id, else MIT_BASE. */
export function baseCommit(cwd?: string): string

/** Rule 6: the pushed tags that point at `base` or at a commit in its history (upstream's own tags).
 *  Fail-closed on an unclear answer; none when `base` is not in this clone. */
export function upstreamTagRefusals(
  refs: PushRef[],
  base: string,
  cwd?: string,
): Array<{ ref: string; why: string }>

/** Rule 5: audit-public.mjs --push over the hook's ref lines: 0 clean, 1 a finding, 2 no verdict (it
 *  could not run, start or finish); 0 when there is no script. */
export function runPushAudit(refText: string, remote: string, cwd?: string): number
