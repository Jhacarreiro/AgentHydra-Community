import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, toNamespacedPath } from 'node:path'
import { CONFIG_DIR } from '../config'
import type { CodexInstance } from '../types'
import { connectCodexAppTools } from './codex-app-tools'
import { codexDesktopRunState } from './codex-desktop'
import { getCodexInstance } from './codex-instances'
import { showMigratedCodexChat } from './codex-migration-visibility'
import { type CodexRpc, connectCodexRpc } from './codex-rpc'
import { holdCodexWriterLock, resetCodexHistoryProjection } from './codex-thread-guard'
import { copyCodexTranscript } from './codex-transcript-copy'
import { type CodexHistory, readCodexHistory } from './codex-transcript-lineage'
import {
  describeStoreRefusal,
  type JsonStoreSpec,
  mutateJsonStore,
  readJsonStore,
} from './json-store'
import { isPathInside, normalizeInstancePath } from './paths'

interface Thread {
  id: string
  name?: string | null
  preview: string
  cwd: string
  path: string | null
  updatedAt: number
  model?: string | null
  modelProvider?: string
  reasoningEffort?: string | null
}

export interface CodexMoveChat {
  id: string
  title: string
  cwd: string
  updatedAt: number
}

export interface CodexMovePlan {
  chats: CodexMoveChat[]
  sourceAccountId: string | null
  targetAccountId: string | null
}

export interface CodexMoveRequest {
  targetId: string
  threadId: string
  updatedAt: number
  sourceAccountId: string | null
  targetAccountId: string | null
  /** Duplicate to account (owner, 2026-10-13): copy and verify as a move does, and leave the original where it is. */
  keepSource?: boolean
}

/** The displayed history compared before the source was archived. */
export interface CodexMoveHistory {
  sourceTurns: number
  sourceItems: number
  destinationTurns: number
  destinationItems: number
}

/** A destination transcript rebuilt in place: the full source history, then every row the
 * destination wrote itself (kept), with rows lost to an earlier repair restored from copies. */
export interface CodexMoveRepair {
  keptRows: number
  recoveredRows: number
  backup: string
}

export interface CodexMoveResult {
  ok: boolean
  destinationThreadId?: string
  transcriptPath?: string
  history?: CodexMoveHistory
  repair?: CodexMoveRepair
  /** Background commands the original still ran, which its Codex app stopped when it archived the chat. */
  stoppedCommands?: string[]
  error?: string
}

export type CodexMoveProgress =
  | { step: 'read'; segments: number }
  | { step: 'copied'; transcriptPath: string }
  | { step: 'repaired'; repair: CodexMoveRepair }
  | { step: 'reprojected' }
  | { step: 'verified'; history: CodexMoveHistory }
  | { step: 'shown' }
  | { step: 'archived' }

interface Receipt {
  /** 'copying' names its planned destination before the file is written, so an interrupted copy
   * resumes into that same id and path instead of making a second one. */
  phase: 'copying' | 'copied' | 'done'
  destinationThreadId?: string
  /** Where the rekeyed copy was written, so a resumed move resumes the copy it already made. */
  transcriptPath?: string
  updatedAt: number
  ownerPid: number | null
  destination: string
  fingerprint: string
  desktopVisible?: boolean
  verified?: CodexMoveHistory
}

interface MoveDependencies {
  getInstance: typeof getCodexInstance
  runState: typeof codexDesktopRunState
  connect: (home: string) => Promise<CodexRpc>
  journalPath: string
  showDestination: typeof showMigratedCodexChat
  /** Archives (or, false, restores) a chat through its account's own open Codex app. */
  setArchivedInApp: typeof setArchivedInRunningApp
  holdWriter: typeof holdCodexWriterLock
  resetProjection: typeof resetCodexHistoryProjection
  /** Where a rewritten destination transcript and its dropped projection rows are kept. */
  backupRoot: string
  /** Earlier copies of the destination transcript, read only to restore rows a repair lost. */
  recoverFrom: string[]
  onProgress: (progress: CodexMoveProgress) => void
}
const defaults: MoveDependencies = {
  getInstance: getCodexInstance,
  runState: codexDesktopRunState,
  connect: connectCodexRpc,
  journalPath: join(CONFIG_DIR, 'codex-chat-moves.json'),
  showDestination: showMigratedCodexChat,
  setArchivedInApp: setArchivedInRunningApp,
  holdWriter: holdCodexWriterLock,
  resetProjection: resetCodexHistoryProjection,
  backupRoot: join(CONFIG_DIR, 'backups'),
  recoverFrom: [],
  onProgress: () => {},
}

function pair(
  fromId: string,
  toId: string,
  deps: MoveDependencies,
): [CodexInstance, CodexInstance] {
  const from = deps.getInstance(fromId)
  const to = deps.getInstance(toId)
  if (!from || !to || from.isExternal || to.isExternal)
    throw new Error('Choose two managed Codex instances.')
  if (
    normalizeInstancePath(realpathSync(from.codexHome)) ===
    normalizeInstancePath(realpathSync(to.codexHome))
  ) {
    throw new Error('Choose a different destination instance.')
  }
  if (to.account?.authMode !== 'chatgpt')
    throw new Error('Sign in to the destination Codex account first.')
  return [from, to]
}

