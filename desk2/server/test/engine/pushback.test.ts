// Pushback tracking (SPEC "Sus meter"): the classifier, the per-setting counts and their file, the backfill, the sus pick.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@shared/protocol'
import { classifyTurn, PUSHBACK_PHRASES, PushbackStore, SUS_MIN_TURNS } from '../../src/engine/pushback'

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'desk-pushback-'))
  temps.push(d)
  return d
}

describe('classifyTurn', () => {
  test('a refusal stop reason is a refusal whatever the text says', () => {
    expect(classifyTurn('refusal', 'Done, the file is written.')).toEqual({ cls: 'refusal', label: 'stop_reason refusal' })
  })

  test.each([
    "I can't help with that.",
    'I cannot assist with changing the production server.',
    "I won't help with this one.",
    "I'm not comfortable running that against your live database.",
    'Are you sure you want to continue?',
    "I'd strongly recommend against pasting the token into the script.",
    'I must decline.',
    'Your API key in that file is risky, so I would not paste it anywhere.',
    'Please confirm before I proceed with the cleanup.',
    'I only did part of it because the rest touches your production database, which is too risky.',
    'For security reasons I left the token out of the config.',
    'Do you want me to go ahead and run the migration?',
  ])('%s is a pushback', (text) => {
    expect(classifyTurn('end_turn', text).cls).toBe('pushback')
  })

  test('is case-insensitive', () => {
    expect(classifyTurn('end_turn', 'I CAN’T HELP with this.')).toEqual({ cls: 'pushback', label: "can't help" })
  })

  test.each([
    'Done. Note that this deletes the old build folder, which the next build recreates.',
    'The tests pass. Be careful with force pushes on shared branches.',
    'I fixed the bug; the key is read from the environment, so nothing is stored in the repo.',
    'You can help yourself to the script in C:/Users/me/proj/run.ts.',
    'This will need a restart of the dev server to take effect.',
    'Heads up: the build takes about two minutes, and the cache is cleared first.',
    '',
  ])('a normal caveat stays clean: %j', (text) => {
    expect(classifyTurn('end_turn', text)).toEqual({ cls: 'clean', label: null })
  })

  test('the phrase list is one exported list of patterns', () => {
    expect(PUSHBACK_PHRASES.length).toBeGreaterThan(5)
  })
})

describe('PushbackStore', () => {
  const a = { service: 'claude', model: 'model-a', effort: 'high' } as const
  const b = { service: 'claude', model: 'model-b', effort: 'low' } as const

  test('counts per setting, answers rates and survives a restart', () => {
    const home = temp()
    const s = new PushbackStore(home)
    s.record(a, 'clean')
    s.record(a, 'pushback', { chat: 'c1', label: 'are you sure' })
    s.record(a, 'refusal')
    s.record(b, 'clean')
    expect(s.rows().find((r) => r.model === 'model-a')).toEqual({ ...a, turns: 3, pushback: 1, refusals: 1, pushbackRate: 1 / 3 })
    expect(new PushbackStore(home).rows()).toEqual(s.rows())
    // Each turn that was not clean keeps its matched label for auditing.
    expect(new PushbackStore(home).auditLog().map((x) => [x.cls, x.label, x.chat])).toEqual([['pushback', 'are you sure', 'c1'], ['refusal', null, null]])
  })

  test('the pick needs the minimum turns, takes the lowest rate, and ignores refusals and other services', () => {
    const s = new PushbackStore(temp())
    expect(SUS_MIN_TURNS).toBe(20)
    for (let i = 0; i < 19; i++) s.record(b, 'clean')
    expect(s.pick()).toBeNull()
    for (let i = 0; i < 20; i++) s.record(a, i < 4 ? 'pushback' : 'clean')
    expect(s.pick()?.model).toBe('model-a')
    s.record(b, 'clean')
    expect(s.pick()).toMatchObject({ model: 'model-b', pushbackRate: 0, turns: 20 })
    // Refusals do not count against a setting's rate.
    for (let i = 0; i < 21; i++) s.record({ service: 'claude', model: 'model-c', effort: 'low' }, 'refusal')
    expect(s.pick()?.model).toBe('model-c')
    for (let i = 0; i < 40; i++) s.record({ service: 'codex', model: 'gpt', effort: 'low' }, 'clean')
    expect(s.pick()?.service).toBe('claude')
  })

  test('the backfill counts a chat transcript once, whatever runs it again', () => {
    const home = temp()
    const items = [
      { kind: 'assistant_text', id: '1', ts: 1, text: 'All done.' },
      { kind: 'result', id: 'r1', ts: 2, ok: true, durationMs: 1, costUsd: 0, turns: 1 },
      { kind: 'assistant_text', id: '2', ts: 3, text: "I can't help with that." },
      { kind: 'result', id: 'r2', ts: 4, ok: true, durationMs: 1, costUsd: 0, turns: 2 },
    ] as TranscriptItem[]
    const chats = [{ id: 'chat-1', model: null, effort: 'high', items: () => items }]
    const s = new PushbackStore(home)
    expect(s.backfill(chats)).toEqual({ chats: 1, turns: 2 })
    expect(s.rows()).toEqual([{ service: 'claude', model: 'default', effort: 'high', turns: 2, pushback: 1, refusals: 0, pushbackRate: 0.5 }])
    expect(s.backfill(chats)).toEqual({ chats: 0, turns: 0 })
    expect(new PushbackStore(home).backfill(chats)).toEqual({ chats: 0, turns: 0 })
    expect(new PushbackStore(home).rows()[0]!.turns).toBe(2)
  })
})
