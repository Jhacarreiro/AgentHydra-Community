import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { type PriceableTokens, priceTokens } from '../pricing'
import { isCommandWrapperText } from '../transcript'
import { readTurnUsage } from '../usage-tokens'
import { classify, type SignalLabel } from './signal'
import type { OpenTurn } from './store'

export type Outcome = 'replied' | 'error' | 'usage_limit' | 'cancelled' | 'silent' | 'stuck'
export type Trigger = 'owner' | 'parent' | 'notification' | 'system'

export interface Picked {
  decision: 'swap' | 'stay'
  source: string
  why: string
  p: number | null
}

export interface TurnRecord {
  v: 1
  type: 'turn'
  id: string
  session: string
  deskChat: string | null
  parentChat: string | null
  manager: string
  picked: Picked | null
  trigger: Trigger
  promptChars: number
  start: number
  firstOutput: number | null
  end: number
  firstMs: number | null
  totalMs: number
  outcome: Outcome
  error: string | null
  replyChars: number
  tools: Record<string, number>
  facetsRead: string[]
  sub: { opened: string[]; asks: number; answered: number; unanswered: number }
  workers: string[]
  tokens: { in: number; out: number; cacheRead: number; cacheWrite: number }
  costUsd: number | null
}

export interface SignalRecord {
  v: 1
  type: 'signal'
  turn: string
  from: 'owner' | 'parent'
  label: SignalLabel
  rule: string
  at: number
}

export interface VerdictRecord {
  v: 1
  type: 'verdict'
  turn: string
  worker: string
  verdict: 'pass' | 'fail'
  at: number
}

export interface JudgeRecord {
  v: 1
  type: 'judge'
  turn: string
  score: number
  criteria: Record<string, number>
  facet: string | null
  /** The judge's facet answer when it named no playbook file, kept so a wrong answer can be seen. */
  facetDropped?: string
  why: string
  model: string
  costUsd: number | null
  at: number
}

export const IDLE_FINAL_MS = 30 * 60_000
export const IDLE_STUCK_MS = 60 * 60_000

export interface TranscriptEntry {
  type?: string
  uuid?: string
  timestamp?: string
  isMeta?: boolean
  isApiErrorMessage?: boolean
  isCompactSummary?: boolean
  message?: {
    id?: string
    model?: string
    content?: unknown
    usage?: unknown
  }
}

export interface LineRef {
  offset: number
  entry: TranscriptEntry
}

type Block = {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
  id?: string
  tool_use_id?: string
  content?: unknown
}

export const READ_CHUNK_BYTES = 4 * 1024 * 1024

/** Complete JSON lines from `offset` in chunks, with the byte offset just past the last complete line. */
export async function readLinesFrom(
  path: string,
  offset: number,
  chunkBytes = READ_CHUNK_BYTES,
): Promise<{ lines: LineRef[]; endOffset: number }> {
  const fh = await open(path, 'r')
  try {
    const size = (await fh.stat()).size
    const lines: LineRef[] = []
    let carry = Buffer.alloc(0)
    let carryOffset = offset
    let pos = offset
    while (pos < size) {
      const n = Math.min(chunkBytes, size - pos)
      const chunk = Buffer.alloc(n)
      const { bytesRead } = await fh.read(chunk, 0, n, pos)
      pos += bytesRead
      const buf = Buffer.concat([carry, chunk.subarray(0, bytesRead)])
      let start = 0
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== 0x0a) continue
        pushLine(lines, buf.subarray(start, i), carryOffset + start)
        start = i + 1
      }
      carry = buf.subarray(start)
      carryOffset += start
    }
    return { lines, endOffset: carryOffset }
  } finally {
    await fh.close()
  }
}

/** The complete line that starts at `offset`, or null when there is none. */
export async function readLineAt(
  path: string,
  offset: number,
  chunkBytes = READ_CHUNK_BYTES,
): Promise<LineRef | null> {
  const fh = await open(path, 'r')
  try {
    const size = (await fh.stat()).size
    let bytes = Buffer.alloc(0)
    let pos = offset
    while (pos < size) {
      const n = Math.min(chunkBytes, size - pos)
      const chunk = Buffer.alloc(n)
      const { bytesRead } = await fh.read(chunk, 0, n, pos)
      pos += bytesRead
      bytes = Buffer.concat([bytes, chunk.subarray(0, bytesRead)])
      const nl = bytes.indexOf(0x0a)
      if (nl !== -1) {
        const lines: LineRef[] = []
        pushLine(lines, bytes.subarray(0, nl), offset)
        return lines[0] ?? null
      }
    }
    const lines: LineRef[] = []
    pushLine(lines, bytes, offset)
    return lines[0] ?? null
  } finally {
    await fh.close()
  }
}

