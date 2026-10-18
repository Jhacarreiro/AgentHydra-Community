// The routines MCP tool (server/src/mcp-routines.ts): the agent may read, run, pause and propose, and nothing else. The
// owner's rules are in the description the agent reads, so these tests pin the arguments and the words, not a live Desk.

import { describe, expect, test } from 'bun:test'
import { ROUTINES_TOOLS } from '../server/src/mcp-routines'

const tool = ROUTINES_TOOLS.find((t) => t.name === 'routines')
const schema = tool?.inputSchema as {
  properties: Record<string, { description?: string }>
  additionalProperties: boolean
}

describe('the routines tool arguments', () => {
  test('the tool is named routines, and takes only fresh, run, pause and propose', () => {
    expect(tool).toBeDefined()
    expect(Object.keys(schema.properties).sort()).toEqual(['fresh', 'pause', 'propose', 'run'])
    expect(schema.additionalProperties).toBe(false)
  })

  test('the owner-only actions are not arguments of the agent tool', () => {
    for (const name of ['enabled', 'resume', 'approve', 'discard'])
      expect(schema.properties[name]).toBeUndefined()
  })

  test('each mutating argument is marked MUTATES, and fresh is not', () => {
    expect(schema.properties.run.description?.startsWith('MUTATES:')).toBe(true)
    expect(schema.properties.pause.description?.startsWith('MUTATES:')).toBe(true)
    expect(schema.properties.propose.description?.startsWith('MUTATES:')).toBe(true)
    expect(schema.properties.fresh.description).not.toContain('MUTATES')
  })

  test('the propose argument asks for id, why and the contract', () => {
    const d = schema.properties.propose.description ?? ''
    expect(d).toContain('id')
    expect(d).toContain('why')
    expect(d).toContain('windowsTask')
    expect(d).toContain('askedBy')
  })
})

describe('the routines tool description', () => {
  test("carries the owner's standing note: nothing an agent may add on its own, and proposals wait for the owner's yes", () => {
    const d = tool?.description ?? ''
    expect(d).toContain('never schedule anything the owner did not ask for')
    expect(d).toContain('propose')
    expect(d).toContain('Settings > Managers > Routines')
    expect(d).toContain('temporary background task')
  })

  test("says that resume, approve and discard are the owner's alone", () => {
    expect(tool?.description).toContain("Resume, approve and discard are the owner's alone")
  })
})
