import { expect, test } from 'bun:test'
import { chatAction, focusAction, modeAction } from '../../src/components/sidebar/collapse'

test('automatic mode folds the window when AgentHydra leaves the front', () => {
  expect(focusAction({ mode: 'auto', collapsed: false, focused: false, busy: false })).toBe('collapse')
})

test('a focus loss during a pointer press waits for the release', () => {
  expect(focusAction({ mode: 'auto', collapsed: false, focused: false, busy: true })).toBe('wait')
})

test('automatic mode unfolds when AgentHydra comes back to the front', () => {
  expect(focusAction({ mode: 'auto', collapsed: true, focused: true, busy: false })).toBe('expand')
})

test('the window is never moved by focus in button or off mode', () => {
  for (const mode of ['off', 'button'] as const) {
    expect(focusAction({ mode, collapsed: false, focused: false, busy: false })).toBe('nothing')
    expect(focusAction({ mode, collapsed: true, focused: true, busy: false })).toBe('nothing')
  }
})

test('a chat opened while folded brings the window back', () => {
  expect(chatAction({ mode: 'button', collapsed: true })).toBe('expand')
  expect(chatAction({ mode: 'auto', collapsed: true })).toBe('expand')
  expect(chatAction({ mode: 'button', collapsed: false })).toBe('nothing')
  expect(chatAction({ mode: 'off', collapsed: true })).toBe('nothing')
})

test('turning the mode off while folded unfolds the window', () => {
  expect(modeAction({ mode: 'off', collapsed: true })).toBe('expand')
  expect(modeAction({ mode: 'button', collapsed: true })).toBe('nothing')
  expect(modeAction({ mode: 'off', collapsed: false })).toBe('nothing')
})