async function activeThreads(rpc: CodexRpc): Promise<Thread[]> {
  const threads: Thread[] = []
  let cursor: string | null = null
  const seen = new Set<string>()
  do {
    const page: { data: Thread[]; nextCursor: string | null } = await rpc.call('thread/list', {
      archived: false,
      limit: 100,
      cursor,
      modelProviders: [],
      sortKey: 'updated_at',
    })
    threads.push(...page.data)
    cursor = page.nextCursor
    if (cursor && seen.has(cursor))
      throw new Error('Codex repeated a chat-list page. Refresh and try again.')
    if (cursor) seen.add(cursor)
  } while (cursor)
  // A chat whose history spans rollouts is listed once per file, the earlier files as older rows
  // with the same id; only the newest row is the chat (its path holds the latest history).
  const newest = new Map<string, Thread>()
  for (const thread of threads)
    if ((newest.get(thread.id)?.updatedAt ?? -Infinity) < thread.updatedAt)
      newest.set(thread.id, thread)
  return [...newest.values()]
}

function chatRow(thread: Thread): CodexMoveChat {
  return {
    id: thread.id,
    title: thread.name || thread.preview || thread.id,
    cwd: thread.cwd,
    updatedAt: thread.updatedAt,
  }
}

function hasUnfinishedTurn(transcript: string): boolean {
  let running = false
  for (const line of transcript.split('\n')) {
    try {
      const row = JSON.parse(line)
      if (row.type !== 'event_msg') continue
      if (row.payload?.type === 'task_started') running = true
      if (row.payload?.type === 'task_complete' || row.payload?.type === 'turn_aborted')
        running = false
    } catch {
      /* an incomplete final line will also fail Codex's own fork */
    }
  }
  return running
}

export async function planCodexChatMove(
  fromId: string,
  toId: string,
  overrides: Partial<MoveDependencies> = {},
): Promise<CodexMovePlan> {
  const deps = { ...defaults, ...overrides }
  const [from, to] = pair(fromId, toId, deps)
  const rpc = await deps.connect(from.codexHome)
  try {
    return {
      chats: (await activeThreads(rpc)).map(chatRow),
      sourceAccountId: from.account?.accountId ?? null,
      targetAccountId: to.account?.accountId ?? null,
    }
  } finally {
    await rpc.close()
  }
}

function receiptStore(file: string): JsonStoreSpec<Record<string, Receipt>> {
  return {
    path: file,
    empty: () => ({}),
    decode: (value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, Receipt>)
        : null,
  }
}

/** A receipt is claimed under an interprocess lock, including across daemon restarts. */
function claimReceipt(
  file: string,
  key: string,
  updatedAt: number,
  destination: string,
  fingerprint: string,
): Receipt {
  const result = mutateJsonStore(receiptStore(file), (rows) => {
    const old = rows[key]
    if (old && old.destination !== destination)
      throw new Error(
        'This chat already has a move to another account. Finish or review that move first.',
      )
    if (old?.ownerPid) {
      let alive = false
      try {
        process.kill(old.ownerPid, 0)
        alive = true
      } catch {
        /* owner exited */
      }
      if (alive) throw new Error('This chat is already being moved.')
    }
    // A planned copy resumes into its named destination; only an unnamed one is unknowable.
    if (old?.phase === 'copying' && !old.destinationThreadId)
      throw new Error(
        'A previous copy could not be confirmed. Check the destination before attempting another move.',
      )
    if (old && (old.updatedAt !== updatedAt || old.fingerprint !== fingerprint))
      throw new Error(
        'The source chat changed after its copy was created. The original has been kept.',
      )
    const receipt: Receipt = {
      ...(old ?? { phase: 'copying', updatedAt, destination, fingerprint }),
      ownerPid: process.pid,
    }
    rows[key] = receipt
    return { result: receipt, changed: true }
  })
  if (!result.ok) throw new Error(describeStoreRefusal('Codex move history', file, result))
  return result.result
}

function saveReceipt(file: string, key: string, receipt: Receipt) {
  const result = mutateJsonStore(receiptStore(file), (rows) => {
    rows[key] = receipt
    return { result: null, changed: true }
  })
  if (!result.ok) throw new Error(describeStoreRefusal('Codex move history', file, result))
}

function assertAccountsMatch(
  from: CodexInstance,
  to: CodexInstance,
  request: CodexMoveRequest,
): void {
  if (
    (from.account?.accountId ?? null) !== request.sourceAccountId ||
    (to.account?.accountId ?? null) !== request.targetAccountId
  ) {
    throw new Error('An account changed since this move was prepared. Review a fresh move list.')
  }
}

/** The source's Codex app may be open or closed (owner, 2026-10-13: a move no longer closes it); the archive at the
 *  end goes through the app when it is open. A state the OS would not report is refused, since that route depends on
 *  it. */
