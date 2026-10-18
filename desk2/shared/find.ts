// What Find searches, once for both sides: the window's findHits (loaded items) and the server's search routes (whole transcript).
import type { TranscriptItem } from './protocol'

/** One match: the item it is in, that item's place in the items given, and which match in the item it is. */
export interface SearchHit {
  itemId: string
  position: number
  nth: number
}

/** The text of an item that Find looks in; null for the items it skips (tool rows, a sub-agent's rows). */
export function searchableText(i: TranscriptItem): string | null {
  if (i.parentToolUseId) return null
  if (i.kind === 'user' || i.kind === 'note' || i.kind === 'assistant_text' || i.kind === 'thinking' || i.kind === 'system') return i.text
  return null
}

/** Every match of `query` over `items`, in order; case-insensitive, nothing for a blank query. */
export function searchItems(items: readonly TranscriptItem[], query: string): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: SearchHit[] = []
  items.forEach((i, position) => {
    const text = searchableText(i)?.toLowerCase()
    if (!text) return
    let at = text.indexOf(q)
    let nth = 0
    while (at !== -1) {
      hits.push({ itemId: i.id, position, nth: nth++ })
      at = text.indexOf(q, at + q.length)
    }
  })
  return hits
}

/** The most hits a search route lists; `total` still counts them all. */
export const SEARCH_HITS_MAX = 5000

export interface SearchResult {
  hits: SearchHit[]
  total: number
}

export function searchResult(items: readonly TranscriptItem[], query: string): SearchResult {
  const all = searchItems(items, query)
  return { hits: all.length > SEARCH_HITS_MAX ? all.slice(0, SEARCH_HITS_MAX) : all, total: all.length }
}
