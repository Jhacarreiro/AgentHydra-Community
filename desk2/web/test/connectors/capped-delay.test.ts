import { describe, expect, test } from 'bun:test'
import { cappedDelay } from '../../src/components/connectors/logic'

describe('cappedDelay', () => {
  test('a fast poll falls back to the slow pace once the answer has not changed for a minute', () => {
    expect(cappedDelay(1000, 59_999)).toBe(1000)
    expect(cappedDelay(1000, 60_000)).toBe(5000)
  })

  test('a delay already at or above the slow pace is never shortened', () => {
    expect(cappedDelay(30_000, 600_000)).toBe(30_000)
  })
})