async function assertSourceKnown(from: CodexInstance, deps: MoveDependencies): Promise<void> {
  if ((await deps.runState(from)).state === 'unknown')
    throw new Error('Could not tell whether the source Codex desktop is open. Try again.')
}

function moveKey(from: CodexInstance, request: CodexMoveRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        normalizeInstancePath(realpathSync(from.codexHome)),
        request.sourceAccountId,
        request.threadId,
      ]),
    )
    .digest('hex')
}

/** A duplicate's receipt, apart from the chat's move: a finished copy must never read as a finished move (which would
 *  answer a later move "done" with the original never archived), and each destination keeps its own. */
function copyKey(from: CodexInstance, request: CodexMoveRequest, destination: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        normalizeInstancePath(realpathSync(from.codexHome)),
        request.sourceAccountId,
        request.threadId,
        'copy',
        destination,
      ]),
    )
    .digest('hex')
}

/** A finished duplicate is not repeated by its receipt: asking again makes another copy. An unfinished one is kept, so
 *  an interrupted copy resumes into the destination it planned. */
function dropFinishedCopy(file: string, key: string): void {
  const result = mutateJsonStore(receiptStore(file), (rows) => {
    if (rows[key]?.phase !== 'done') return { result: null, changed: false }
    delete rows[key]
    return { result: null, changed: true }
  })
  if (!result.ok) throw new Error(describeStoreRefusal('Codex move history', file, result))
}

function destinationKey(to: CodexInstance, request: CodexMoveRequest): string {
  return JSON.stringify([
    normalizeInstancePath(realpathSync(to.codexHome)),
    request.targetAccountId,
  ])
}

function alreadyMovedReceipt(
  journalPath: string,
  key: string,
  destination: string,
  updatedAt: number,
): Receipt | null {
  const saved = readJsonStore(receiptStore(journalPath))
  if (saved.status !== 'ok') return null
  const old = saved.value[key]
  if (old?.phase === 'done' && old.destination === destination && old.updatedAt === updatedAt) {
    return old
  }
  return null
}

// Find only among active chats. Never import an archived chat via a forged/stale request.
async function findMovableThread(
  source: CodexRpc,
  from: CodexInstance,
  request: CodexMoveRequest,
): Promise<Thread> {
  const thread = (await activeThreads(source)).find((row) => row.id === request.threadId)
  if (!thread) throw new Error('The source chat is no longer active. Refresh the move list.')
  if (thread.updatedAt !== request.updatedAt)
    throw new Error('The source chat changed. Review a fresh move list.')
  if (
    !thread.path ||
    !existsSync(thread.path) ||
    !isPathInside(realpathSync(join(from.codexHome, 'sessions')), realpathSync(thread.path))
  ) {
    throw new Error('This chat has no local transcript in the source instance.')
  }
  return thread
}

function assertNoUnfinishedTurn(transcript: Buffer): void {
  if (hasUnfinishedTurn(transcript.toString('utf8'))) {
    throw new Error(
      'This chat has an unfinished turn. Stop or finish it in Codex before moving it.',
    )
  }
}

/** Write through a sibling staging file and a rename, so a crash leaves the old file or the whole
 * new one, never a prefix that blocks every retry. A staging file left by such a crash is Hydra's
 * own (Codex reads only `.jsonl`), so it is replaced. */
function writeWhole(path: string, content: string | Buffer, suffix: string): void {
  const staged = `${path}.${suffix}`
  rmSync(staged, { force: true })
  writeFileSync(staged, content, { flag: 'wx', mode: 0o600 })
  renameSync(staged, path)
}

/** Name the destination id and path in the receipt before any file exists, so an interrupted
 * copy resumes into them instead of creating a second chat. */
function planCopy(
  receipt: Receipt,
  deps: MoveDependencies,
  key: string,
  to: CodexInstance,
): Receipt {
  if (receipt.phase !== 'copying' || (receipt.destinationThreadId && receipt.transcriptPath))
    return receipt
  const destinationThreadId = randomUUID()
  const stamp = new Date().toISOString()
  const transcriptPath = join(
    to.codexHome,
    'sessions',
    ...stamp.slice(0, 10).split('-'),
    `rollout-${stamp.slice(0, 19).replaceAll(':', '-')}-${destinationThreadId}.jsonl`,
  )
  const planned = { ...receipt, destinationThreadId, transcriptPath }
  saveReceipt(deps.journalPath, key, planned)
  return planned
}

async function ensureCopied(
  receipt: Receipt,
  deps: MoveDependencies,
  key: string,
  to: CodexInstance,
  thread: Thread,
  history: CodexHistory,
): Promise<Receipt> {
  if (receipt.phase !== 'copying') return receipt
  const planned = receipt
  const transcriptPath = planned.transcriptPath!
  const content = copyCodexTranscript(history.text, thread.id, planned.destinationThreadId!)
  mkdirSync(dirname(transcriptPath), { recursive: true })
  if (!isPathInside(realpathSync(to.codexHome), realpathSync(dirname(transcriptPath)))) {
    throw new Error('The destination session directory points outside this instance.')
  }
  if (!existsSync(transcriptPath)) writeWhole(transcriptPath, content, 'hydra-copy')
  else if (readFileSync(transcriptPath, 'utf8') !== content)
    throw new Error(
      'An interrupted copy left a different file at its planned destination. Both were kept; review them before retrying.',
    )
  const updated: Receipt = { ...planned, phase: 'copied' }
  saveReceipt(deps.journalPath, key, updated)
  deps.onProgress({ step: 'copied', transcriptPath })
  return updated
}

