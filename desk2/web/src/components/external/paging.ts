import { shallowReactive } from 'vue'
import type { TranscriptIndex, TranscriptItem } from '@shared/protocol'

/** An outside session's pages are this many items. */
export const EXTERNAL_PAGE = 200

/** The index of each outside session opened, read the way Desk chats' `indexByChat` is (rail, step arrows, peek). */
export const externalIndexBySession = shallowReactive(new Map<string, TranscriptIndex>())

/** The recent part wins by id over anything older that holds the same item. */
export function mergeRecent(older: TranscriptItem[], recent: TranscriptItem[]): TranscriptItem[] {
  if (!older.length) return recent
  const mine = new Set(recent.map((i) => i.id))
  return [...older.filter((i) => !mine.has(i.id)), ...recent]
}

/** A page that came after the ones held (so it lies above them): put in front, items already held left out. */
export function prependPage(older: TranscriptItem[], page: TranscriptItem[]): TranscriptItem[] {
  const have = new Set(older.map((i) => i.id))
  const fresh = page.filter((i) => !have.has(i.id))
  return fresh.length ? [...fresh, ...older] : older
}

/** Where the next page above begins: the byte offset the items header gave, and how many items the last page said remain. */
export interface OlderCursor {
  before: number
  end: number | undefined
  done: boolean
}

/** A fresh cursor for the offset the recent part begins at (0: nothing older). */
export const startCursor = (before: number): OlderCursor => ({ before, end: undefined, done: before <= 0 })

/** The cursor after a page: `above` is the page's header (0 or absent: it was the first). */
export function advanceCursor(c: OlderCursor, above: number | undefined, added: number): OlderCursor {
  const left = above && above > 0 ? above : 0
  return { before: c.before, end: left || undefined, done: !left || !added }
}

/** Whether the recent part now begins somewhere else, so the pages held no longer join it. */
export const cursorMoved = (c: OlderCursor, before: number) => c.before !== before

/** Items the server holds above the loaded ones, by the index's total. */
export const unloadedCount = (c: OlderCursor, total: number | undefined, loaded: number) =>
  c.done ? 0 : Math.max(0, (total ?? 0) - loaded)