function pushLine(out: LineRef[], bytes: Buffer, offset: number): void {
  const text = bytes.toString('utf8').trim()
  if (text.charCodeAt(0) !== 123) return
  try {
    out.push({ offset, entry: JSON.parse(text) as TranscriptEntry })
  } catch {
    // A corrupt line is skipped; the turns around it are still read.
  }
}

function blocksOf(entry: TranscriptEntry): Block[] {
  const c = entry.message?.content
  if (typeof c === 'string') return [{ type: 'text', text: c }]
  return Array.isArray(c) ? (c as Block[]) : []
}

function textOf(blocks: Block[]): string {
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim()
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
  return ''
}

export interface PromptInfo {
  offset: number
  ts: number
  uuid: string | null
  text: string
  trigger: Trigger
}

/** A real prompt: a user entry with its own text, not a tool result, meta line, wrapper or compact summary. */
export function promptOf(ref: LineRef): PromptInfo | null {
  const e = ref.entry
  if (e.type !== 'user' || e.isMeta || e.isCompactSummary) return null
  const blocks = blocksOf(e)
  if (blocks.some((b) => b.type === 'tool_result')) return null
  const text = textOf(blocks)
  if (!text || isCommandWrapperText(text)) return null
  const ts = Date.parse(e.timestamp ?? '')
  if (!Number.isFinite(ts)) return null
  let trigger: Trigger = 'owner'
  // A daemon wake ("[AgentHydra · CliMayte] Not from the user. Ping ...") is a notification too.
  if (/<task-notification>/.test(text) || /^\[AgentHydra\b/.test(text)) trigger = 'notification'
  else if (text.startsWith('<')) trigger = 'system'
  return { offset: ref.offset, ts, uuid: e.uuid ?? null, text, trigger }
}

export interface TurnContext {
  session: string
  managersDir: string
  deskChat: string | null
  parentChat: string | null
  /** The manager and routing decision in force when a turn starts at `promptTs`; null skips the turn. */
  pick: (promptTs: number) => { manager: string; picked: Picked | null } | null
  /** The Desk chat's live state: true busy, false idle, null unknown (Desk did not answer). */
  live?: (deskChat: string) => boolean | null
  now: number
}

interface Draft {
  prompt: PromptInfo
  lastTs: number
  firstOutput: number | null
  tools: Record<string, number>
  facets: Set<string>
  opened: Set<string>
  asks: Array<{ chat: string; idx: number }>
  doneReads: Array<{ chat: string; idx: number }>
  workers: Set<string>
  usage: Map<string, { model: string; usage: unknown }>
  cancelled: boolean
  apiError: string | null
  usageLimit: boolean
  finalText: string | null
}

interface ToolUse {
  name: string
  chat: string
  idx: number
}

const WORKER_ID = /\bw-[a-z0-9]{8}\b/g
const USAGE_LIMIT = /usage limit|rate limit|limit reached|limit resets?|resets? (at|in) /i
/** What a chat ends a turn with when a new message cut it short or a wake needed nothing: not an answer. */
const NO_RESPONSE = /^No response requested\.?$/i

function chatKey(input: Record<string, unknown> | undefined): string {
  const v = input?.chat ?? input?.chatId ?? input?.chat_id
  return typeof v === 'string' ? v : ''
}

function idOf(session: string, p: PromptInfo): string {
  return `${session}:${p.uuid ?? `o${p.offset}`}`
}

function newDraft(prompt: PromptInfo): Draft {
  return {
    prompt,
    lastTs: prompt.ts,
    firstOutput: null,
    tools: {},
    facets: new Set(),
    opened: new Set(),
    asks: [],
    doneReads: [],
    workers: new Set(),
    usage: new Map(),
    cancelled: false,
    apiError: null,
    usageLimit: false,
    finalText: null,
  }
}

function addEntry(
  d: Draft,
  ref: LineRef,
  ctx: TurnContext,
  uses: Map<string, ToolUse>,
  step: { n: number },
): void {
  const e = ref.entry
  const ts = Date.parse(e.timestamp ?? '')
  if (Number.isFinite(ts)) d.lastTs = Math.max(d.lastTs, ts)
  const blocks = blocksOf(e)
  if (e.type === 'user') {
    if (textOf(blocks).includes('[Request interrupted by user')) d.cancelled = true
    for (const b of blocks) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue
      const body = resultText(b.content)
      if (body.startsWith('[Tool call interrupted')) d.cancelled = true
      const use = uses.get(b.tool_use_id)
      if (!use) continue
      if (use.name === 'climayte_run' || use.name === 'climayte_manage') {
        for (const m of body.match(WORKER_ID) ?? []) d.workers.add(m)
      } else if (use.name === 'manager_open') {
        const m = /"chat"\s*:\s*"([^"]+)"/.exec(body)
        if (m) d.opened.add(m[1])
      } else if (
        (use.name === 'manager_read' || use.name === 'manager_ask') &&
        /"status"\s*:\s*"done"/.test(body)
      ) {
        d.doneReads.push({ chat: use.chat, idx: use.idx })
      }
    }
    return
  }
  if (e.type !== 'assistant') return
  if (d.firstOutput === null && Number.isFinite(ts)) d.firstOutput = ts
  const id = e.message?.id
  const model = e.message?.model
  if (id && model && model !== '<synthetic>' && e.message?.usage)
    d.usage.set(id, { model, usage: e.message.usage })
  const text = textOf(blocks)
  if (e.isApiErrorMessage || /^API Error/.test(text)) {
    d.apiError = (text || 'API Error').split('\n')[0].slice(0, 200)
    if (USAGE_LIMIT.test(text)) d.usageLimit = true
    return
  }
  for (const b of blocks) {
    if (b.type !== 'tool_use' || !b.name) continue
    const name = b.name.includes('__') ? b.name.slice(b.name.lastIndexOf('__') + 2) : b.name
    d.tools[name] = (d.tools[name] ?? 0) + 1
    const input = b.input
    if (name === 'Read' && typeof input?.file_path === 'string') {
      const fp = input.file_path.split('\\').join('/')
      const root = ctx.managersDir.split('\\').join('/')
      if (fp.startsWith(`${root}/`) && fp.includes('/playbook/') && fp.endsWith('.md'))
        d.facets.add(basename(fp))
    } else if (name === 'manager_ask') {
      d.asks.push({ chat: chatKey(input), idx: step.n })
      if (b.id) uses.set(b.id, { name, chat: chatKey(input), idx: step.n })
    } else if (name === 'manager_read' && b.id) {
      uses.set(b.id, { name, chat: chatKey(input), idx: step.n })
    } else if (
      (name === 'manager_open' || name === 'climayte_run' || name === 'climayte_manage') &&
      b.id
    ) {
      uses.set(b.id, { name, chat: '', idx: step.n })
    }
  }
  if (text) {
    d.finalText = text
    if (USAGE_LIMIT.test(text) && e.message?.model === '<synthetic>') d.usageLimit = true
  }
  step.n++
}

