// server/src/climayte-unsaved.ts — the files a worker changed and never committed, read when its check
// passes (climayte.ts judgeCheck). A check's exit code says the work runs; it says nothing about
// whether the work was saved. On 2026-10-05 a worker's check passed with 15 of its files uncommitted,
// and the task sat 'done' for 2h26m while the two tasks after it waited on work that was never in git.
// A dirty file counts only while its uncommitted diff still holds a line this worker wrote or replaced, so a
// shared file left with another session's hunks is not failed on (2026-10-15: w-5b2762e2 and w-7e085215 were
// failed over files whose leftover hunks were other workers').

import { realpathSync, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { tailText, transcriptCandidates, transcriptFile } from './climayte-core'
import type { CliMayteAccount, CliMayteWorker } from './climayte-lib'
import { spawnCaptured } from './core/process'

/** The tools whose input names a file the session changed. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** How much of each transcript's end is read, and of all of a task's together, newest session first:
 *  a session of 555 MB exists, and the daemon's tick waits on this. */
const TRANSCRIPT_TAIL = 64 * 1024 * 1024
const TASK_READ_BUDGET = 128 * 1024 * 1024
/** A file changed later than this after the session's last write to it was changed by someone else
 *  (a peer worker in the same checkout, a formatter): it is not counted as this worker's. */
const PEER_SLACK_MS = 30_000
/** The most paths named in one `git status`, well under Windows' command-line limit. */
const PATHSPEC_CHUNK = 200
/** A line is matched only with at least this many non-space characters; each file keeps at most
 *  MAX_LINES_PER_FILE lines per set, and an untracked file is read for its lines up to OWN_BYTES. */
const MIN_LINE_CHARS = 4
const MAX_LINES_PER_FILE = 5000
const OWN_BYTES = 8 * 1024 * 1024

/** A task that says its changes stay uncommitted (the orchestrator commits them, or only a draft is
 *  wanted) is not held to a commit: "do not commit", "Do NOT run git commit, git add or git push",
 *  "no commit, no push", "leave every change uncommitted", "the orchestrator lands it". A rule about
 *  what never to commit ("never commit secrets") is not one. 2026-10-12, group rb-r17: two builders
 *  told "Do NOT run git commit" passed their checks and were ordered to commit, one rung up. */
const NO_COMMIT =
  /\b(?:do not|don't|never|without) (?:run )?(?:git )?(?:commit|committing)\b(?!\s+(?:any\s+|a\s+|the\s+)?(?:secrets?|keys?|tokens?|credentials?|passwords?|\.env)\b)|\bno (?:git )?commit\b|\bleave [^.\n]{0,40}\buncommitted\b|\bthe orchestrator (?:lands|commits)\b/i

/** A file the prompt names as its brief: a .md or .txt path with the word "brief" in its name or in the
 *  80 characters before it ("Read and carry out the brief D:/x/R17-S.md"). A repository's own rules
 *  (CLAUDE.md, AGENTS.md, README.md) are never a brief: they may say what never to commit. */
const BRIEF_PATH = /(?:[A-Za-z]:)?[\w.\-/\\~]+\.(?:md|txt)(?![\w])/gi
const REPO_RULES = new Set(['claude.md', 'agents.md', 'readme.md'])
/** At most this many brief files are read, each at most this big. */
const BRIEF_FILES = 5
const BRIEF_BYTES = 256 * 1024

/** Extensions a check's output names files by; a list, so "e.g" and "v1.2" are not taken for files. */
const OUTPUT_FILE =
  /(?:[A-Za-z]:)?[\w@.\-/\\]*[\w-]\.(?:tsx?|jsx?|mjs|cjs|vue|py|rs|go|json|md|css|scss|html|lua|ya?ml|toml|sh|ps1|cs|java|kt|cpp|c|h)(?![\w])/gi

/** The file paths a check's output names (`src/foo.vue(3,5)`, `desk2/x/foo.ts:12`), lower-cased with
 *  forward slashes. */
export function outputPaths(output: string): string[] {
  const found = (output.match(OUTPUT_FILE) ?? []).map((p) =>
    p.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase(),
  )
  return [...new Set(found)]
}

/** True when the check failed on someone else's work in a shared checkout: the output names at least
 *  one file, none of them is one the task edited, and one of them has uncommitted changes (`dirty`,
 *  repo-relative) that are not the task's. A named file nobody changed (a test the task's own change
 *  broke) does not count: the failure is then the task's. Printed paths match by suffix (output prints
 *  paths relative to wherever the check ran, the edits are absolute). */
export function failsOnlyOnOthersFiles(output: string, edited: string[], dirty: string[]): boolean {
  const named = outputPaths(output)
  if (!named.length) return false
  const same = (a: string, n: string) => a === n || a.endsWith(`/${n}`)
  const mine = edited.map((p) => p.replaceAll('\\', '/').toLowerCase())
  if (named.some((n) => mine.some((m) => same(m, n)))) return false
  const changed = dirty.map((p) => p.replaceAll('\\', '/').toLowerCase())
  return named.some((n) => changed.some((d) => same(d, n)))
}

/** The files `cwd`'s repository shows changed or untracked, repo-relative; null when git cannot say. */
export async function dirtyFiles(cwd: string): Promise<string[] | null> {
  const out = await git(cwd, ['status', '--porcelain', '-z', '-uall'])
  if (out === null) return null
  const files: string[] = []
  const parts = out.split('\0')
  for (let j = 0; j < parts.length; j++) {
    const e = parts[j] as string
    if (e.length < 4) continue
    files.push(e.slice(3))
    if (e[0] === 'R' || e[0] === 'C') j++ // a rename's source path follows it
  }
  return files
}

/** What a file's edit calls did: `at` is the newest such call (ms; Infinity when its line has no timestamp),
 *  `wrote` and `old` the usable lines they wrote and replaced (usableLine), and `capped` says a set hit
 *  MAX_LINES_PER_FILE, so the sets are not the whole and the file is counted as before. */
export type FileEdits = { at: number; wrote: Set<string>; old: Set<string>; capped: boolean }

type EditInput = {
  file_path?: unknown
  notebook_path?: unknown
  old_string?: unknown
  new_string?: unknown
  content?: unknown
  new_source?: unknown
  edits?: unknown
}

/** A line as an edit's lines and git's diff lines are compared: trimmed, or null when it has fewer than
 *  MIN_LINE_CHARS non-space characters or no letter or digit (`}`, `});`), which unrelated code shares. */
function usableLine(raw: string): string | null {
  const line = raw.trim()
  if (line.replace(/\s/g, '').length < MIN_LINE_CHARS || !/[\p{L}\p{N}]/u.test(line)) return null
  return line
}

function usableLines(text: unknown): string[] {
  if (typeof text !== 'string') return []
  return text
    .split('\n')
    .map(usableLine)
    .filter((l): l is string => l !== null)
}

function addCapped(file: FileEdits, into: Set<string>, lines: Iterable<string>): void {
  for (const line of lines) {
    if (into.has(line)) continue
    if (into.size >= MAX_LINES_PER_FILE) {
      file.capped = true
      return
    }
    into.add(line)
  }
}

function fileEdits(map: Map<string, FileEdits>, key: string): FileEdits {
  let file = map.get(key)
  if (!file) {
    file = { at: 0, wrote: new Set(), old: new Set(), capped: false }
    map.set(key, file)
  }
  return file
}

/** Each file the transcript's Edit, Write, MultiEdit and NotebookEdit calls changed, absolute (FileEdits). */
export function parseEdits(jsonl: string, cwd: string): Map<string, FileEdits> {
  const out = new Map<string, FileEdits>()
  for (const raw of jsonl.split('\n')) {
    if (!raw.includes('"tool_use"')) continue
    let rec: { timestamp?: unknown; message?: { content?: unknown } }
    try {
      rec = JSON.parse(raw)
    } catch {
      continue // the first line of a cut read, or a half-written last one
    }
    const content = rec.message?.content
    if (!Array.isArray(content)) continue
    const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN
    for (const c of content as Array<{ type?: unknown; name?: unknown; input?: unknown }>) {
      if (c?.type !== 'tool_use' || !EDIT_TOOLS.has(String(c.name))) continue
      const input = (c.input ?? {}) as EditInput
      const p = input.file_path ?? input.notebook_path
      if (typeof p !== 'string' || !p) continue
      const abs = isAbsolute(p) ? p : resolve(cwd, p)
      const file = fileEdits(out, abs)
      file.at = Math.max(file.at, Number.isNaN(at) ? Number.POSITIVE_INFINITY : at)
      const items = [input, ...(Array.isArray(input.edits) ? (input.edits as EditInput[]) : [])]
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        addCapped(file, file.wrote, usableLines(item.new_string))
        addCapped(file, file.wrote, usableLines(item.content))
        addCapped(file, file.wrote, usableLines(item.new_source))
        addCapped(file, file.old, usableLines(item.old_string))
      }
    }
  }
  return out
}

/** A repo-relative path as compared: Windows paths differ only in case when they are the same file. */
const keyOf = (rel: string): string => (process.platform === 'win32' ? rel.toLowerCase() : rel)

/** A path as the filesystem names it, the form `git rev-parse --show-toplevel` prints: Windows' 8.3
 *  short names resolve (a GitHub runner's TEMP is C:\Users\RUNNER~1\..., while git says runneradmin,
 *  so every edit read as outside the repository and nothing was ever uncommitted: CI, 2026-10-06), as
 *  do macOS' /var -> /private/var and any junction or symlink. A path that is gone is kept as given;
 *  a file the session wrote that no longer exists is never counted anyway. */
function canonical(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

/** A git command in `cwd` on the worker thread (spawnCaptured): its stdout, or null when git failed,
 *  timed out or could not start. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  const r = await spawnCaptured(['git', ...args], { cwd, timeoutMs: 30_000, wantStderr: false })
  return r.code === 0 ? r.stdout : null
}

/** A dirty file of `uncommittedOf`: repo-relative, whether git shows it untracked, and what its session wrote. */
type Candidate = { rel: string; untracked: boolean; own: FileEdits }

/** Of `edits` (from parseEdits), the ones inside `cwd`'s repository that git still shows changed or untracked,
 *  that nobody changed after the session's last write to them, and whose uncommitted diff still holds a line
 *  the session wrote or replaced: repo-relative, sorted. A file whose remaining diff holds none of those lines
 *  is another session's (2026-10-15: w-5b2762e2 and w-7e085215 were failed over shared files that held only
 *  other workers' hunks). Ignored files never show. [] outside a repository. */
export async function uncommittedOf(cwd: string, edits: Map<string, FileEdits>): Promise<string[]> {
  if (!edits.size) return []
  const shown = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim()
  if (!shown) return []
  const top = canonical(shown)
  const written = new Map<string, FileEdits>()
  const rels: string[] = []
  for (const [abs, file] of edits) {
    const rel = relative(top, canonical(abs)).replaceAll('\\', '/')
    if (!rel || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) continue
    written.set(keyOf(rel), file)
    rels.push(rel)
  }
  const dirty = new Map<string, boolean>()
  for (let i = 0; i < rels.length; i += PATHSPEC_CHUNK) {
    const out = await git(top, [
      '--literal-pathspecs',
      'status',
      '--porcelain',
      '-z',
      '-uall',
      '--',
      ...rels.slice(i, i + PATHSPEC_CHUNK),
    ])
    if (out === null) return [] // git could not answer: no claim either way
    const parts = out.split('\0')
    for (let j = 0; j < parts.length; j++) {
      const e = parts[j] as string
      if (e.length < 4) continue
      dirty.set(e.slice(3), e[0] === '?')
      if (e[0] === 'R' || e[0] === 'C') j++ // a rename's source path follows it
    }
  }
  const candidates: Candidate[] = []
  for (const [rel, untracked] of dirty) {
    const own = written.get(keyOf(rel))
    if (!own) continue
    try {
      if (statSync(join(top, rel)).mtimeMs > own.at + PEER_SLACK_MS) continue
    } catch {
      continue // gone since: whoever removed it owns that
    }
    candidates.push({ rel, untracked, own })
  }
  const notOurs = await unownedLines(top, candidates)
  return candidates
    .map((c) => c.rel)
    .filter((rel) => !notOurs.has(rel))
    .sort()
}

/** The candidates whose uncommitted content holds none of the lines their session wrote or replaced. A
 *  candidate with no usable lines, a capped set, or a git answer that does not come stays counted. */
async function unownedLines(top: string, candidates: Candidate[]): Promise<Set<string>> {
  const checkable = candidates.filter((c) => !c.own.capped && (c.own.wrote.size || c.own.old.size))
  const notOurs = new Set<string>()
  for (const c of checkable.filter((c) => c.untracked)) {
    const text = await textUnder(join(top, c.rel), OWN_BYTES)
    if (text !== null && !usableLines(text).some((l) => c.own.wrote.has(l))) notOurs.add(c.rel)
  }
  const tracked = checkable.filter((c) => !c.untracked)
  for (let i = 0; i < tracked.length; i += PATHSPEC_CHUNK) {
    const chunk = tracked.slice(i, i + PATHSPEC_CHUNK)
    const out = await git(top, [
      '-c',
      'core.quotePath=false',
      '--literal-pathspecs',
      'diff',
      'HEAD',
      '--no-color',
      '--no-ext-diff',
      '-U0',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--',
      ...chunk.map((c) => c.rel),
    ])
    if (out === null) continue
    const diffs = diffLines(
      out,
      chunk.map((c) => c.rel),
    )
    for (const c of chunk) {
      const d = diffs.get(c.rel)
      if (!d) continue
      const mine =
        [...d.added].some((l) => c.own.wrote.has(l)) || [...d.removed].some((l) => c.own.old.has(l))
      if (!mine) notOurs.add(c.rel)
    }
  }
  return notOurs
}

/** Per file of a `git diff -U0` output for `rels`: the usable lines it adds and removes. A file the output
 *  does not name is absent. */
function diffLines(
  out: string,
  rels: string[],
): Map<string, { added: Set<string>; removed: Set<string> }> {
  const headers = new Map(
    rels.map((rel): [string, string] => [`diff --git a/${rel} b/${rel}`, rel]),
  )
  const found = new Map<string, { added: Set<string>; removed: Set<string> }>()
  let cur: { added: Set<string>; removed: Set<string> } | undefined
  let inHunk = false
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const rel = headers.get(line.replace(/\r$/, ''))
      cur = undefined
      if (rel !== undefined) {
        cur = { added: new Set(), removed: new Set() }
        found.set(rel, cur)
      }
      inHunk = false
    } else if (cur && line.startsWith('@@')) {
      inHunk = true
    } else if (cur && inHunk && (line[0] === '+' || line[0] === '-')) {
      const text = usableLine(line.slice(1))
      if (text) (line[0] === '+' ? cur.added : cur.removed).add(text)
    }
  }
  return found
}

