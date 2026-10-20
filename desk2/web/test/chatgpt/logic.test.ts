import { describe, expect, test } from 'bun:test'
import { ago, errorWords, nextReadMs, running } from '@/components/chatgpt/logic'

describe('ChatGPT screen', () => {
  test('reads often only while ChatGPT works or a message was just sent', () => {
    const now = 1_000_000
    expect(nextReadMs('thinking', null, now)).toBe(2_000)
    expect(nextReadMs('generating', null, now)).toBe(2_000)
    expect(nextReadMs('idle', now - 5_000, now)).toBe(2_000)
    expect(nextReadMs('idle', now - 120_000, now)).toBe(20_000)
    expect(nextReadMs(undefined, null, now)).toBe(20_000)
    expect(running('stopped')).toBe(false)
  })
  test('says why it failed in words', () => {
    expect(errorWords('CHATGPT_SIGNED_OUT')).toContain('signed out')
    expect(errorWords('whatever')).toBe('ChatGPT is temporarily unavailable.')
  })
  test('says how long ago', () => {
    const now = Date.parse('2026-10-20T12:00:00Z')
    expect(ago('2026-10-20T11:55:00Z', now)).toBe('5 min')
    expect(ago('2026-10-20T09:00:00Z', now)).toBe('3 h')
    expect(ago(null, now)).toBe('')
  })
})