interface Row {
  ordinal: number
  line: string
}

function orderedRows(text: string, what: string): Row[] {
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ordinal: unknown
    try {
      ordinal = JSON.parse(line).ordinal
    } catch {
      throw new Error(`${what} ends in an unreadable row. Nothing was changed.`)
    }
    if (
      !Number.isSafeInteger(ordinal) ||
      (rows.length && (ordinal as number) <= rows.at(-1)!.ordinal)
    )
      throw new Error(`${what} has rows out of order. Nothing was changed.`)
    rows.push({ ordinal: ordinal as number, line })
  }
  return rows
}

/** Rows `from`..`to` that an earlier repair dropped, taken from copies of this same transcript.
 * A copy proves it is one by agreeing, row for row, with every row both of them hold. */
function recoverRows(
  from: number,
  to: number,
  files: string[],
  known: Map<number, string>,
): string[] {
  const found = new Map<number, string>()
  for (const file of files) {
    for (const row of orderedRows(readFileSync(file, 'utf8'), `The recovery file ${file}`)) {
      if (JSON.parse(row.line).type === 'session_meta') continue
      if (row.ordinal >= from && row.ordinal <= to) {
        if (found.has(row.ordinal) && found.get(row.ordinal) !== row.line)
          throw new Error(
            `The recovery files disagree about row ${row.ordinal}. Nothing was changed.`,
          )
        found.set(row.ordinal, row.line)
      } else if (known.has(row.ordinal) && known.get(row.ordinal) !== row.line) {
        throw new Error(
          `${file} is not a copy of this chat (row ${row.ordinal} differs). Nothing was changed.`,
        )
      }
    }
  }
  const rows: string[] = []
  for (let ordinal = from; ordinal <= to; ordinal++) {
    const line = found.get(ordinal)
    if (!line)
      throw new Error(
        `Rows ${from}-${to} of the imported chat are missing and no recovery copy holds row ${ordinal}. Nothing was changed.`,
      )
    rows.push(line)
  }
  return rows
}

/** What the destination transcript must become, or null when it is already whole. It holds the
 * copied history (complete, or only the newest file an older copier took) followed by the rows the
 * destination wrote itself; those are kept verbatim, in order, after the complete history. */
function plannedDestination(
  current: Buffer,
  complete: Buffer,
  partial: Buffer,
  lastOrdinal: number,
  recoverFrom: string[],
): { content: Buffer; keptRows: number; recoveredRows: number } | null {
  const startsWith = (prefix: Buffer) => current.subarray(0, prefix.length).equals(prefix)
  const whole = startsWith(complete)
  if (whole && lastOrdinal < 0) return null // a legacy transcript has no ordinals and no lineage
  if (!whole && !startsWith(partial))
    throw new Error(
      'The imported chat no longer starts with the history copied into it. Nothing was changed; review it before retrying.',
    )
  const tail = current.subarray((whole ? complete : partial).length)
  const own = orderedRows(tail.toString('utf8'), 'The imported chat')
  const first = own[0]?.ordinal ?? lastOrdinal + 1
  if (first <= lastOrdinal)
    throw new Error('The imported chat repeats copied rows. Nothing was changed; review it first.')
  if (whole && first === lastOrdinal + 1) return null
  const known = new Map(
    [...orderedRows(complete.toString('utf8'), 'The copied history'), ...own].map((row) => [
      row.ordinal,
      row.line,
    ]),
  )
  const recovered =
    first > lastOrdinal + 1 ? recoverRows(lastOrdinal + 1, first - 1, recoverFrom, known) : []
  return {
    content: Buffer.concat([
      complete,
      Buffer.from(recovered.map((line) => `${line}\n`).join('')),
      tail,
    ]),
    keptRows: own.length,
    recoveredRows: recovered.length,
  }
}

function busyWriter(): Error {
  return new Error(
    'The imported chat is open in Codex, which still owns its transcript. Let its turn finish and switch to another chat (Codex lets go about a minute later), then retry. Nothing was changed.',
  )
}

/** Drop the destination's history projection under its writer lock, keeping the rows removed. */
function reproject(deps: MoveDependencies, to: CodexInstance, threadId: string, backup: string) {
  const lock = deps.holdWriter(to.codexHome, threadId)
  if (!lock) throw busyWriter()
  try {
    mkdirSync(backup, { recursive: true })
    const removed = deps.resetProjection(to.codexHome, threadId)
    writeFileSync(join(backup, 'history-projection.json'), JSON.stringify(removed))
  } finally {
    lock.release()
  }
}

