import { expect, test } from 'bun:test'
import { dropSide, savedSidebarSide } from '../../src/components/sidebar/side'

test('a saved side reads back as right only when it says right', () => {
  expect(savedSidebarSide('right')).toBe('right')
  expect(savedSidebarSide('left')).toBe('left')
  expect(savedSidebarSide('top')).toBe('left')
  expect(savedSidebarSide('')).toBe('left')
  expect(savedSidebarSide(null)).toBe('left')
  expect(savedSidebarSide(undefined)).toBe('left')
})

test('a drop lands on the half of the window the pointer is in', () => {
  expect(dropSide(100, 1000)).toBe('left')
  expect(dropSide(499, 1000)).toBe('left')
  expect(dropSide(501, 1000)).toBe('right')
  expect(dropSide(900, 1000)).toBe('right')
})
