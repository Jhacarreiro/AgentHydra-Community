import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { CliMayteRole } from '../climayte-lib'
import { completionsApi } from '../mcp-client'
import { deskChats, replyWhenDone } from '../mcp-managers'
import {
  type Caller,
  type ChatOfCaller,
  chatOfCaller,
  refuse,
  type SeatParent,
  untracedRefusal,
} from './caller'
import { type CatalogEntry, loadCatalog, loadRef, loadText } from './catalog'
import { addPick, emptyDoc, type HydraDoc, leadLine, parseHydra, renderHydra } from './hydra-md'
import { appendLog } from './log'
import { chatPaths } from './paths'
import { openOrSend, seatOf } from './seats'

const WAIT_S = 30
let consultWaitS = WAIT_S
/** Tests only: how long a consult waits for its answer (null puts the 30 s back). */
export function setConsultWait(seconds: number | null): void {
  consultWaitS = seconds ?? WAIT_S
}
const TERMINAL = ['done', 'failed', 'cancelled']
const GROUP = 'hydra-core'

export interface Report {
  status: string
  text: string | null
}

export interface Daemon {
  /** `persona`: the worker runs as that persona's seat (role seat). */
  dispatch(prompt: string, title: string, cwd: string, persona?: string): Promise<string>
  report(id: string, waitS: number): Promise<Report | null>
  /** A seat kept as a worker: its session resumes with `text`. */
  send(id: string, text: string): Promise<void>
  /** The completion registry (completions.ts): tells this chat when a seat it opened finishes. */
  completions?: {
    waitFor(input: { ticket: string; label: string; read: string; after: number }): Promise<unknown>
    seen(ticket: string): Promise<unknown>
  }
}

export type UseArgs = {
  chat: string
  id: string
  mode: 'become' | 'consult' | 'hire' | 'load'
  question?: string
  job?: string
  cwd?: string
  caller?: CliMayteRole
  /** The traced caller (mcp-core), for the refusal journal. */
  who?: Caller
  /** The Desk chat `chat` is, as the caller resolved it (null: none); undefined: use() resolves `chat` itself. */
  desk?: SeatParent | null
  /** Keys this chat was filed under before (caller.ts chatOfCaller). */
  aliases?: string[]
  /** Why this call has no seat (logged with a seatless consult or hire). */
  why?: string
}

type Files = ReturnType<typeof chatPaths>

function writeDoc(file: string, doc: HydraDoc): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, renderHydra(doc))
}

function readDoc(file: string): HydraDoc | null {
  return existsSync(file) ? parseHydra(readFileSync(file, 'utf8')) : null
}

function entryOf(dir: string, id: string): CatalogEntry {
  const entries = loadCatalog(dir).entries
  const name = id.startsWith('lead:') ? id.slice('lead:'.length) : null
  const e =
    entries.get(id) ??
    (name === null
      ? undefined
      : [...entries.values()].find((x) => x.kind === 'person' && x.name === name))
  if (!e) throw new Error(`no catalog entry ${id}: use core_find to get an id`)
  return e
}

function checkMode(e: CatalogEntry, mode: UseArgs['mode']): void {
  if (e.kind === 'person') {
    if (mode === 'load') throw new Error(`${e.id} is a person: use become, consult or hire`)
    if (!(e.modes ?? []).includes(mode)) throw new Error(`${e.id} does not allow mode ${mode}`)
    return
  }
  if (mode !== 'load') throw new Error(`${e.id} is not a person: use mode load`)
}

function readText(v: unknown): string | null {
  for (const k of ['report', 'text', 'answer', 'result']) {
    const x = (v as Record<string, unknown>)[k]
    if (typeof x === 'string') return x
  }
  return null
}

function folderOf(files: Files, cwd: string | undefined): string {
  const folder = cwd || (existsSync(files.cwd) ? readFileSync(files.cwd, 'utf8').trim() : '')
  if (!folder) throw new Error('no folder: pass cwd, the calling chat has none')
  return folder
}