/** The brief files `prompt` names (BRIEF_PATH), absolute (a relative one from `cwd`), first named first. */
export function briefPaths(prompt: string, cwd: string): string[] {
  const out: string[] = []
  for (const m of prompt.matchAll(BRIEF_PATH)) {
    const name = basename(m[0].replaceAll('\\', '/')).toLowerCase()
    if (REPO_RULES.has(name)) continue
    const before = prompt.slice(Math.max(0, (m.index ?? 0) - 80), m.index)
    if (!name.includes('brief') && !/\bbrief/i.test(before)) continue
    const abs = isAbsolute(m[0]) ? m[0] : resolve(cwd, m[0])
    if (!out.includes(abs)) out.push(abs)
    if (out.length >= BRIEF_FILES) break
  }
  return out
}

/** A file's text, or null when it is missing, not a file or over `limit` bytes. */
async function textUnder(path: string, limit: number): Promise<string | null> {
  try {
    const s = await stat(path)
    return s.isFile() && s.size <= limit ? await readFile(path, 'utf8') : null
  } catch {
    return null
  }
}

/** True when a passing check is its pass without a commit: a `light` worker (it has no shell to commit with) or
 *  `commit: false`; or, with no `commit`, the prompt or a brief file it names says not to commit (NO_COMMIT).
 *  `commit: true` holds it to a commit whatever its words say. Briefs are read off the daemon's thread, like the
 *  git facts. */
