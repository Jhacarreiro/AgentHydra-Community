// server/src/incidents.ts - resolveIncidentsFor: a routine's ok run closes its open incident(s) whatever
// error they were opened with, and leaves every other routine's incident alone.
import { afterAll, beforeEach, expect, test } from 'bun:test'

// Scratch home before anything touches the db (same pattern as incidents.test.ts).
const scratch = `${process.env.TEMP ?? '/tmp'}/agenthydra-incidents-key-test-${crypto.randomUUID()}`
process.env.AGENTHYDRA_HOME = scratch

const { db } = await import('../src/db')
const { getIncident, recordIncident, resolveIncidentsFor } = await import('../src/incidents')

beforeEach(() => {
  db.exec('delete from incidents')
})

afterAll(() => {
  try {
    require('node:fs').rmSync(scratch, { recursive: true, force: true })
  } catch {
    // scratch dir cleanup is best-effort
  }
})

test("resolveIncidentsFor closes the routine's open incidents, whatever their error, and no other routine's", async () => {
  const first = await recordIncident({
    scope: 'routine',
    key: 'example-inbox',
    error: 'Example inbox: exit 1',
  })
  const second = await recordIncident({
    scope: 'routine',
    key: 'example-inbox',
    error: 'Example inbox: timed out',
  })
  const other = await recordIncident({
    scope: 'routine',
    key: 'example-other',
    error: 'Example other: exit 1',
  })
  const elsewhere = await recordIncident({ scope: 'queue', key: 'example-inbox', error: 'boom' })

  expect(resolveIncidentsFor('routine', 'example-inbox')).toBe(2)
  expect(getIncident(first.id)?.state).toBe('resolved')
  expect(getIncident(second.id)?.state).toBe('resolved')
  expect(getIncident(other.id)?.state).toBe('open')
  expect(getIncident(elsewhere.id)?.state).toBe('open')
})

test('resolveIncidentsFor on a key with nothing open resolves nothing', () => {
  expect(resolveIncidentsFor('routine', 'example-none')).toBe(0)
})
