// Hydra Core's slot for an in-process Desk chat (A1-F6): under the slot or file placement a top-level chat's appended
// prompt carries its pack (or the line naming pack.md), built by the same placeChat a CliMayte chat launch uses
// (server/src/climayte-launch.ts corePromptText) and kept under the Desk chat id, so a new session in the chat (a
// handoff) keeps its lead. The hook keys the chat's messages by HYDRA_DESK_CHAT_ID, set on its Claude process.
// placeChat runs in a child (core-place.ts): its imports reach the daemon's config, whose load moves state folders
// and sets process env, which Desk's own process must not do. About 60ms, once per start, plus a first launch's lead
// pick (up to 5 s on the model), awaited so the Desk server never waits on it.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { coreDir, coreModeOn, corePlacement } from './hydra-core-mode'

const PLACE = join(import.meta.dir, 'core-place.ts')
const PLACE_TIMEOUT_MS = 15_000
/** The hook's chat key (server/src/hydra-core/paths.ts chatKeyOk). */
const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface CoreSlotRequest {
  chat: string
  /** The chat's opener: a sub-chat (a seat or sub-manager) gets no pack, as a CliMayte seat does not. */
  parentId?: string | null
  /** The session being launched: the one resumed, or the id a fresh session is started with. */
  session: string
  fresh: boolean
  cwd: string
  /** The message the launch is for; placement.json keeps the chat's first. */
  prompt: string
  /** How long the rest of the appended prompt is: the slot gets what APPEND_MAX leaves. */
  rest: number
}

/** Whether a launch of this chat now places its pack (core mode on, slot or file, a top-level chat with a hook key). */
export function coreSlotDue(chat: string, parentId?: string | null): boolean {
  if (parentId || !KEY.test(chat) || !coreModeOn()) return false
  const placement = corePlacement()
  return placement === 'slot' || placement === 'file'
}

/** The text to append for the chat's pack, or null when it gets none. A pack that cannot be built is logged and left out.
 *  Awaited, never a synchronous spawn: a first launch's lead pick may wait seconds on a model, and the Desk server
 *  serves every other request meanwhile. */
export async function coreSlot(req: CoreSlotRequest): Promise<string | null> {
  if (!coreSlotDue(req.chat, req.parentId)) return null
  const ask = { ...req, dir: coreDir(), placement: corePlacement() }
  const r = await runPlace(JSON.stringify(ask))
  let answer: { text?: unknown; error?: unknown } | null = null
  try {
    answer = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '')
  } catch {
    // floor-ok: an answer that is not JSON is reported below with the child's own error text
  }
  if (typeof answer?.text === 'string') return answer.text
  const why = typeof answer?.error === 'string' ? answer.error : r.error || r.stderr.trim().split('\n').at(-1) || `exit ${r.code}`
  console.warn(`[core] chat ${req.chat} starts without its Hydra Core pack: ${why}`)
  return null
}

/** Runs core-place.ts with `input` on stdin, killed after PLACE_TIMEOUT_MS. Never rejects. */
function runPlace(input: string): Promise<{ stdout: string; stderr: string; code: number | null; error?: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(process.execPath, [PLACE], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ stdout, stderr, code: null, error: `no answer in ${PLACE_TIMEOUT_MS} ms` })
    }, PLACE_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => { stdout += d })
    child.stderr.on('data', (d: Buffer) => { stderr += d })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: null, error: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
    child.stdin.end(input)
  })
}