/** Make an existing destination hold the source's complete history. Older copies took only the
 * newest file of a split history and may since have gained the destination's own turns; the
 * rewrite happens only while Hydra holds the thread's writer lock, so no Codex process can append
 * to the transcript or its projection meanwhile, and the replaced file is backed up first. */
function completeDestination(
  deps: MoveDependencies,
  to: CodexInstance,
  thread: Thread,
  receipt: Receipt,
  history: CodexHistory,
  transcript: Buffer,
): CodexMoveRepair | null {
  const path = receipt.transcriptPath
  const id = receipt.destinationThreadId!
  if (!path || !existsSync(path)) return null
  const complete = Buffer.from(copyCodexTranscript(history.text, thread.id, id))
  const partial = Buffer.from(copyCodexTranscript(transcript.toString('utf8'), thread.id, id))
  const plan = () =>
    plannedDestination(readFileSync(path), complete, partial, history.lastOrdinal, deps.recoverFrom)
  if (!plan()) return null
  const lock = deps.holdWriter(to.codexHome, id)
  if (!lock) throw busyWriter()
  try {
    const rebuilt = plan()
    if (!rebuilt) return null
    const backup = join(deps.backupRoot, `codex-move-${id}-${Date.now()}`)
    mkdirSync(backup, { recursive: true })
    copyFileSync(path, join(backup, basename(path)), constants.COPYFILE_EXCL)
    writeWhole(path, rebuilt.content, 'hydra-repair')
    const removed = deps.resetProjection(to.codexHome, id)
    writeFileSync(join(backup, 'history-projection.json'), JSON.stringify(removed))
    return { keptRows: rebuilt.keptRows, recoveredRows: rebuilt.recoveredRows, backup }
  } finally {
    lock.release()
  }
}

interface Turn {
  id?: string
  items?: unknown[]
}

/** Every turn Codex displays for a chat, oldest first (Codex pages newest first unless asked),
 * with full items. It reads Codex's projection only: resuming a source just to read it would
 * append a settings row to the transcript being moved. */
async function displayedTurns(rpc: CodexRpc, threadId: string): Promise<Turn[]> {
  const turns: Turn[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  do {
    const page: { data?: Turn[]; nextCursor?: string | null } = await rpc.call(
      'thread/turns/list',
      {
        threadId,
        limit: 100,
        itemsView: 'full',
        sortDirection: 'asc',
        ...(cursor ? { cursor } : {}),
      },
    )
    if (!Array.isArray(page?.data)) throw new Error('Codex did not return the chat history.')
    turns.push(...page.data)
    cursor = page.nextCursor ?? null
    if (cursor && seen.has(cursor))
      throw new Error('Codex repeated a history page. Refresh and try again.')
    if (cursor) seen.add(cursor)
  } while (cursor)
  return turns
}

const itemCount = (turns: Turn[]) => turns.reduce((sum, turn) => sum + (turn.items?.length ?? 0), 0)

/** The destination must display every source turn, identical and in order; turns after them are
 * the destination's own work since the copy. Returns the reason it does not, or the counts. */
function compareHistory(source: Turn[], destination: Turn[]): CodexMoveHistory | string {
  if (!source.length)
    return 'Codex shows no history for the source chat, so its copy cannot be verified.'
  const differs = source.findIndex(
    (turn, index) => JSON.stringify(turn) !== JSON.stringify(destination[index]),
  )
  if (differs >= 0)
    return `The imported chat does not show source turn ${differs + 1} of ${source.length} (it shows ${destination.length} turns, ${itemCount(destination)} items; the source has ${itemCount(source)} items).`
  return {
    sourceTurns: source.length,
    sourceItems: itemCount(source),
    destinationTurns: destination.length,
    destinationItems: itemCount(destination),
  }
}

// Resume only the NEW local copy. This lets Codex build both its thread index and paginated
// history database without consulting a source id that only exists in another CODEX_HOME.
// A new id has no goal/queue to auto-continue, and we never issue turn/start. A resume also
// rebuilds a projection Hydra dropped; if the chat is open in Codex meanwhile, Codex rebuilt it.
async function resumeAndVerifyDestination(
  target: CodexRpc,
  to: CodexInstance,
  thread: Thread,
  receipt: Receipt,
  mustResume: boolean,
): Promise<void> {
  const destinationThreadId = receipt.destinationThreadId!
  let resumed = false
  if (!receipt.desktopVisible || mustResume) {
    try {
      await target.call('thread/resume', {
        threadId: destinationThreadId,
        path: receipt.transcriptPath,
        cwd: thread.cwd,
        excludeTurns: true,
        ...(thread.model ? { model: thread.model } : {}),
        ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}),
        ...(thread.reasoningEffort
          ? { config: { model_reasoning_effort: thread.reasoningEffort } }
          : {}),
      })
      resumed = true
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith('already has an active writer'))
        throw error
    }
    if (resumed && !receipt.desktopVisible)
      await target.call('thread/name/set', {
        threadId: destinationThreadId,
        name: chatRow(thread).title,
      })
  }
  const copied = await target.call<{ thread: Thread }>('thread/read', {
    threadId: destinationThreadId,
    includeTurns: false,
  })
  if (
    copied.thread.id !== destinationThreadId ||
    !copied.thread.path ||
    !isPathInside(realpathSync(to.codexHome), realpathSync(copied.thread.path))
  ) {
    throw new Error('The destination copy could not be verified. The source was kept.')
  }
  // Unload the new task so app-server does not leave a live session behind when it exits.
  if (resumed) await target.call('thread/unsubscribe', { threadId: destinationThreadId })
}