export function defaultDaemon(api: (path: string, init?: RequestInit) => Promise<unknown>): Daemon {
  return {
    completions: completionsApi,
    async dispatch(prompt, title, cwd, persona) {
      const seat = persona ? { role: 'seat', persona } : {}
      const reply = (await api('/api/corch/workers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tasks: [{ prompt, title, kind: 'review', light: true, cwd, ...seat }],
          group: GROUP,
        }),
      })) as { workers?: { id?: unknown }[] }
      const id = reply.workers?.[0]?.id
      if (typeof id !== 'string') throw new Error('the daemon did not return a worker id')
      return id
    },
    async report(id, waitS) {
      // The report view is a bare list of rows, one per worker.
      const rows = (await api(
        `/api/corch/workers?ids=${encodeURIComponent(id)}&report=1&wait=${waitS}&chars=4000`,
      )) as Record<string, unknown>[]
      if (!Array.isArray(rows))
        throw new Error('the daemon answered the report view with something other than a list')
      const w = rows.find((x) => x.id === id)
      if (!w) return null
      return { status: String(w.status ?? ''), text: readText(w) }
    },
    async send(id, text) {
      const r = (await api(`/api/corch/workers/${encodeURIComponent(id)}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })) as { ok?: boolean; message?: string }
      if (!r?.ok)
        throw new Error(`the seat ${id} did not take the message: ${r?.message ?? 'no answer'}`)
    },
  }
}

function consultPrompt(e: CatalogEntry, question: string): string {
  return [
    `You are consulted as ${e.name}: ${e.when}`,
    `Full text: ${loadRef(e)}`,
    '',
    'Question:',
    question,
    '',
    'Answer in at most 300 words; read only; change nothing.',
  ].join('\n')
}

function pick(files: Files, e: CatalogEntry, mode: 'consult' | 'hire'): void {
  const doc = readDoc(files.hydraMd)
  if (!doc) return
  addPick(doc, e, mode)
  writeDoc(files.hydraMd, doc)
}

/** The consult jobs a chat ran off-seat, by catalog id: consult with no question reads the latest. */
function consultsPath(files: Files): string {
  return join(files.root, 'consults.json')
}

function readConsults(files: Files): Record<string, string> {
  try {
    return JSON.parse(readFileSync(consultsPath(files), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

function keepConsult(files: Files, id: string, job: string): void {
  mkdirSync(files.root, { recursive: true })
  const all = { ...readConsults(files), [id]: job }
  writeFileSync(consultsPath(files), `${JSON.stringify(all, null, 2)}\n`)
}

/** The job's report once it is done, failed or cancelled, or the last one read when 30 s run out. One report
 *  call returns on any change to the worker (a status, an activity line), so it is no wait for the answer. */
async function settled(daemon: Daemon, job: string): Promise<Report | null> {
  const end = Date.now() + consultWaitS * 1000
  for (;;) {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000))
    const asked = Date.now()
    const r = await daemon.report(job, left)
    if ((r && TERMINAL.includes(r.status)) || left === 0 || Date.now() >= end) return r
    // A worker that is not running (queued, waiting) answers at once: poll it, do not spin.
    if (Date.now() - asked < 500) await sleep(Math.min(1000, Math.max(0, end - Date.now())))
  }
}

/** A consult with no seat: a worker per question, its job kept so a consult with no question reads it back. */
async function consult(dir: string, args: UseArgs, e: CatalogEntry, daemon: Daemon, now: Date) {
  const files = chatPaths(dir, args.chat)
  const known = args.job ?? (args.question ? undefined : readConsults(files)[e.id])
  if (!known && !args.question)
    throw new Error(`${e.id} has no consult in this chat yet: consult it with a question`)
  const job =
    known ??
    (await daemon.dispatch(
      consultPrompt(e, args.question ?? ''),
      `Consult ${e.name}`,
      folderOf(files, args.cwd),
    ))
  if (!known) {
    keepConsult(files, e.id, job)
    pick(files, e, 'consult')
    appendLog(
      dir,
      { chat: args.chat, event: 'seatless', mode: 'consult', id: e.id, job, why: args.why },
      now,
    )
  }
  const r = await settled(daemon, job)
  if (!r || !TERMINAL.includes(r.status))
    return {
      job,
      status: 'working',
      read: `core_use { chat, id: "${e.id}", mode: "consult", job: "${job}" }`,
    }
  return { job, status: r.status, text: r.text }
}

function seatWorkersPath(files: Files): string {
  return join(files.root, 'seat-workers.json')
}

function readSeatWorkers(files: Files): Record<string, string> {
  try {
    return JSON.parse(readFileSync(seatWorkersPath(files), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

/** A Prime whose chat has no Desk row: its seat is a CliMayte worker of the persona (role seat), opened once per
 *  persona per chat and resumed with each new question or job (ROLES.md). */
async function workerSeat(dir: string, args: UseArgs, e: CatalogEntry, daemon: Daemon, now: Date) {
  const files = chatPaths(dir, args.chat)
  const known = readSeatWorkers(files)[e.id]
  const text = args.mode === 'hire' ? args.job : args.question
  if (!text) {
    if (args.mode === 'hire') throw new Error('hire needs a job: say what the seat does')
    if (!known) throw new Error(`${e.id} has no seat in this chat yet: consult it with a question`)
  } else if (known) await daemon.send(known, text)
  const job =
    known ??
    (await daemon.dispatch(
      [`You are now a seat in this chat as ${e.name}: ${e.when}.`, loadText(e), text].join('\n\n'),
      `${e.name} · ${args.chat}`,
      folderOf(files, args.cwd),
      e.id,
    ))
  if (text) {
    if (!known) {
      mkdirSync(files.root, { recursive: true })
      const all = { ...readSeatWorkers(files), [e.id]: job }
      writeFileSync(seatWorkersPath(files), `${JSON.stringify(all, null, 2)}\n`)
    }
    pick(files, e, args.mode === 'hire' ? 'hire' : 'consult')
    const event = known ? 'seat-resumed' : 'seat-opened'
    appendLog(dir, { chat: args.chat, event, mode: args.mode, id: e.id, seat: job }, now)
  }
  if (args.mode === 'hire') return { status: 'started', job }
  const r = await settled(daemon, job)
  return r && TERMINAL.includes(r.status)
    ? { job, status: r.status, text: r.text }
    : { job, status: 'working', read: readHint(e) }
}

const readHint = (e: CatalogEntry) => `core_use { chat, id: "${e.id}", mode: "consult" }`

const seatReadHint = (chat: ChatOfCaller, e: CatalogEntry) =>
  `core_use { chat: "${chat.key}", id: "${e.id}", mode: "consult" }`

/** Tells this chat when the seat's work finishes. A failed registration never fails the call: it is logged. */
async function tellWhenSeatDone(
  daemon: Daemon,
  dir: string,
  chat: ChatOfCaller,
  seat: { chat: string; title: string },
  after: number,
  e: CatalogEntry,
  now: Date,
) {
  try {
    await daemon.completions?.waitFor({
      ticket: `desk-chat:${seat.chat}`,
      label: `Seat "${seat.title}"`,
      read: seatReadHint(chat, e),
      after,
    })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    appendLog(dir, { chat: chat.key, event: 'seat-wait-unregistered', seat: seat.chat, why }, now)
  }
}

async function seatConsult(
  dir: string,
  args: UseArgs,
  chat: ChatOfCaller,
  e: CatalogEntry,
  now: Date,
  daemon: Daemon,
) {
  if (!args.question) {
    const seat = seatOf(dir, chat, e)
    if (!seat) throw new Error(`${e.id} has no seat in this chat yet: consult it with a question`)
    const r = await replyWhenDone({ id: seat.chat, title: seat.title }, null, WAIT_S)
    if (r.status !== 'done') return { seat, status: 'working', read: seatReadHint(chat, e) }
    await daemon.completions?.seen(`desk-chat:${seat.chat}`).catch(() => undefined)
    return { seat, status: 'done', reply: r.reply }
  }
  const sentAt = Date.now()
  const { seat, sentAfter, opened } = await openOrSend(dir, chat, e, args.question, args.cwd)
  pick(chatPaths(dir, chat.key), e, 'consult')
  const event = opened ? 'seat-opened' : 'seat-resumed'
  appendLog(dir, { chat: chat.key, event, mode: 'consult', id: e.id, seat: seat.chat }, now)
  const r = await replyWhenDone({ id: seat.chat, title: seat.title }, sentAfter, WAIT_S)
  if (r.status === 'done') return { seat, status: 'done', reply: r.reply }
  await tellWhenSeatDone(daemon, dir, chat, seat, sentAt, e, now)
  return { seat, status: 'working', read: seatReadHint(chat, e) }
}

async function seatHire(
  dir: string,
  args: UseArgs,
  chat: ChatOfCaller,
  e: CatalogEntry,
  now: Date,
  daemon: Daemon,
) {
  if (!args.job) throw new Error('hire needs a job: say what the seat does')
  const sentAt = Date.now()
  const { seat, opened } = await openOrSend(dir, chat, e, args.job, args.cwd)
  pick(chatPaths(dir, chat.key), e, 'hire')
  const event = opened ? 'seat-opened' : 'seat-resumed'
  appendLog(dir, { chat: chat.key, event, mode: 'hire', id: e.id, seat: seat.chat }, now)
  await tellWhenSeatDone(daemon, dir, chat, seat, sentAt, e, now)
  return { status: 'started', seat }
}

function become(dir: string, args: UseArgs, e: CatalogEntry, now: Date) {
  const files = chatPaths(dir, args.chat)
  const doc = readDoc(files.hydraMd) ?? emptyDoc(now)
  doc.lead = leadLine(e)
  doc.updated = now.toISOString()
  writeDoc(files.hydraMd, doc)
  appendLog(dir, { chat: args.chat, event: 'use', mode: 'become', id: e.id }, now)
  return { lead: doc.lead, text: loadText(e) }
}

function hire(dir: string, args: UseArgs, e: CatalogEntry, now: Date) {
  const files = chatPaths(dir, args.chat)
  pick(files, e, 'hire')
  appendLog(dir, { chat: args.chat, event: 'seatless', mode: 'hire', id: e.id, why: args.why }, now)
  const path = loadRef(e)
  const prefix = `You are hired as ${e.name}: ${e.when}. Read your full text at ${path} before you start.`
  return { id: e.id, persona: path, prefix, question: args.question ?? null }
}

/** The words a refused consult or hire gets back. They name no role (ROLES.md: a drone is never told it is one). */
export function refusalOf(mode: string, id: string): string {
  return `This session cannot ${mode} ${id}: ask whoever started you to ${mode} it.`
}

/** The chat a seat opens under: the one the caller resolved (mcp-core), or the Desk chat `chat` names. */
async function seatChat(args: UseArgs): Promise<ChatOfCaller> {
  if (args.desk !== undefined)
    return { key: args.chat, desk: args.desk, aliases: args.aliases ?? [] }
  const chats = (await deskChats().catch(() => null)) as SeatParent[] | null
  const who = { role: args.caller, worker: null, deskChat: null, why: null }
  return chatOfCaller(who, chats, args.chat)
}

export async function use(dir: string, args: UseArgs, daemon: Daemon, now = new Date()) {
  const e = entryOf(dir, args.id)
  checkMode(e, args.mode)
  const seatMode = args.mode === 'consult' || args.mode === 'hire'
  // Traced by mcp-core and still nobody: only a Prime opens seats, and this caller cannot show it is one.
  if (seatMode && args.who && !args.who.role)
    refuse(args.who, untracedRefusal(`${args.mode} ${e.id}`, args.who.why), {
      dir,
      chat: args.chat,
      mode: args.mode,
      id: e.id,
    })
  if (seatMode && (args.caller === 'drone' || args.caller === 'seat'))
    refuse(
      args.who ?? { role: args.caller, worker: null, deskChat: null, why: null },
      refusalOf(args.mode, e.id),
      { dir, chat: args.chat, mode: args.mode, id: e.id },
    )
  // A seat opens under the chat's Desk row; a Prime whose chat has none keeps its seat as a worker.
  const chat = seatMode ? await seatChat(args) : null
  const seatless = {
    ...args,
    chat: chat?.key ?? args.chat,
    why:
      args.why ??
      (args.caller === 'prime'
        ? `"${args.chat}" is no Desk chat`
        : 'the caller could not be traced, and its chat is no Desk chat'),
  }
  switch (args.mode) {
    case 'become':
      return become(dir, args, e, now)
    case 'consult':
      if (chat?.desk) return seatConsult(dir, args, chat, e, now, daemon)
      if (args.caller === 'prime') return workerSeat(dir, seatless, e, daemon, now)
      return consult(dir, seatless, e, daemon, now)
    case 'hire':
      if (chat?.desk) return seatHire(dir, args, chat, e, now, daemon)
      if (args.caller === 'prime') return workerSeat(dir, seatless, e, daemon, now)
      return hire(dir, seatless, e, now)
    case 'load':
      return { id: e.id, text: loadText(e) }
  }
}
