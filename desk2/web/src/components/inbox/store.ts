// The window's one Waiting on you queue (state.ts), bound to the desk store: the composer's and the store's sends ask it
// before they go (hold.ts), and a closing window sends what still waits for Undo.
import { useDesk } from '@/stores/desk'
import { setInboxHolder } from './hold'
import { createInbox, type Inbox } from './state'

export { HOLD_MS } from './state'

let inbox: Inbox | null = null

/** The window's one queue, bound to the desk store; the composer and the store's sends ask it before they go. */
export function useInbox(): Inbox {
  if (inbox) return inbox
  const desk = useDesk()
  const made = createInbox({
    chats: () => desk.chats.value,
    external: () => desk.external.value,
    selected: () => desk.selected.value,
    select: (view) => desk.select(view),
    markRead: (id) => void desk.updateChat(id, { unread: false }).catch(() => {}),
    storage: typeof localStorage === 'undefined' ? null : localStorage
  })
  setInboxHolder({ holds: made.holds, hold: made.hold })
  if (typeof window !== 'undefined') window.addEventListener('pagehide', made.flush)
  inbox = made
  return made
}