function outcomeOf(d: Draft, stuck: boolean): Outcome {
  if (stuck) return 'stuck'
  if (d.cancelled) return 'cancelled'
  if (d.usageLimit) return 'usage_limit'
  if (d.apiError) return 'error'
  if (d.finalText && !NO_RESPONSE.test(d.finalText.trim())) return 'replied'
  return 'silent'
}

function finish(d: Draft, ctx: TurnContext, outcome: Outcome): TurnRecord | null {
  const picked = ctx.pick(d.prompt.ts)
  if (!picked) return null
  const byModel: Record<string, PriceableTokens> = {}
  const tokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }
  for (const { model, usage } of d.usage.values()) {
    const u = readTurnUsage(usage)
    if (!u) continue
    if (!byModel[model]) {
      byModel[model] = { input: 0, output: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0 }
    }
    const slot = byModel[model]
    slot.input += u.input
    slot.output += u.output
    slot.cacheRead += u.cacheRead
    slot.cacheCreation5m += u.w5m
    slot.cacheCreation1h += u.w1h
    tokens.in += u.input
    tokens.out += u.output
    tokens.cacheRead += u.cacheRead
    tokens.cacheWrite += u.cacheCreation
  }
  const costUsd = Object.keys(byModel).length ? priceTokens(byModel, d.lastTs).costUsd : null
  const answered = d.asks.filter((a) =>
    d.doneReads.some((r) => r.chat === a.chat && r.idx >= a.idx),
  ).length
  return {
    v: 1,
    type: 'turn',
    id: idOf(ctx.session, d.prompt),
    session: ctx.session,
    deskChat: ctx.deskChat,
    parentChat: ctx.parentChat,
    manager: picked.manager,
    picked: picked.picked,
    trigger: ctx.parentChat && d.prompt.trigger === 'owner' ? 'parent' : d.prompt.trigger,
    promptChars: d.prompt.text.length,
    start: d.prompt.ts,
    firstOutput: d.firstOutput,
    end: d.lastTs,
    firstMs: d.firstOutput === null ? null : d.firstOutput - d.prompt.ts,
    totalMs: d.lastTs - d.prompt.ts,
    outcome,
    error: d.apiError,
    replyChars: d.finalText?.length ?? 0,
    tools: d.tools,
    facetsRead: [...d.facets].sort(),
    sub: {
      opened: [...d.opened].sort(),
      asks: d.asks.length,
      answered,
      unanswered: d.asks.length - answered,
    },
    workers: [...d.workers].sort(),
    tokens,
    costUsd,
  }
}

