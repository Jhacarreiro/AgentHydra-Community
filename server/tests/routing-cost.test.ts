// Cost routing (docs/COST-MODEL.md): the fractions and windows per week from stored samples.
import { afterAll, expect, test } from 'bun:test'
import { db } from '../src/db'
import {
  anyDiscount,
  atYourRate,
  effectiveFraction,
  measuredWindowsPerWeek,
  providerGroup,
} from '../src/routing-cost'

const KEY = 'cli:test-routing-cost'
afterAll(() => {
  db.query('delete from usage_samples where key = ?').run(KEY)
})

test('effectiveFraction: a Pro plan at the research numbers is about 1.9% of list', () => {
  const f = effectiveFraction(20, 11.7, 1, 20.7)
  expect(f).toBeCloseTo(20 / (11.7 * 4.33 * 20.7), 10)
  expect(f).toBeGreaterThan(0.018)
  expect(f).toBeLessThan(0.02)
  // A Max 5x window is 4.75 Pro windows.
  expect(effectiveFraction(100, 9.8, 4.75, 20.7)).toBeCloseTo(0.024, 3)
})

test('atYourRate: a 20% anthropic discount takes 20% off a Claude model and leaves DeepSeek at list', () => {
  const d = { anthropic: 20, deepseek: 0, openrouter: 0, hosted: 0, other: 0 }
  expect(atYourRate('claude-opus-5-5', 10, d)).toBeCloseTo(8, 10)
  expect(atYourRate('deepseek-v4-example', 10, d)).toBe(10)
  expect(atYourRate('some-other-model', 10, d)).toBe(10)
  expect(anyDiscount(d)).toBe(true)
  expect(anyDiscount({ anthropic: 0, deepseek: 0, openrouter: 0, hosted: 0, other: 0 })).toBe(false)
})

test('a paid host is never priced as a free tier: its leg keeps its cost when free tiers are 100% off', () => {
  // The owner's setting (docs/COST-MODEL.md): free tiers 100, given credit 0. A DeepSeek model on Baseten is Baseten's
  // credit, not DeepSeek's and not a free tier, so a tool task on it is weighed against a subscription at list.
  const d = { anthropic: 0, deepseek: 0, openrouter: 100, hosted: 0, other: 100 }
  for (const host of ['baseten', 'together', 'grok_xai', 'rank:glm-5-3:together'])
    expect(providerGroup(host)).toBe('hosted')
  expect(atYourRate('baseten', 10, d)).toBe(10)
  expect(atYourRate('gemini', 10, d)).toBe(0)
  expect(providerGroup('rank:claude-opus-5-5-high:direct')).toBe('anthropic')
})

test('windowsPerWeek is the inverse of week-rise per session-rise, from stored samples', () => {
  db.query('delete from usage_samples where key = ?').run(KEY)
  const now = Date.now()
  const sessionReset = new Date(now + 3 * 3_600_000).toISOString()
  const weekReset = new Date(now + 3 * 86_400_000).toISOString()
  const ins = db.query(
    'insert into usage_samples (key, at, at_ms, session_pct, week_pct, week_resets_at, session_resets_at) values (?, ?, ?, ?, ?, ?, ?)',
  )
  // 50 samples 10 min apart: session +1 each step, week +0.1 each step => 10 session-% per week-%.
  for (let i = 0; i < 50; i++) {
    const t = now - (50 - i) * 600_000
    ins.run(KEY, new Date(t).toISOString(), t, i, 10 + i * 0.1, weekReset, sessionReset)
  }
  const got = measuredWindowsPerWeek([{ key: KEY, plan: 'Pro' }], now)
  expect(got.Pro.fellBack).toBe(false)
  expect(got.Pro.accounts).toBe(1)
  expect(got.Pro.value).toBeCloseTo(10, 5)
  // No account on the other plans: the research figures.
  expect(got['Max 5×']).toEqual({ value: 9.8, accounts: 0, fellBack: true })
  expect(got['Max 20×'].value).toBe(4.1)
})

test('an account with under 40 session points is ignored', () => {
  db.query('delete from usage_samples where key = ?').run(KEY)
  const now = Date.now()
  for (let i = 0; i < 10; i++) {
    const t = now - (10 - i) * 600_000
    db.query(
      'insert into usage_samples (key, at, at_ms, session_pct, week_pct, week_resets_at, session_resets_at) values (?, ?, ?, ?, ?, null, null)',
    ).run(KEY, new Date(t).toISOString(), t, i, i / 10)
  }
  expect(measuredWindowsPerWeek([{ key: KEY, plan: 'Pro' }], now).Pro.fellBack).toBe(true)
})
