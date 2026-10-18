import { describe, expect, it } from 'bun:test'
import { nextSusLevel, susStatus } from '@/components/composer/sus'

const MODELS = [{ value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }]

describe('nextSusLevel', () => {
  it('moves right and down through Fine, Sus, Bad, and wraps', () => {
    expect(nextSusLevel('fine', 'ArrowRight')).toBe('sus')
    expect(nextSusLevel('sus', 'ArrowDown')).toBe('bad')
    expect(nextSusLevel('bad', 'ArrowRight')).toBe('fine')
  })

  it('moves left and up, and wraps', () => {
    expect(nextSusLevel('fine', 'ArrowLeft')).toBe('bad')
    expect(nextSusLevel('bad', 'ArrowUp')).toBe('sus')
  })

  it('ignores every other key', () => {
    expect(nextSusLevel('sus', 'Enter')).toBeNull()
    expect(nextSusLevel('sus', 'a')).toBeNull()
  })
})

describe('susStatus', () => {
  it('fine shows the model the chat runs on, muted, with no tip', () => {
    expect(susStatus('fine', 'Sonnet 5.5', null, MODELS, null)).toEqual({ text: 'Sonnet 5.5', tone: 'muted', tip: null })
  })

  it('sus shows the pick with its pushback share once a setting has enough turns', () => {
    const pick = { model: 'claude-haiku-4-5-20251001', effort: null, pushbackRate: 0.02, turns: 41 }
    const status = susStatus('sus', 'Sonnet 5.5', pick, MODELS, null)
    expect(status.text).toBe('Haiku 4.5 · 2% pushback')
    expect(status.tone).toBe('sus')
    expect(status.tip).toContain('41 counted turns')
  })

  it('sus with no pick says it is still learning, with a tooltip', () => {
    const status = susStatus('sus', 'Sonnet 5.5', null, MODELS, null)
    expect(status.text).toBe('Sus · learning')
    expect(status.tip).toBe('Uses the normal model until a setting has 20 counted turns.')
  })

  it('bad says it routes to Codex, whatever the model', () => {
    expect(susStatus('bad', 'Sonnet 5.5', null, MODELS, 'Codex')).toEqual({ text: 'Routing to Codex', tone: 'bad', tip: null })
  })

  it('a chat pinned to another service shows that service in place of the model', () => {
    expect(susStatus('fine', 'Sonnet 5.5', null, MODELS, 'ChatGPT')).toEqual({ text: 'ChatGPT', tone: 'muted', tip: null })
  })
})
