// The project group header's right-click menu, on the server (owner, 2026-10-10). Two things: read-only stats for one
// project folder (its git state, and where Project Hydra is installed, its Architect summary), and the auto-categorize
// of a scratch folder's chats (categorize.ts decides each chat's project; a placement is the chat's own `group`, the
// field the sidebar's move already sets, and null puts it back in its folder's group).

import { openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { readGit, type GitFacts } from './projects'
import { decide, normalizePath, pathsIn, type Decision, type KnownProject } from './categorize'
import type { HydraLocation, HydraRead } from './hydra'
import type { PlacementProposal, ProjectStats } from '@shared/protocol'

/** How long one folder's stats are kept before they are read again. */
export const STATS_TTL_MS = 5 * 60_000
/** How long stats with a part missing are kept: a git or Project Hydra read that ran out of time on a busy server
 * (a project sweep running git on every project; 2026-10-10 a cold server answered empty after 18 s) is read again
 * at the next right-click after this, not five minutes later. A folder that is no checkout costs one stat to re-read. */
export const PARTIAL_TTL_MS = 30_000
/** How long Project Hydra gets to name the folder's project and to show its Architect summary. */
export const PH_TIMEOUT_MS = 5_000
/** How much of a transcript's end is read for paths. */
const TRANSCRIPT_BYTES = 4 * 1024 * 1024
/** A sidebar group's longest name (the chat's `group`). */
const GROUP_MAX = 60
/** A Project Hydra project key as its registry names it: letters, digits and . _ - (passed to `ph show` as one argument). */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** A chat that can be placed: one of this app's (`desk`, by its id) or one run elsewhere (`outside`, by its session id). */
export interface MenuChat {
  kind: 'desk' | 'outside'
  id: string
  sessionId: string | null
  cwd: string
  title: string
  group: string | null
  archived: boolean
}

export interface Placement {
  kind: 'desk' | 'outside'
  id: string
  /** The sidebar group to show the chat under (a folder's name), or null to put it back in its folder's group. */
  group: string | null
}

export interface MenuDeps {
  findHydra(): HydraLocation | null
  readHydra(at: HydraLocation): Promise<HydraRead>
  /** A checkout's git state, or null when it is not one. Default: projects.ts readGit. */
  git?(path: string): Promise<GitFacts | null>
  /** The chats the sidebar groups, archived ones included. */
  chats(): Promise<MenuChat[]> | MenuChat[]
  /** A session's transcript (.jsonl), or null when there is none. */
  transcript(sessionId: string, cwd: string): string | null
  /** The known project folders the sidebar groups by. */
  projects(): Promise<KnownProject[]> | KnownProject[]
  /** Puts a chat under a group (or back in its folder's, with null). */
  setGroup(chat: { kind: 'desk' | 'outside'; id: string }, group: string | null): Promise<void> | void
  /** Runs `ph show <key> --json` in Hydra's folder. Default: a spawn with no shell and no window. */
  showHydra?(at: HydraLocation, key: string): Promise<string>
  now?(): number
}

interface Cached<T> {
  at: number
  value: T
}

/** Resolves with `value`, or with `fallback` when `ms` pass first. The slow work keeps running; its answer is ignored. */
export function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([work.catch(() => fallback), late]).finally(() => clearTimeout(timer))
}

/** Project Hydra's read of a project out of `ph show <key> --json`: the last Architect run's error and warning counts
 * and when it ran (`row.arkitect_*`), the risk score and the production cell. A count ph has not measured stays null,
 * never 0 (ph: "null means NOT MEASURED"). Null when the answer has no row. */
export function architectOf(json: unknown): ProjectStats['architect'] {
  const top = json as { row?: unknown; risk?: unknown; production?: { cell?: unknown } | null } | null
  const row = top?.row as Record<string, unknown> | undefined
  if (!row || typeof row !== 'object') return null
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    errors: count(row.arkitect_total_errors),
    warnings: count(row.arkitect_warnings),
    lastRunAt: text(row.arkitect_last_run_at),
    risk: count(top?.risk),
    production: text(top?.production?.cell),
  }
}