export async function saysNoCommit(
  w: Pick<CliMayteWorker, 'prompt' | 'cwd' | 'commit' | 'light'>,
): Promise<boolean> {
  if (w.light) return true
  if (typeof w.commit === 'boolean') return !w.commit
  if (NO_COMMIT.test(w.prompt)) return true
  for (const path of briefPaths(w.prompt, w.cwd)) {
    const text = await textUnder(path, BRIEF_BYTES)
    if (text && NO_COMMIT.test(text)) return true
  }
  return false
}

/** The files the worker's sessions changed and never committed, in its folder's repository; [] for a
 *  task that is not to commit (saysNoCommit). */
export async function unsavedEdits(
  w: CliMayteWorker,
  accounts: CliMayteAccount[],
): Promise<string[]> {
  if (await saysNoCommit(w)) return []
  return uncommittedOf(w.cwd, editsOf(w, accounts))
}

/** Every file the worker's sessions changed, committed or not, as forward-slash paths (absolute as
 *  the sessions named them). Read through the same budget as unsavedEdits. The severity of a failed
 *  check asks whether the files it names are this task's (climayte.ts judgeCheck). */
export function editedFilesOf(w: CliMayteWorker, accounts: CliMayteAccount[]): string[] {
  return [...editsOf(w, accounts).keys()].map((p) => p.replaceAll('\\', '/'))
}

function editsOf(w: CliMayteWorker, accounts: CliMayteAccount[]): Map<string, FileEdits> {
  const dirs = transcriptCandidates(w, accounts).map((c) => c.configDir)
  const edits = new Map<string, FileEdits>()
  let budget = TASK_READ_BUDGET
  for (const id of [...new Set([...(w.sessions ?? []), w.sessionId])].reverse()) {
    if (!id || budget <= 0) continue
    for (const dir of dirs) {
      const file = transcriptFile(dir, id)
      if (!file) continue
      const text = tailText(file, Math.min(TRANSCRIPT_TAIL, budget))
      budget -= Buffer.byteLength(text)
      for (const [p, f] of parseEdits(text, w.cwd)) {
        const into = fileEdits(edits, p)
        into.at = Math.max(into.at, f.at)
        if (f.capped) into.capped = true
        addCapped(into, into.wrote, f.wrote)
        addCapped(into, into.old, f.old)
      }
      break
    }
  }
  return edits
}
