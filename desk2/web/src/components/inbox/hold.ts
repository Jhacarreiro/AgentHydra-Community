// The queue's Undo: while Waiting on you walks the conversations, what the owner sends to the one on screen (a message, a
// permission, a plan or a question's answer) waits a few seconds before it goes, so Undo can still take it back. The
// composer and the store ask here before they send; with the queue off, or for any other conversation, it goes at once.
// No imports: the store and the composer both use it, and the queue's store (store.ts) sets the holder.

/** What a held send is, for the line that offers Undo. */
export type HeldKind = 'message' | 'permission' | 'plan' | 'question'

export interface Holder {
  /** Whether a send to this chat waits for Undo now. */
  holds: (chatId: string) => boolean
  /** Resolves true to send, false when the owner pressed Undo. */
  hold: (chatId: string, kind: HeldKind) => Promise<boolean>
}

let holder: Holder | null = null

export function setInboxHolder(h: Holder | null): void {
  holder = h
}

/** Whether a send to this chat would wait for the queue's Undo window. */
export function inboxHolds(chatId: string | null | undefined): boolean {
  return !!chatId && !!holder?.holds(chatId)
}

/** Waits for the queue's Undo window when the queue holds sends to this chat; true at once otherwise. */
export function inboxHold(chatId: string | null | undefined, kind: HeldKind): Promise<boolean> {
  return chatId && holder ? holder.hold(chatId, kind) : Promise.resolve(true)
}