export interface SignalDraft {
  turn: string
  from: 'owner' | 'parent'
  label: SignalLabel
  rule: string
  at: number
}

export interface WalkResult {
  finals: TurnRecord[]
  signals: SignalDraft[]
  /** Byte offset the next pass starts from: the open turn's prompt, or the end of what was read. */
  cursor: number
  /** Id of the last final turn whose next-message signal is still unwritten. */
  pending: string | null
  /** Offset of the last real prompt read; the next pass classifies against its text. */
  lastPrompt: number | null
  /** The turn still open after this read, or null. */
  open: OpenTurn | null
}

/** Walk one transcript read from a cursor: final turns, and the signal for each turn from the prompt after it. */
export function walkTranscript(
  lines: LineRef[],
  endOffset: number,
  ctx: TurnContext,
  pendingIn: string | null,
  priorIn: string[] = [],
): WalkResult {
  const prompts: Array<{ info: PromptInfo; at: number }> = []
  lines.forEach((ref, at) => {
    const info = promptOf(ref)
    if (info) prompts.push({ info, at })
  })
  const from: 'owner' | 'parent' = ctx.parentChat ? 'parent' : 'owner'
  const result: WalkResult = {
    finals: [],
    signals: [],
    cursor: endOffset,
    pending: pendingIn,
    lastPrompt: null,
    open: null,
  }
  if (prompts.length === 0) return result
  result.lastPrompt = prompts[prompts.length - 1].info.offset

  const priorTexts: string[] = priorIn.slice(-5)
  const signalFrom = (turn: string | null, info: PromptInfo) => {
    if (info.trigger === 'owner' || info.trigger === 'parent') {
      const c = classify(info.text, priorTexts)
      if (turn) result.signals.push({ turn, from, label: c.label, rule: c.rule, at: info.ts })
      priorTexts.push(info.text)
      if (priorTexts.length > 5) priorTexts.shift()
    }
  }

  const uses = new Map<string, ToolUse>()
  const step = { n: 0 }
  const drafts: Draft[] = prompts.map(({ info, at }, k) => {
    const d = newDraft(info)
    const stop = k + 1 < prompts.length ? prompts[k + 1].at : lines.length
    for (let i = at + 1; i < stop; i++) addEntry(d, lines[i], ctx, uses, step)
    return d
  })

  let prevId: string | null = pendingIn
  let prevFinal = true
  drafts.forEach((d, k) => {
    const info = d.prompt
    const isLast = k === drafts.length - 1
    if (k === 0) {
      signalFrom(pendingIn, info)
      result.pending = null
    } else {
      signalFrom(prevFinal ? prevId : null, info)
    }
    if (isLast) return
    const rec = finish(d, ctx, outcomeOf(d, false))
    prevFinal = rec !== null
    prevId = idOf(ctx.session, info)
    if (rec) result.finals.push(rec)
  })

  const last = drafts[drafts.length - 1]
  const idle = ctx.now - last.lastTs
  const keepOpen = (): WalkResult => {
    result.cursor = last.prompt.offset
    result.pending = null
    result.open = openOf(last, ctx)
    return result
  }
  if (idle < IDLE_FINAL_MS) return keepOpen()
  const live = ctx.deskChat ? (ctx.live?.(ctx.deskChat) ?? null) : false
  if (idle >= IDLE_STUCK_MS && live === null) return keepOpen()
  const stuck = idle >= IDLE_STUCK_MS && live === true
  const rec = finish(last, ctx, outcomeOf(last, stuck))
  if (rec) {
    result.finals.push(rec)
    result.pending = rec.id
  }
  result.cursor = endOffset
  return result
}

function openOf(d: Draft, ctx: TurnContext): OpenTurn | null {
  const picked = ctx.pick(d.prompt.ts)
  if (!picked) return null
  return {
    turn: idOf(ctx.session, d.prompt),
    session: ctx.session,
    deskChat: ctx.deskChat,
    manager: picked.manager,
    since: d.prompt.ts,
    lastTs: d.lastTs,
    working: ctx.deskChat && ctx.live ? ctx.live(ctx.deskChat) : null,
  }
}
