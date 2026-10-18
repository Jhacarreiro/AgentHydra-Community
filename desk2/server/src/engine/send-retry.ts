// A CliMayte chat's message AgentHydra did not take is kept and sent again, never dropped (owner, 2026-10-13:
// "Your message was not sent: ... AgentHydra did not answer POST /api/corch/workers within 4000 ms", while
// AgentHydra had started the worker anyway; sent again by hand, a second worker ran the same message). Each
// message carries its stand-in's id as its request id, the same on every try, so AgentHydra starts or queues it
// once however many tries reach it.

import { BridgeError } from '../bridge/client'

/** One message still to be taken: its stand-in, the text the worker gets, and its request id. `tried`: it was sent to
 *  AgentHydra at least once, so AgentHydra may have it; one waiting behind another was never sent. */
export interface RetryItem {
  itemId: string
  text: string
  requestId: string
  tried?: boolean
}

/** The first wait before a message is sent again, doubling up to `maxMs`. */
export interface RetryDelays {
  firstMs: number
  maxMs: number
}

export const RETRY_DELAYS: RetryDelays = { firstMs: 2_000, maxMs: 30_000 }

/** How many times a message is sent again after AgentHydra failed on its side (5xx); one it did not answer at all is
 *  sent again for as long as the chat exists. */
export const SERVER_ERROR_TRIES = 5

/** Whether a failed send is AgentHydra's to answer again (busy, restarting, down, or its own error), not a refusal of
 *  the message (no such worker, a folder that is not one), which is final. */
export function retryable(err: unknown): err is BridgeError {
  return err instanceof BridgeError && (err.unreachable || (err.status ?? 0) >= 500)
}

/** The retry list as it was saved with the chat record; anything malformed is left out. */
export function retryItemsOf(stored: unknown): RetryItem[] | undefined {
  if (!Array.isArray(stored)) return undefined
  const items = stored.filter(
    (r): r is RetryItem => !!r && typeof r.itemId === 'string' && typeof r.text === 'string' && typeof r.requestId === 'string',
  )
  return items.length ? items : undefined
}

/** Why a held message is not sent again by an AgentHydra that reads no request id: it could run it twice. */
export const NOT_SENT_AGAIN =
  'AgentHydra did not answer in time, and the AgentHydra running now cannot tell a message sent again from a new one, so this one was not sent again. It may have gone through: check this chat before you send it again. Restarting AgentHydra fixes this.'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
