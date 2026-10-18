import { describe, expect, it } from 'bun:test'
import type { TranscriptItem } from '../../shared/protocol'
import { advanceCursor, mergeRecent, prependPage, startCursor, unloadedCount } from '../src/components/external/paging'

const it_ = (id: string, text = id) => ({ id, kind: 'user', text }) as unknown as TranscriptItem
const ids = (l: TranscriptItem[]) => l.map((i) => i.id)

describe('outside session paging', () => {
  it('pages arrive in order with no duplicate', () => {
    let held: TranscriptItem[] = []
    held = prependPage(held, [it_('c'), it_('d')])
    held = prependPage(held, [it_('b'), it_('c')])
    held = prependPage(held, [it_('a')])
    expect(ids(held)).toEqual(['a', 'b', 'c', 'd'])
  })
  it("a poll's recent part wins by id", () => {
    const merged = mergeRecent([it_('a'), it_('b', 'old')], [it_('b', 'new'), it_('c')])
    expect(ids(merged)).toEqual(['a', 'b', 'c'])
    expect((merged[1] as unknown as { text: string }).text).toBe('new')
  })
  it('the cursor stops on the first page or an empty one', () => {
    let c = startCursor(900)
    expect(c.done).toBe(false)
    c = advanceCursor(c, 350, 200)
    expect(c).toEqual({ before: 900, end: 350, done: false })
    expect(advanceCursor(c, 350, 0).done).toBe(true)
    expect(advanceCursor(c, 0, 50).done).toBe(true)
    expect(startCursor(0).done).toBe(true)
    expect(unloadedCount(c, 1000, 600)).toBe(400)
    expect(unloadedCount(startCursor(0), 1000, 600)).toBe(0)
  })
})
