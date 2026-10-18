import { describe, expect, test } from 'bun:test'
import { canRunRoutine, jobOfRoutine, managerDot, routineDot, workerOfRoutine } from './managers'

describe('a routine\'s work', () => {
  test('a CliMayte worker belongs to the routine when its group begins with the id and a dash', () => {
    expect(workerOfRoutine('routine-example-routine-202610120857', 'example-routine')).toBe(true)
    // A group that only shares the id's letters is someone else's work.
    expect(workerOfRoutine('routine-example-routinex-202610120857', 'example-routine')).toBe(false)
    expect(workerOfRoutine('other-routine-example-routine-x', 'example-routine')).toBe(false)
  })

  test('an HSwarm job belongs to the routine when its label begins with the id', () => {
    expect(jobOfRoutine('example-routine-swarm', 'example-routine')).toBe(true)
    expect(jobOfRoutine('swarm-example-routine', 'example-routine')).toBe(false)
    expect(jobOfRoutine(null, 'example-routine')).toBe(false)
    expect(jobOfRoutine(undefined, 'example-routine')).toBe(false)
  })
})

describe('the dots', () => {
  test('a routine state maps to its dot', () => {
    expect(routineDot('running')).toBe('run')
    expect(routineDot('due')).toBe('warn')
    expect(routineDot('waiting')).toBe('warn')
    expect(routineDot('idle')).toBe('ok')
    expect(routineDot('paused')).toBe('off')
    expect(routineDot('off')).toBe('off')
    expect(routineDot('ended')).toBe('off')
    expect(routineDot('broken')).toBe('bad')
  })

  test('a manager reads red when its read failed, even before it said whether it is on', () => {
    expect(managerDot(true, true)).toBe('bad')
    expect(managerDot(undefined, false)).toBeUndefined()
    expect(managerDot(false, false)).toBe('off')
    expect(managerDot(true, false)).toBe('ok')
  })
})

describe('Run now', () => {
  test('only an idle or due routine that is not already being run can be ticked', () => {
    expect(canRunRoutine('idle', false)).toBe(true)
    expect(canRunRoutine('due', false)).toBe(true)
    expect(canRunRoutine('running', false)).toBe(false)
    expect(canRunRoutine('paused', false)).toBe(false)
    expect(canRunRoutine('ended', false)).toBe(false)
    expect(canRunRoutine('waiting', false)).toBe(false)
    expect(canRunRoutine('off', false)).toBe(false)
    expect(canRunRoutine('broken', false)).toBe(false)
    expect(canRunRoutine('idle', true)).toBe(false)
  })
})