/** The source is as it was copied; answers whether its Codex app is open now, which decides how it is archived. */
async function assertSourceUnchanged(
  source: CodexRpc,
  from: CodexInstance,
  deps: MoveDependencies,
  thread: Thread,
  before: Stats,
): Promise<'running' | 'stopped'> {
  const after = statSync(thread.path!)
  const latest = (await activeThreads(source)).find((row) => row.id === thread.id)
  const app = await deps.runState(from)
  if (
    !latest ||
    latest.updatedAt !== thread.updatedAt ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  ) {
    throw new Error(
      'The source changed during the copy. Both chats were kept; review them before continuing.',
    )
  }
  if (app.state === 'unknown')
    throw new Error(
      'Could not tell whether the source Codex desktop is open, so the original was not archived. Both chats were kept; move it again to finish.',
    )
  return app.state
}

async function setArchivedInRunningApp(
  from: CodexInstance,
  threadId: string,
  archived: boolean,
): Promise<void> {
  const app = await connectCodexAppTools(from, threadId)
  const answer = await app.call<{ threadId?: string; archived?: boolean }>('set_thread_archived', {
    threadId,
    hostId: 'local',
    source: 'codex',
    archived,
  })
  if (answer.threadId !== threadId || answer.archived !== archived)
    throw new Error(`The source Codex app did not ${archived ? 'archive' : 'restore'} the chat.`)
}

/** A stopped command's text: the script a shell ran (`pwsh -Command <script>`), else its whole command line. */
function commandText(command: unknown): string {
  const argv = Array.isArray(command) ? command.map(String) : [String(command ?? '')]
  return argv.length >= 3 && /^-(c|command)$/i.test(argv[1] ?? '')
    ? (argv[2] ?? '')
    : argv.join(' ')
}

/**
 * The commands named by rows the app added to the transcript as it archived it, or null when any row is something else.
 * Archiving stops a background command the chat left running and records its end: measured 2026-10-13, a pwsh job still
 * running 2 h after its turn finished got one `item_completed` row (CommandExecution, status failed, exit -1) at the
 * archive, and the mover restored a chat whose copy was complete (owner: "it moves just fine ... Confused as to what
 * its problem is").
 */
function stoppedCommands(added: Buffer): string[] | null {
  const stopped: string[] = []
  for (const line of added.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    let row: {
      type?: string
      payload?: { type?: string; item?: { type?: string; command?: unknown } }
    }
    try {
      row = JSON.parse(line)
    } catch {
      return null
    }
    const item = row.payload?.item
    if (
      row.type !== 'event_msg' ||
      row.payload?.type !== 'item_completed' ||
      item?.type !== 'CommandExecution'
    )
      return null
    stopped.push(commandText(item.command))
  }
  return stopped
}

/**
 * Archive the original through its account's open Codex app. A disk archive under a running app is not seen by it: the
 * window would keep listing the chat, and a message typed there would go to a file the archive had moved. The app
 * archives in the background (measured 2026-10-13: off the active list ~0.6 s later), so the move waits until Codex no
 * longer lists it, then checks the archived file is the transcript it copied (Codex's archive moves the file unchanged),
 * followed by nothing but the end of each background command the archive stopped. A turn that slipped in after the last
 * check is restored to the app and both chats are kept. Answers the commands the archive stopped.
 */
async function archiveThroughApp(
  source: CodexRpc,
  from: CodexInstance,
  deps: MoveDependencies,
  thread: Thread,
  fingerprint: string,
  copiedBytes: number,
): Promise<string[]> {
  await deps.setArchivedInApp(from, thread.id, true)
  const deadline = Date.now() + 15_000
  while ((await activeThreads(source)).some((row) => row.id === thread.id)) {
    if (Date.now() > deadline)
      throw new Error(
        'The source Codex app did not confirm the archive. Both chats were kept; move it again to finish.',
      )
    await Bun.sleep(250)
  }
  const archived = await source.call<{ thread: Thread }>('thread/read', {
    threadId: thread.id,
    includeTurns: false,
  })
  const path = archived.thread.path
  const bytes = path ? readFileSync(path) : null
  if (
    bytes &&
    bytes.length >= copiedBytes &&
    createHash('sha256').update(bytes.subarray(0, copiedBytes)).digest('hex') === fingerprint
  ) {
    const stopped = stoppedCommands(bytes.subarray(copiedBytes))
    if (stopped) return stopped
  }
  await deps.setArchivedInApp(from, thread.id, false)
  throw new Error(
    'The source changed just before it was archived, so it was restored. Both chats were kept; review them before continuing.',
  )
}

