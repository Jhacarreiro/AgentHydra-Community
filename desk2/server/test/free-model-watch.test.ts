import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FreeInstance } from '@shared/free-instances'
import { ModelWatch } from '../src/free-instances/models'

const homes: string[] = []
const home = () => { const h = mkdtempSync(join(tmpdir(), 'desk-free-watch-')); homes.push(h); return h }
afterAll(() => { for (const h of homes) if (h) rmSync(h, { recursive: true, force: true }) })

function account(n: number, slugs: string[], roles: Record<string, string> = {}): FreeInstance {
  return { id: `i${n}`, num: n, provider: 'chatgpt', name: `Example ${n}`, loggedIn: true,
    usage: { available: true, is_snapshot: false, observed_at: null, note: '', windows: [], models: slugs.map(slug => ({ slug, title: 'GPT-6.1', reasoning: 'none' })), roles } } as unknown as FreeInstance
}

describe('free model watch', () => {
  test('the first run seeds silently; a new slug notifies once with its account count; the same set is quiet', () => {
    const dir = home()
    const watch = new ModelWatch(dir)
    const base = ['gpt-6', 'gpt-6-mini']
    expect(watch.check([account(1, base), account(2, base)])).toBeNull()
    expect(existsSync(join(dir, 'free', 'models-seen.json'))).toBe(true)
    const next = [...base, 'gpt-6-1-mini']
    const notice = watch.check([account(1, next, { 'gpt-instant': 'gpt-6-1-mini' }), account(2, next)])
    expect(notice?.title).toBe('ChatGPT lists a new model')
    expect(notice?.body).toContain('gpt-6-1-mini')
    expect(notice?.body).toContain('2 ChatGPT accounts')
    expect(notice?.body).toContain('gpt-instant = gpt-6-1-mini')
    expect(notice?.body).toContain('hswarm models --free')
    expect(watch.check([account(1, next), account(2, next)])).toBeNull()
    expect(new ModelWatch(dir).check([account(1, next)])).toBeNull()
  })
  test('a slug that leaves every account is dropped and notifies again when it returns', () => {
    const watch = new ModelWatch(home())
    watch.check([account(1, ['gpt-6'])])
    expect(watch.check([account(1, ['gpt-6', 'gpt-6-1']), account(2, ['gpt-6'])])?.body).toContain('1 ChatGPT account')
    expect(watch.check([account(1, ['gpt-6'])])).toBeNull()
    expect(watch.check([account(1, ['gpt-6', 'gpt-6-1'])])?.body).toContain('gpt-6-1')
  })
})
