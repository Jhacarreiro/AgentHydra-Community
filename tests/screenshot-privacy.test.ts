import { describe, expect, test } from 'bun:test'
import { privateFindings } from '../scripts/screenshots/page-env.mjs'

// The last check before a README picture is taken: what it lets through is published. The values it must catch
// are put together here, so this file holds none of them for the public audit to find.
const address = ['person', 'company.dev'].join('@')
const winHome = ['C:', 'Users', 'jdoe', 'work'].join('\\')
const linuxHome = ['', 'home', 'runner', 'secret.txt'].join('/')
const anthropicKey = `${['sk', 'ant', 'api03'].join('-')}-${'x'.repeat(12)}`
const githubToken = `${'gh'}${'p_'}${'a'.repeat(30)}`

describe('privateFindings', () => {
  test('lets the fixtures’ invented values through', () => {
    const screen = [
      'Alex Rivera · alex@example.com',
      'sam.chen@mail.example.test',
      'Outside the allowed folders: /Users/me/Desktop/Project/acme-storefront',
      'C:/Users/me/Desktop/nexuscode-2d',
      'Codex chat from Studio PC, through the chat sync',
    ].join('\n')
    expect(privateFindings(screen)).toEqual([])
  })

  test('finds a real-looking address, home folder or key, and never repeats a key whole', () => {
    const screen = [
      `Signed in as ${address}`,
      `cwd: ${winHome}`,
      `opened ${linuxHome}`,
      `token ${anthropicKey}`,
      githubToken,
    ].join('\n')
    const found = privateFindings(screen)
    expect(found).toContain(`email: ${address}`)
    expect(found.some((f) => f.includes('jdoe'))).toBe(true)
    expect(found.some((f) => f.includes('runner'))).toBe(true)
    expect(found.filter((f) => f.startsWith('key:'))).toHaveLength(2)
    expect(found.join('\n')).not.toContain('x'.repeat(12))
  })
})