async function archiveSourceThread(
  source: CodexRpc,
  from: CodexInstance,
  thread: Thread,
  fingerprint: string,
) {
  try {
    await source.call('thread/archive', { threadId: thread.id })
  } catch (error) {
    // An old import can leave the index pointing at a missing archived rollout
    // while thread/list finds the intact active file. Re-index that exact file
    // through Codex itself; the destination has already verified at this point.
    if (
      !(error instanceof Error) ||
      error.message !== `no rollout found for thread id ${thread.id}`
    )
      throw error
    let repaired: { thread: Thread }
    try {
      repaired = await source.call<{ thread: Thread }>('thread/resume', {
        threadId: thread.id,
        path: thread.path,
        cwd: thread.cwd,
        excludeTurns: true,
      })
    } catch (resumeError) {
      const archivedPath = join(from.codexHome, 'archived_sessions', basename(thread.path!))
      const expected = `cannot resume paginated thread ${thread.id} with stale path: requested ${thread.path}, current ${archivedPath}; omit path and resume by thread id`
      if (
        !(resumeError instanceof Error) ||
        resumeError.message !== expected ||
        existsSync(archivedPath) ||
        !isPathInside(realpathSync(from.codexHome), realpathSync(dirname(archivedPath))) ||
        createHash('sha256').update(readFileSync(thread.path!)).digest('hex') !== fingerprint
      )
        throw resumeError
      // Codex confirms this exact archive location is already indexed. Restore
      // the missing file there without changing database flags or transcript bytes.
      renameSync(thread.path!, archivedPath)
      const archived = await source.call<{ thread: Thread }>('thread/read', {
        threadId: thread.id,
        includeTurns: false,
      })
      if (
        archived.thread.id !== thread.id ||
        !archived.thread.path ||
        relative(
          toNamespacedPath(realpathSync(archived.thread.path)),
          toNamespacedPath(realpathSync(archivedPath)),
        ) !== '' ||
        (await activeThreads(source)).some((row) => row.id === thread.id)
      )
        throw new Error(
          'The repaired source archive could not be verified. The destination was kept.',
        )
      return
    }
    if (
      repaired.thread.id !== thread.id ||
      !repaired.thread.path ||
      relative(
        toNamespacedPath(realpathSync(repaired.thread.path)),
        toNamespacedPath(realpathSync(thread.path!)),
      ) !== '' ||
      !isPathInside(realpathSync(from.codexHome), realpathSync(repaired.thread.path))
    )
      throw new Error('The source index repair could not be verified. Both chats were kept.')
    await source.call('thread/unsubscribe', { threadId: thread.id })
    await source.call('thread/archive', { threadId: thread.id })
  }
}

/** Import into the destination's own home, verify it, then archive the source (a duplicate, `keepSource`, leaves it).
 * No turn is started, credentials are never copied, and an archive failure resumes from the saved destination id. */
