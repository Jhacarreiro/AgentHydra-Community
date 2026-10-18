import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { cn } from './utils'

// The type-scale steps kit-base.css's @theme blocks declare (each --text-<step>, not a --line-height sub-key).
const theme = readFileSync(new URL('../styles/kit-base.css', import.meta.url), 'utf8')
const steps = [...theme.matchAll(/@theme[^{]*\{([^}]*)\}/g)]
  .flatMap((block) => [...block[1].matchAll(/--text-([\w-]+?)\s*:/g)].map((m) => m[1]))
  .filter((step) => !step.includes('--'))

// Contract: cn() keeps a text colour beside every step of the type scale, and still lets a later size replace an
// earlier one; a step added to the theme without its entry in lib/utils.ts fails here. Regression: 2026-10-13,
// tailwind-merge read text-ui as a colour, so cn('text-muted-foreground', 'text-ui') returned 'text-ui' and the text
// lost its colour.
test('cn keeps the colour beside every type-scale step, and a later size wins', () => {
  expect(steps).toEqual(expect.arrayContaining(['3xs', '2xs', 'ui']))
  for (const step of steps) {
    expect(cn('text-muted-foreground', `text-${step}`)).toBe(`text-muted-foreground text-${step}`)
    expect(cn('text-sm', `text-${step}`)).toBe(`text-${step}`)
  }
})