/** The last `bytes` of a file as text, with a partial first line dropped; '' when it cannot be read. */
export function readTailText(path: string, bytes: number): string {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString('utf8')
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** The folder's name as the sidebar labels it (logic.ts folderLabel): the chat's `group` joins the folder group of that name. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export class ProjectMenu {
  private readonly stat = new Map<string, Cached<ProjectStats>>()
  private hydra: Cached<HydraRead | null> | null = null

  constructor(private readonly deps: MenuDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The folder's stats: git, and Project Hydra's Architect summary when it is installed and names this folder. Each part
   * that cannot be read is null; nothing here throws. Cached per folder for STATS_TTL_MS. */
  async stats(folder: string): Promise<ProjectStats> {
    const id = normalizePath(folder)
    const hit = this.stat.get(id)
    if (hit && this.now() - hit.at < (complete(hit.value) ? STATS_TTL_MS : PARTIAL_TTL_MS)) return hit.value
    const [git, architect, hydra] = await Promise.all([this.gitOf(folder), this.architectOf(folder), this.deps.findHydra()])
    const value: ProjectStats = {
      git: git
        ? {
            branch: git.git.branch,
            upstream: git.git.upstream,
            ahead: git.git.ahead,
            behind: git.git.behind,
            dirty: git.git.dirty,
            lastCommitAt: git.lastCommitAt,
          }
        : null,
      hydra: hydra !== null,
      architect,
    }
    this.stat.set(id, { at: this.now(), value })
    return value
  }

  private async gitOf(folder: string): Promise<GitFacts | null> {
    const read = this.deps.git ?? ((path: string) => readGit(path))
    return within(Promise.resolve().then(() => read(folder)), PH_TIMEOUT_MS, null)
  }

  private async architectOf(folder: string): Promise<ProjectStats['architect']> {
    const at = this.deps.findHydra()
    if (!at) return null
    const key = await within(this.keyOf(at, folder), PH_TIMEOUT_MS, null)
    if (!key || !KEY.test(key)) return null
    const show = this.deps.showHydra ?? defaultShow
    const json = await within(show(at, key).then((out) => JSON.parse(out) as unknown), PH_TIMEOUT_MS, null)
    return json === null ? null : architectOf(json)
  }

  /** The Project Hydra key of the project in `folder`, from its placed projects (cached like the stats). */
  private async keyOf(at: HydraLocation, folder: string): Promise<string | null> {
    if (!this.hydra || this.now() - this.hydra.at >= STATS_TTL_MS) {
      const read = await this.deps.readHydra(at).catch(() => null)
      this.hydra = { at: this.now(), value: read }
    }
    const want = normalizePath(folder)
    return this.hydra.value?.projects.find((p) => normalizePath(p.path) === want)?.key ?? null
  }

  /** Each chat of `folder` (its group still its folder's) with the project its transcript says it worked in. */
  async propose(folder: string): Promise<PlacementProposal[]> {
    const want = normalizePath(folder)
    const [chats, projects] = await Promise.all([this.deps.chats(), this.deps.projects()])
    // The chats the scratch group shows: archived ones stay where they are.
    const here = chats.filter((c) => normalizePath(c.cwd) === want && !c.group && !c.archived)
    const out: PlacementProposal[] = []
    for (const chat of here) {
      const path = chat.sessionId ? this.deps.transcript(chat.sessionId, chat.cwd) : null
      const decision: Decision = path
        ? decide(pathsIn(readTailText(path, TRANSCRIPT_BYTES)), projects, folder)
        : { project: null, refs: 0, reason: 'no references', counts: [] }
      const project = decision.project
      out.push({
        kind: chat.kind,
        id: chat.id,
        title: chat.title,
        project: project ? { name: project.name, path: project.path } : null,
        group: project ? folderName(project.path) : null,
        refs: decision.refs,
        reason: path ? decision.reason : 'no transcript',
      })
    }
    return out
  }

  /** Puts each chat under its group (null: back in its folder's). Returns what was done and what failed. */
  async place(moves: Placement[]): Promise<{ moved: number; failed: { id: string; error: string }[] }> {
    let moved = 0
    const failed: { id: string; error: string }[] = []
    for (const m of moves) {
      try {
        await this.deps.setGroup({ kind: m.kind, id: m.id }, m.group)
        moved++
      } catch (err) {
        failed.push({ id: m.id, error: (err as Error).message })
      }
    }
    return { moved, failed }
  }
}

/** Every part was read: git, and the Architect summary where Project Hydra is installed. */
function complete(stats: ProjectStats): boolean {
  return stats.git !== null && (!stats.hydra || stats.architect !== null)
}

/** A group name a placement may carry: 1 to 60 characters after trimming. */
export function groupName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  return t && t.length <= GROUP_MAX ? t : null
}

/** `ph show <key> --json` with no shell and no window, killed after PH_TIMEOUT_MS. */
async function defaultShow(at: HydraLocation, key: string): Promise<string> {
  const proc = Bun.spawn([at.python, at.ph, 'show', key, '--json'], {
    cwd: at.root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    windowsHide: true,
  })
  const timer = setTimeout(() => proc.kill(), PH_TIMEOUT_MS)
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) throw new Error(`ph show exited ${code}`)
    return out
  } finally {
    clearTimeout(timer)
  }
}