export async function moveCodexChat(
  fromId: string,
  request: CodexMoveRequest,
  overrides: Partial<MoveDependencies> = {},
): Promise<CodexMoveResult> {
  const deps = { ...defaults, ...overrides }
  let source: CodexRpc | undefined
  let target: CodexRpc | undefined
  let receipt: Receipt | undefined
  let key = ''
  try {
    const [from, to] = pair(fromId, request.targetId, deps)
    assertAccountsMatch(from, to, request)
    await assertSourceKnown(from, deps)
    source = await deps.connect(from.codexHome)
    const copyOnly = request.keepSource === true
    const destination = destinationKey(to, request)
    key = copyOnly ? copyKey(from, request, destination) : moveKey(from, request)
    if (copyOnly) dropFinishedCopy(deps.journalPath, key)
    const already = copyOnly
      ? null
      : alreadyMovedReceipt(deps.journalPath, key, destination, request.updatedAt)
    if (already) {
      receipt = already
      if (!already.destinationThreadId)
        throw new Error('The completed move has no destination chat identity.')
      // Upgrade older completed receipts too: saved history alone did not make the chat visible.
      if (!already.desktopVisible) {
        await deps.showDestination(to, already.destinationThreadId)
        receipt = { ...already, desktopVisible: true }
        saveReceipt(deps.journalPath, key, receipt)
      }
      return {
        ok: true,
        destinationThreadId: already.destinationThreadId,
        ...(already.verified ? { history: already.verified } : {}),
      }
    }

    const thread = await findMovableThread(source, from, request)
    const before = statSync(thread.path!)
    const transcript = readFileSync(thread.path!)
    assertNoUnfinishedTurn(transcript)
    const fingerprint = createHash('sha256').update(transcript).digest('hex')
    // The whole history, earlier files included, is read before anything is claimed or copied.
    const history = readCodexHistory(thread.path!, from.codexHome)
    deps.onProgress({ step: 'read', segments: history.segments.length })
    receipt = claimReceipt(deps.journalPath, key, thread.updatedAt, destination, fingerprint)
    receipt = planCopy(receipt, deps, key, to)
    receipt = await ensureCopied(receipt, deps, key, to, thread, history)
    const destinationThreadId = receipt.destinationThreadId!
    const repair = completeDestination(deps, to, thread, receipt, history, transcript)
    if (repair) deps.onProgress({ step: 'repaired', repair })

    const sourceTurns = await displayedTurns(source, thread.id)
    target = await deps.connect(to.codexHome)
    await resumeAndVerifyDestination(target, to, thread, receipt, !!repair)
    let verified = compareHistory(sourceTurns, await displayedTurns(target, destinationThreadId))
    if (typeof verified === 'string' && !repair) {
      // A whole transcript whose projection Codex built from an older layout: rebuild it once.
      await target.close()
      target = undefined
      reproject(
        deps,
        to,
        destinationThreadId,
        join(deps.backupRoot, `codex-move-${destinationThreadId}-${Date.now()}`),
      )
      deps.onProgress({ step: 'reprojected' })
      target = await deps.connect(to.codexHome)
      await resumeAndVerifyDestination(target, to, thread, receipt, true)
      verified = compareHistory(sourceTurns, await displayedTurns(target, destinationThreadId))
    }
    if (typeof verified === 'string') throw new Error(`${verified} The source was kept.`)
    receipt = { ...receipt, verified }
    saveReceipt(deps.journalPath, key, receipt)
    deps.onProgress({ step: 'verified', history: verified })
    // Our app-server holds the copy's writer lock until it exits; let the desktop own it.
    await target.close()
    target = undefined

    await deps.showDestination(to, destinationThreadId)
    receipt = { ...receipt, desktopVisible: true }
    saveReceipt(deps.journalPath, key, receipt)
    deps.onProgress({ step: 'shown' })
    let stopped: string[] = []
    if (!copyOnly) {
      if ((await assertSourceUnchanged(source, from, deps, thread, before)) === 'running')
        stopped = await archiveThroughApp(
          source,
          from,
          deps,
          thread,
          fingerprint,
          transcript.length,
        )
      else await archiveSourceThread(source, from, thread, fingerprint)
    }
    receipt = { ...receipt, phase: 'done' }
    saveReceipt(deps.journalPath, key, receipt)
    if (!copyOnly) deps.onProgress({ step: 'archived' })
    return {
      ok: true,
      destinationThreadId,
      history: verified,
      ...(repair ? { repair } : {}),
      ...(stopped.length ? { stoppedCommands: stopped } : {}),
    }
  } catch (error) {
    return {
      ok: false,
      destinationThreadId: receipt?.destinationThreadId,
      error: error instanceof Error ? error.message : 'Could not move the Codex chat.',
    }
  } finally {
    await source?.close()
    await target?.close()
    if (receipt) {
      try {
        saveReceipt(deps.journalPath, key, { ...receipt, ownerPid: null })
      } catch {
        /* keep the durable receipt */
      }
    }
  }
}

/**
 * Takes one chat off its Codex account without moving it, or (`archived` false) puts it back: Desk's Move to account >
 * Unassigned, "not assigned to an account, but it's not archived" (owner, 2026-10-13). Codex has no account-less chat,
 * so the chat is archived on its account while Desk holds it, and restored there before it moves on. An open app
 * archives or restores it itself, since a disk archive under a running app is one it never sees; a closed one through
 * app-server. A chat with an unfinished turn is refused: the archive would stop it. Already in the state asked: done.
 */
export async function setCodexChatArchived(
  instanceId: string,
  threadId: string,
  archived: boolean,
  overrides: Partial<MoveDependencies> = {},
): Promise<{ ok: boolean; error?: string }> {
  const deps = { ...defaults, ...overrides }
  let rpc: CodexRpc | undefined
  try {
    const inst = deps.getInstance(instanceId)
    if (!inst || inst.isExternal) throw new Error('Choose a managed Codex instance.')
    const app = await deps.runState(inst)
    if (app.state === 'unknown')
      throw new Error('Could not tell whether its Codex desktop is open. Try again.')
    const conn = await deps.connect(inst.codexHome)
    rpc = conn
    const active = async () => (await activeThreads(conn)).find((row) => row.id === threadId)
    const listed = await active()
    if (!!listed !== archived) return { ok: true }
    if (
      listed?.path &&
      existsSync(listed.path) &&
      hasUnfinishedTurn(readFileSync(listed.path, 'utf8'))
    )
      throw new Error(
        'This chat has an unfinished turn. Stop or finish it in Codex before taking it off its account.',
      )
    if (app.state === 'running') await deps.setArchivedInApp(inst, threadId, archived)
    else await conn.call(archived ? 'thread/archive' : 'thread/unarchive', { threadId })
    // The app archives in the background (~0.6 s, measured 2026-10-13); app-server answers once it is done.
    const deadline = Date.now() + 15_000
    while (!!(await active()) === archived) {
      if (Date.now() > deadline)
        throw new Error(
          `Its Codex ${app.state === 'running' ? 'app' : 'account'} did not confirm the chat was ${archived ? 'archived' : 'restored'}.`,
        )
      await Bun.sleep(250)
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : `Could not ${archived ? 'archive' : 'restore'} the Codex chat.`,
    }
  } finally {
    await rpc?.close()
  }
}
