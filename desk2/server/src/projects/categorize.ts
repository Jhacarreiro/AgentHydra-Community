// Which project a chat really worked in (owner, 2026-10-10: "auto-categorize ... it would move the chats to the right
// place, because Scratch is the wrong place"). Decided only from the chat's transcript, deterministically: every
// absolute path in its tool calls (file paths, search roots, the cwd and the paths a Bash command names) and each
// transcript line's cwd, each matched to the deepest known project folder that holds it. The folder with the most
// references wins; no references, or a tie, means the chat stays where it is and the result says why.

/** A known project folder: its sidebar name and its path. */
export interface KnownProject {
  name: string
  path: string
}

export interface Decision {
  /** The winning project, or null when the chat stays. */
  project: KnownProject | null
  /** References to the winner (0 when it stays). */
  refs: number
  /** `winner`, `no references` (no path in the transcript points into a project) or `tie`. */
  reason: 'winner' | 'no references' | 'tie'
  /** Every project referenced, most first, for the result's detail. */
  counts: { name: string; path: string; refs: number }[]
}

/** A Windows drive path (C:\x or C:/x) inside a string. Unix paths are not matched: the owner's projects are on Windows. */
const ABSOLUTE = /[A-Za-z]:[\\/][^\s"'`<>|&;*?()[\]{},]*/g

/** Lower-case, forward slashes, no trailing slash: one spelling per folder. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Every string inside a JSON value, nested objects and arrays included. */
function stringsIn(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsIn(v, out)
}

/** The absolute paths a transcript's lines name: each line's cwd, and every string in a tool call's input. */
export function pathsIn(jsonl: string): string[] {
  const found: string[] = []
  const take = (text: string) => {
    for (const m of text.matchAll(ABSOLUTE)) found.push(m[0])
  }
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"tool_use"') && !line.includes('"cwd"')) continue
    let row: { cwd?: unknown; message?: { content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row.cwd === 'string') take(row.cwd)
    const content = row.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as { type?: unknown; input?: unknown }[]) {
      if (block?.type !== 'tool_use') continue
      const strings: string[] = []
      stringsIn(block.input, strings)
      for (const s of strings) take(s)
    }
  }
  return found
}

/** The project a path is in: the deepest project folder that holds it (the path itself or below it), or null. */
function holdingProject(path: string, projects: readonly { name: string; path: string; key: string }[]): (typeof projects)[number] | null {
  let best: (typeof projects)[number] | null = null
  for (const p of projects) {
    if (path !== p.key && !path.startsWith(p.key + '/')) continue
    if (!best || p.key.length > best.key.length) best = p
  }
  return best
}

/** Decides the project of a chat from the absolute paths its transcript names. `exclude` is the folder the chat is
 * in now (the scratch folder): references to it do not count for or against a project. */
export function decide(paths: readonly string[], projects: readonly KnownProject[], exclude: string | null = null): Decision {
  const known = projects.map((p) => ({ name: p.name, path: p.path, key: normalizePath(p.path) }))
  const skip = exclude ? normalizePath(exclude) : null
  const tally = new Map<string, { name: string; path: string; refs: number }>()
  for (const raw of paths) {
    const path = normalizePath(raw)
    if (skip && (path === skip || path.startsWith(skip + '/'))) continue
    const hit = holdingProject(path, known)
    if (!hit) continue
    const row = tally.get(hit.key) ?? { name: hit.name, path: hit.path, refs: 0 }
    row.refs++
    tally.set(hit.key, row)
  }
  const counts = [...tally.values()].sort((a, b) => b.refs - a.refs || a.name.localeCompare(b.name))
  const [top, second] = counts
  if (!top) return { project: null, refs: 0, reason: 'no references', counts }
  if (second && second.refs === top.refs) return { project: null, refs: 0, reason: 'tie', counts }
  return { project: { name: top.name, path: top.path }, refs: top.refs, reason: 'winner', counts }
}
