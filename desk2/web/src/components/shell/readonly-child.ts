// A chat another chat opened (parentId) is run by its parent: the person sees it but only talks to the parent.
// No Vue here, so web/test/shell can test it with plain bun.

import type { ChatSummary } from '@shared/protocol'

export const LOCKED_TITLE = 'Its parent chat answers this.'

export interface ReadOnlyChild {
  parentId: string
  parentTitle: string
  draft: string
}

export function readOnlyChild(
  chat: Pick<ChatSummary, 'title' | 'parentId'>,
  chats: readonly Pick<ChatSummary, 'id' | 'title'>[]
): ReadOnlyChild | null {
  if (!chat.parentId) return null
  const parent = chats.find((c) => c.id === chat.parentId)
  return {
    parentId: chat.parentId,
    parentTitle: parent?.title || 'the parent chat',
    draft: `About "${chat.title}": `
  }
}
