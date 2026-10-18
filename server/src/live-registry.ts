// server/src/live-registry.ts - the live-session registry: which Claude sessions are running
// on this machine right now, joined to their transcripts.
//
// `~/.claude/sessions/<pid>.json` is the CLI's own live registry - `name` is the peer address,
// `sessionId` is the transcript id, plus cwd and pid. This module validates the pid is alive
// and joins the registry world to the transcript store. Extracted from the retired v1
// retired subsystem because "who is live" is general infrastructure:
// the chat dossier answers "is a process hosting this chat right now" from it.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fsSlot } from './core/fs-slots'

export interface LiveSession {
  pid: number
  sessionId: string
  cwd: string
  /** The peer-messaging address (SendMessage target). */
  name: string
  startedAt: number
  transcriptPath: string | null
  /** The Claude Code version the session's engine runs, as the engine wrote it on start. Absent on
   *  records too old to carry one. version-drift.ts reads it to find chats left on an old engine. */
  version?: string
  /** The desktop chat id (`local_...`) whose app hosts this engine. A moved chat keeps its
   *  sessionId on BOTH accounts, so the sessionId alone cannot say which account's copy is
   *  running; this can. Absent on CLI engines and on records too old to carry one. */
  hostSessionId?: string
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Is this REGISTRY RECORD's session alive — not merely "some process owns that pid"?
 *
 *  A pid alone cannot answer that. The registry is written on start and never cleaned on crash,
 *  so a session that died un-gracefully leaves `<pid>.json` behind, and the OS is free to hand
 *  that number to something else: measured 2026-09-13, a dead session's pid had been recycled by
 *  an unrelated instance's Electron renderer, so `list_chats` reported the chat live, the move
 *  gates would have refused it, and `terminate_live` would have killed a STRANGER'S process tree.
 *
 *  `messagingSocketPath` is the session's own named pipe (Windows) / unix socket (POSIX), and it
 *  names THAT session, so a recycled pid cannot answer for it. It is an ADDITIONAL requirement,
 *  never a substitute: on POSIX a crash can leave the socket file on disk, so the pid check still
 *  carries the verdict there and this only narrows it. A record too old to carry a socket path
 *  falls back to the pid alone, which is exactly what every record used to get. */
function sessionAlive(
  reg: { pid: number; messagingSocketPath?: unknown },
  pipes: (fresh?: boolean) => Set<string> | null,
): boolean {
  if (!pidAlive(reg.pid)) return false
  const sock = reg.messagingSocketPath
  if (typeof sock !== 'string' || sock === '') return true
  return socketPresent(sock, pipes)
}

/** Where Windows keeps named pipes: a session's socket there is `\\.\pipe\LOCAL\cc-msg-<hash>`. */
const PIPE_ROOT = '\\\\.\\pipe\\'

/** Does a session's own messaging socket exist? A Windows named pipe is looked up in the pipe
 *  listing and NEVER opened (2026-10-03): `existsSync` on a pipe CONNECTS to it, taking one of the
 *  session's listening instances, and answers false whenever no instance is free - so a busy chat
 *  read as dead (a working chat's move plan said "no live engine - the import would post at once")
 *  and every scan knocked on every engine's pipe, CliMayte's pool every few seconds. A listing that
 *  cannot be read is unknown, which falls back to the pid's verdict: never "gone", the verdict
 *  something acts on. */
function socketPresent(sock: string, pipes: (fresh?: boolean) => Set<string> | null): boolean {
  const path = sock.replace(/\//g, '\\')
  if (!path.toLowerCase().startsWith(PIPE_ROOT)) return existsSync(sock)
  const name = path.slice(PIPE_ROOT.length).toLowerCase()
  const names = pipes()
  if (names === null || names.has(name)) return true
  // Missing from a shared listing that may predate the session: one fresh read decides.
  const fresh = pipes(true)
  return fresh === null || fresh.has(name)
}

/** How long one pipe listing answers every scan. The CliMayte tick scans every second while a worker
 *  runs, and the listing holds every pipe on the PC (thousands with Chrome and ~50 Claude engines up):
 *  the stall profiler had this readdirSync on top of the daemon's ~0.8 core, 15-25% of its samples
 *  (2026-10-09). A pipe that is missing gets a fresh read, at most every PIPES_RETAKE_MS. */
const PIPES_TTL_MS = 1_000
const PIPES_RETAKE_MS = 200
let pipesCache: { at: number; names: Set<string> | null } | null = null

function readPipes(): Set<string> | null {
  try {
    return new Set(readdirSync(PIPE_ROOT).map((n) => n.toLowerCase()))
  } catch {
    return null
  }
}

/** The pipe listing for ONE scan, read on first use from a listing shared for up to PIPES_TTL_MS;
 *  `fresh` retakes it unless it is under PIPES_RETAKE_MS old. */
function pipeListing(): (fresh?: boolean) => Set<string> | null {
  return (fresh = false) => {
    const age = pipesCache ? Date.now() - pipesCache.at : Number.POSITIVE_INFINITY
    if (age > (fresh ? PIPES_RETAKE_MS : PIPES_TTL_MS))
      pipesCache = { at: Date.now(), names: readPipes() }
    return (pipesCache as { names: Set<string> | null }).names
  }
}

/** The CLI's transcript-store encoding of a cwd: every non-alphanumeric character becomes '-'. */
export function projectKeyForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function transcriptPathFor(claudeHome: string, cwd: string, sessionId: string): string | null {
  const direct = join(claudeHome, 'projects', projectKeyForCwd(cwd), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  // The key preserves the cwd's casing as the session recorded it, which is not always the casing
  // in the registry (drive letters wander between 'D:' and 'd:'). The sessionId is globally unique,
  // so a bounded search across project dirs settles it.
  try {
    for (const dir of readdirSync(join(claudeHome, 'projects'))) {
      const p = join(claudeHome, 'projects', dir, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    // No projects dir at all — reported as unreadable per-session by the caller.
  }
  return null
}

/** transcriptPathFor through node:fs/promises, for a caller on the daemon's thread: its existsSync
 *  calls were 11.5 s of the live log's thread stalls in 24 h (2026-10-11), in 4 blocks while the
 *  disk was busy, under the live-session and chat-list routes. */
async function transcriptPathForAsync(
  claudeHome: string,
  cwd: string,
  sessionId: string,
): Promise<string | null> {
  const direct = join(claudeHome, 'projects', projectKeyForCwd(cwd), `${sessionId}.jsonl`)
  if (await exists(direct)) return direct
  let dirs: string[]
  try {
    dirs = await readdir(join(claudeHome, 'projects'))
  } catch {
    return null
  }
  for (const dir of dirs) {
    const p = join(claudeHome, 'projects', dir, `${sessionId}.jsonl`)
    if (await exists(p)) return p
  }
  return null
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

/** A registry file that outlived its process: the session died un-gracefully (computer
 *  restart, crash, kill) - a graceful exit deletes its own `<pid>.json`. Restored from the
 *  archived v1 (piece 8 needs it as crash evidence): mid-process death is a resumable
 *  scenario, so these are surfaced, never silently dropped. */
export interface OrphanSession extends LiveSession {
  registryPath: string
}

export function readOrphanedRegistry(claudeHome: string): OrphanSession[] {
  const dir = join(claudeHome, 'sessions')
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const out: OrphanSession[] = []
  const pipes = pipeListing()
  for (const f of files) {
    try {
      const reg = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (typeof reg?.sessionId !== 'string' || typeof reg?.cwd !== 'string') continue
      if (typeof reg.pid !== 'number' || sessionAlive(reg, pipes)) continue
      out.push({
        pid: reg.pid,
        sessionId: reg.sessionId,
        cwd: reg.cwd,
        name: typeof reg.name === 'string' ? reg.name : reg.sessionId.slice(0, 8),
        startedAt: typeof reg.startedAt === 'number' ? reg.startedAt : 0,
        transcriptPath: transcriptPathFor(claudeHome, reg.cwd, reg.sessionId),
        registryPath: join(dir, f),
      })
    } catch {
      // One unreadable registry entry must not hide the others.
    }
  }
  return out
}

/** Find a transcript by session id alone (no cwd known - e.g. gating a non-live chat): the
 *  sessionId is globally unique, so a bounded scan across project dirs settles it. */
export function findTranscriptById(claudeHome: string, sessionId: string): string | null {
  try {
    for (const dir of readdirSync(join(claudeHome, 'projects'))) {
      const p = join(claudeHome, 'projects', dir, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    // No projects dir at all.
  }
  return null
}

/** A registry file the CLI wrote (`<pid>.json`), kept when it names a session and a pid. */
export type Registration = Record<string, unknown> & { pid: number; sessionId: string }

function registrationOf(text: string): Registration | null {
  const reg = JSON.parse(text)
  return typeof reg?.sessionId === 'string' && typeof reg.pid === 'number' ? reg : null
}

function readRegistrations(claudeHome: string): Registration[] {
  const dir = join(claudeHome, 'sessions')
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const regs: Registration[] = []
  for (const f of files) {
    try {
      const reg = registrationOf(readFileSync(join(dir, f), 'utf8'))
      if (reg) regs.push(reg)
    } catch {
      // One unreadable registry entry must not hide the others.
    }
  }
  return regs
}

/** A home's registrations through node:fs/promises; liveIdsOf judges them on the thread. */
export async function readRegistrationsAsync(claudeHome: string): Promise<Registration[]> {
  const dir = join(claudeHome, 'sessions')
  let files: string[] = []
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const regs = await Promise.all(
    files.map(async (f) => {
      try {
        return registrationOf(await fsSlot(() => readFile(join(dir, f), 'utf8')))
      } catch {
        // One unreadable registry entry must not hide the others.
        return null
      }
    }),
  )
  return regs.filter((r): r is Registration => r !== null)
}

/** The ids of the registrations whose session is alive now (pid and pipe, sessionAlive). */
export function liveIdsOf(regs: Registration[]): string[] {
  const pipes = pipeListing()
  return regs.filter((r) => sessionAlive(r, pipes)).map((r) => r.sessionId)
}

/** The registrations with a cwd whose session is alive now. */
function aliveWithCwd(regs: Registration[]): Array<Registration & { cwd: string }> {
  const pipes = pipeListing()
  return regs.filter(
    (r): r is Registration & { cwd: string } => typeof r.cwd === 'string' && sessionAlive(r, pipes),
  )
}

function liveSession(
  reg: Registration & { cwd: string },
  transcriptPath: string | null,
): LiveSession {
  return {
    pid: reg.pid,
    sessionId: reg.sessionId,
    cwd: reg.cwd,
    name: typeof reg.name === 'string' ? reg.name : reg.sessionId.slice(0, 8),
    startedAt: typeof reg.startedAt === 'number' ? reg.startedAt : 0,
    transcriptPath,
    ...(typeof reg.version === 'string' ? { version: reg.version } : {}),
    ...(typeof reg.hostSessionId === 'string' && reg.hostSessionId !== ''
      ? { hostSessionId: reg.hostSessionId }
      : {}),
  }
}

/** The live sessions of a Claude home. `transcripts: false` leaves transcriptPath null: a caller
 *  that counts sessions or matches them by id pays no lookup (one existsSync per session, or a scan
 *  of every project folder when the cwd's casing moved). */
export function readLiveRegistry(
  claudeHome: string,
  { transcripts = true }: { transcripts?: boolean } = {},
): LiveSession[] {
  return aliveWithCwd(readRegistrations(claudeHome)).map((r) =>
    liveSession(r, transcripts ? transcriptPathFor(claudeHome, r.cwd, r.sessionId) : null),
  )
}

/** readLiveRegistry with every file step through node:fs/promises, for the routes. */
export async function readLiveRegistryAsync(
  claudeHome: string,
  { transcripts = true }: { transcripts?: boolean } = {},
): Promise<LiveSession[]> {
  const live = aliveWithCwd(await readRegistrationsAsync(claudeHome))
  return Promise.all(
    live.map(async (r) =>
      liveSession(
        r,
        transcripts ? await transcriptPathForAsync(claudeHome, r.cwd, r.sessionId) : null,
      ),
    ),
  )
}
