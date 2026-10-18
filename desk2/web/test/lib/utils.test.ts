import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { cn } from '../../src/lib/utils'

// The type-scale steps style.css's @theme blocks declare (each --text-<step>, not a --line-height sub-key).
const theme = readFileSync(new URL('../../src/style.css', import.meta.url), 'utf8')
const steps = [...theme.matchAll(/@theme[^{]*\{([^}]*)\}/g)]
  .flatMap((block) => [...block[1].matchAll(/--text-([\w-]+?)\s*:/g)].map((m) => m[1]))
  .filter((step) => !step.includes('--'))

// Contract: cn() keeps a text colour beside every step of the type scale, and still lets a later size replace an
// earlier one; a step added to the theme without its entry in lib/utils.ts fails here. Regression: 2026-10-13,
// tailwind-merge read text-ui, text-ui-sm and text-ui-lg as colours, so cn('text-text-muted', 'text-ui') returned
// 'text-ui' and the text lost its colour.
test('cn keeps the colour beside every type-scale step, and a later size wins', () => {
  expect(steps).toEqual(expect.arrayContaining(['3xs', '2xs', 'ui-sm', 'ui', 'ui-lg']))
  for (const step of steps) {
    expect(cn('text-text-muted', `text-${step}`)).toBe(`text-text-muted text-${step}`)
    expect(cn('text-sm', `text-${step}`)).toBe(`text-${step}`)
  }
})
