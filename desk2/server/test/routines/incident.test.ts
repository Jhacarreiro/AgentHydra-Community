// routines/incident.ts - which routine outcomes open an incident and which resolve it. busy and interrupted
// runs are not failures, so they must touch no incident at all.
import { describe, expect, test } from 'bun:test'
import { routineBrokenMessage, routineIncidentAction } from '../../src/routines/incident'

const routine = { id: 'example-inbox', name: 'Example inbox' }

describe('routine outcome to incident (routines/incident.ts)', () => {
  test('a broken routine file names the routine, the reason, and the file to fix', () => {
    expect(routineBrokenMessage(routine, 'askedBy must be at most 500 characters')).toBe(
      'Example inbox: routine file is broken: askedBy must be at most 500 characters. Fix ~/.hydra-desk-2/routines/example-inbox.json',
    )
  })

  test('a failed or timed-out run opens the routine incident, with the run reason', () => {
    expect(routineIncidentAction(routine, { outcome: 'failed', lastLine: 'exit 1: no account has room' })).toEqual({
      kind: 'record',
      scope: 'routine',
      key: 'example-inbox',
      message: 'Example inbox: exit 1: no account has room',
    })
    expect(routineIncidentAction(routine, { outcome: 'timed-out', lastLine: 'timed out after 5 minutes' })).toMatchObject({
      kind: 'record',
      message: 'Example inbox: timed out after 5 minutes',
    })
  })

  test('a failed run with no last line still names its outcome', () => {
    expect(routineIncidentAction(routine, { outcome: 'failed', lastLine: '  ' })).toMatchObject({ message: 'Example inbox: failed' })
  })

  test('an ok run resolves the routine incident', () => {
    expect(routineIncidentAction(routine, { outcome: 'ok', lastLine: 'done' })).toEqual({ kind: 'resolve', scope: 'routine', key: 'example-inbox' })
  })

  test('busy, interrupted and waiting runs are not failures: no incident either way', () => {
    for (const outcome of ['busy', 'interrupted', 'waiting']) {
      expect(routineIncidentAction(routine, { outcome, lastLine: '' })).toBeNull()
    }
  })
})
