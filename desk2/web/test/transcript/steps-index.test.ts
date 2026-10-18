import { describe, expect, test } from 'bun:test'
import { nextMessageStep, sentOverIndex } from '@/components/transcript/lib/steps'

// 1000 rows of 100px; every 4th is a message the person sent. The last 200 rows are loaded and measured.
const AVG = 100
const BASE = 20
const all = Array.from({ length: 1000 }, (_, p) => ({ id: `u${p}`, position: p })).filter((m) => m.position % 4 === 0)
const fullTops = all.map((m) => BASE + m.position * AVG)
const loadedFrom = 800
const loadedAll = all.filter((m) => m.position >= loadedFrom)
const loaded = { ids: loadedAll.map((m) => m.id), tops: loadedAll.map((m) => BASE + m.position * AVG) }
const over = sentOverIndex(loaded, all, AVG, BASE)

describe('sent messages over the index', () => {
  test('lists every message once, in order', () => {
    expect(over.ids).toEqual(all.map((m) => m.id))
    expect(over.tops).toEqual(fullTops)
  })
  test('steps land where the full array does, also at the window edge', () => {
    for (const scrollTop of [0, 5000, 79_900, 80_000, 80_020, 80_400, 99_000]) {
      for (const dir of ['up', 'down'] as const) {
        expect(nextMessageStep(over.tops, scrollTop, dir, 36)).toBe(nextMessageStep(fullTops, scrollTop, dir, 36))
      }
    }
  })
})
