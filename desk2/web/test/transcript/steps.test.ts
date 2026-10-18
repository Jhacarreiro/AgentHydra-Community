import { expect, test } from 'bun:test'
import { nextMessageStep, stepTarget } from '../../src/components/transcript/lib/steps'

// The transcript's step arrows (owner, 2026-10-09): each click on the up arrow goes one message the person sent
// further back, each on the down arrow one further on, and past the last one there is no step (the arrow then goes
// to the bottom). Messages sit at these tops; a step lands one 50 px under the view's top.
const tops = [100, 900, 2000]
const line = 50

test('up walks back one sent message per click and down walks forward, never landing twice on one', () => {
  let at = 3000 // reading the newest output, below every message
  const walk = (dir: 'up' | 'down') => {
    const landed: number[] = []
    for (let i = nextMessageStep(tops, at, dir, line); i !== null; i = nextMessageStep(tops, at, dir, line)) {
      landed.push(i)
      at = stepTarget(tops[i]!, line)
    }
    return landed
  }
  expect(walk('up')).toEqual([2, 1, 0])
  expect(at).toBe(50)
  expect(walk('down')).toEqual([1, 2])
  expect(at).toBe(1950)
  // Between two messages, up goes to the one above the view and down to the one below it.
  expect(nextMessageStep(tops, 1200, 'up', line)).toBe(1)
  expect(nextMessageStep(tops, 1200, 'down', line)).toBe(2)
  // A message near the top lands at 0 and is still a step; nothing sent means no step either way.
  expect(stepTarget(20, line)).toBe(0)
  expect(nextMessageStep([20], 400, 'up', line)).toBe(0)
  expect(nextMessageStep([], 400, 'up', line)).toBeNull()
})
