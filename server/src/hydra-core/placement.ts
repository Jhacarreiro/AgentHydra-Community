import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { LeadPick } from './lead'
import { appendLog } from './log'
import { type PackRequest, packFor, packNeedsPick, pickForPack, readPlaced } from './pack'
import { chatPaths } from './paths'
import { clearLeadOwed, readSent, setLeadOwed, writeSent } from './sent'

/** The slot's own cap: it sits in the system prompt, so it is not held to Claude Code's 10,000-character hook limit. */
export const SLOT_CAP = 24_000
/** The most a launch's whole appended prompt (Desk's own text plus the slot) may hold. */
export const APPEND_MAX = 32_000

export type Placement = 'slot' | 'attach' | 'file' | 'off'

/** The `<core>/PLACEMENT` setting; absent or unknown means today's behaviour ('off'). */
export function placementOf(dir: string): Placement {
  const file = resolve(dir, 'PLACEMENT')
  if (!existsSync(file)) return 'off'
  const raw = readFileSync(file, 'utf8').trim()
  return raw === 'slot' || raw === 'file' || raw === 'attach' ? raw : 'off'
}

export interface PlacedChat {
  text: string
  ids: string[]
  chars: number
  hash: string
  reused: boolean
}

/** How many sessions placement.json remembers as launched with the pack in their prompt. */
const STARTED_MAX = 50

const textHash = (text: string) => createHash('sha256').update(text).digest('hex')

/** The prompt line a file chat is given: where its pack is. */
export function packLine(file: string): string {
  return `Before you act on any message, read ${file}: it holds this folder's rules and what you need for this chat.`
}

/** What a launch builds the pack from: the chat's stored lead and first owner message, else this launch's. */
function placeInput(
  dir: string,
  req: { chat: string; cwd: string; prompt: string; placement: 'slot' | 'file' },
): PackRequest {
  const old = readPlaced(chatPaths(dir, req.chat).placed)
  // A placement.json from before the chat kept its inputs: its lead is the person its pack held.
  const lead =
    old?.prompt !== undefined ? (old.lead ?? null) : old?.ids.find((id) => id.startsWith('person:'))
  return {
    chat: req.chat,
    session: `placed:${req.placement}:${req.chat}`,
    cwd: req.cwd,
    prompt: old?.prompt ?? req.prompt,
    full: true,
    lead,
    dry: true,
  }
}

/** Whether a launch of the chat ranks its lead (none kept yet), so pickForPlace would ask the model. */
export function placeNeedsPick(
  dir: string,
  req: { chat: string; cwd: string; prompt: string; placement: 'slot' | 'file' },
): boolean {
  return packNeedsPick(dir, placeInput(dir, req))
}

/**
 * The model's lead pick a chat's first launch needs (up to LAUNCH_BUDGET_MS), awaited before placeChat so its
 * synchronous build never waits on the network. Undefined when the chat's lead is already kept.
 */
export function pickForPlace(
  dir: string,
  req: { chat: string; cwd: string; prompt: string; placement: 'slot' | 'file' },
  now = new Date(),
): Promise<LeadPick | undefined> {
  return pickForPack(dir, placeInput(dir, req), now)
}

/**
 * Builds a chat's slot.md or pack.md on every launch and returns what the prompt gets. The pack is rebuilt from
 * what the chat keeps in placement.json (its lead and its first owner message), so a pack-code change, an edited
 * rule or brief, or a rebuilt catalog reaches the chat on its next launch, a new session in the chat (a handoff)
 * keeps its lead, and hydra.md's scope log does not touch it. The file is rewritten only when the text differs.
 * `room` is what the whole appended prompt leaves the slot; a slot longer than it is built again to fit.
 */
export function placeChat(
  dir: string,
  req: {
    chat: string
    session: string
    fresh: boolean
    cwd: string
    prompt: string
    placement: 'slot' | 'file'
    room?: number
    /** The lead the model picked for a first launch, made before by pickForPlace; absent, the word ranker picks. */
    pick?: LeadPick
  },
  now = new Date(),
): PlacedChat {
  const files = chatPaths(dir, req.chat)
  const target = req.placement === 'slot' ? files.slot : files.pack
  const old = readPlaced(files.placed)
  const { prompt } = placeInput(dir, req)
  const build = (cap?: number) =>
    packFor(dir, { ...placeInput(dir, req), cap, pick: req.pick }, now)
  let pack = build(req.placement === 'slot' ? SLOT_CAP : undefined)
  if (req.placement === 'slot' && req.room !== undefined && pack.text.length > req.room) {
    const room = Math.max(0, req.room)
    const from = pack.text.length
    pack = build(room)
    appendLog(
      dir,
      {
        event: 'placement',
        phase: 'cut',
        chat: req.chat,
        session: req.session,
        room,
        from,
        chars: pack.text.length,
      },
      now,
    )
  }

  const body = pack.text
  const hash = textHash(body)
  const reused =
    !!old &&
    old.placement === req.placement &&
    existsSync(target) &&
    readFileSync(target, 'utf8') === body
  if (!reused) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
    if (pack.owed !== undefined) {
      const sent = readSent(files.sent)
      if (pack.owed) setLeadOwed(sent, pack.owed)
      else clearLeadOwed(sent)
      writeSent(files.sent, sent, req.session, now)
    }
  }
  // Every launch, fresh or resumed, puts the pack in the session's prompt.
  const started = (old?.placement === req.placement ? old.started : []).filter(
    (s) => s !== req.session,
  )
  started.push(req.session)
  writeFileSync(
    files.placed,
    JSON.stringify(
      {
        placement: req.placement,
        hash,
        ids: pack.ids,
        chars: body.length,
        started: started.slice(-STARTED_MAX),
        lead: pack.lead,
        prompt,
      },
      null,
      2,
    ),
  )

  const text = req.placement === 'slot' ? body : packLine(resolve(target))
  appendLog(
    dir,
    {
      event: 'placement',
      phase: 'launch',
      chat: req.chat,
      session: req.session,
      placement: req.placement,
      chars: text.length,
      ids: pack.ids,
      pasted: pack.pasted,
      hash,
      reused,
      fresh: req.fresh,
    },
    now,
  )
  return { text, ids: pack.ids, chars: text.length, hash, reused }
}
