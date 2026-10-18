// Pin service's answer, one list for the window (GET /api/chat-services): read when a row menu opens (RowMenuList), at most
// every 15 s unless asked to. null until it first answers, and again after a read that failed, so the next menu asks again.
import { shallowRef } from 'vue'
import type { ChatServiceInfo } from '@shared/protocol'

const FRESH_MS = 15_000

/** null until the service list first answers. */
export const chatServices = shallowRef<ChatServiceInfo[] | null>(null)
let reading: Promise<void> | null = null
let readAt = 0

/** Reads the list again unless it is fresh; `read` is the store's chatServices(). */
export function refreshChatServices(read: () => Promise<ChatServiceInfo[]>): Promise<void> {
  if (reading) return reading
  if (chatServices.value && Date.now() - readAt < FRESH_MS) return Promise.resolve()
  reading = read()
    .then(
      (list) => {
        chatServices.value = list
        readAt = Date.now()
      },
      () => {}
    )
    .finally(() => (reading = null))
  return reading
}
