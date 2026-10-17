import { describe, expect, test } from 'bun:test'
import { authEnforced, redactConfig, relayBase, tunnelStartProblem } from '../src/config.ts'

const oauth = {
  issuer: 'https://accounts.example.test',
  clientId: 'test-client',
  redirectUri: 'https://relay.example.test/oauth/callback',
}

describe('a fresh install', () => {
  test('has no sign-in, so no tunnel may open and no relay is named', () => {
    expect(authEnforced({})).toBe(false)
    expect(tunnelStartProblem({})).toBe('auth')
    expect(relayBase({})).toBeNull()
    expect(redactConfig({})).toMatchObject({ oauth: null, relay: { url: null, id: null } })
  })
})

describe('relayBase', () => {
  test('is relay.url when set, else the origin the OAuth callback returns to', () => {
    expect(relayBase({ oauth })).toBe('https://relay.example.test')
    expect(relayBase({ oauth, relay: { url: 'https://other.example.test/' } })).toBe(
      'https://other.example.test',
    )
    expect(relayBase({ oauth: { ...oauth, redirectUri: 'not a url' } })).toBeNull()
  })

  test('sign-in configured lets a tunnel open', () => {
    expect(authEnforced({ oauth })).toBe(true)
    expect(tunnelStartProblem({ oauth })).toBeNull()
  })
})
