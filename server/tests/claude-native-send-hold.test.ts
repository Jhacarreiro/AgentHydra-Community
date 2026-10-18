import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNativeSendHold,
  type HoldSendResult,
  readHoldJournal,
} from '../src/claude-native-send-hold'

const req = {
  profileDir: 'C:/Users/me/.claude-instances/example',
  cliSessionId: 'session-1',
  text: 'hello',
  fromName: 'CliMayte',
}
const HOUR = 60 * 60 * 1000

/** A fake app: scripted send answers, a transcript that holds the refs it was given, and an idle flag. */
function app(answers: HoldSendResult[]) {
  const dir = mkdtempSync(join(tmpdir(), 'native-hold-'))
  const journalPath = join(dir, 'held-sends.json')
  const sent: string[] = []
  const transcript = new Set<string>()
  const state = { clock: 1_000, idle: true, ids: 0 }
  const engine = createNativeSendHold({
    journalPath,
    now: () => state.clock,
    newId: () => `id-${++state.ids}`,
    settleMs: 120_000,
    send: async (r) => {
      sent.push(r.text)
      const answer = answers.shift() ?? {
        ok: false,
        unavailable: true,
        reason: 'no answer scripted',
      }
      if (answer.delivery === 'delivered') transcript.add(r.text)
      return answer
    },
    transcriptHas: (_r, ref) => [...transcript].some((text) => text.includes(ref)),
    isIdle: async () => state.idle,
  })
  return { ...engine, sent, transcript, state, journalPath }
}

describe('native send hold', () => {
  it('holds a message while the chat is busy, then sends it once when idle', async () => {
    const a = app([
      { ok: false, unavailable: true, busy: true },
      { ok: true, unavailable: false, delivery: 'delivered' },
    ])
    expect(a.hold(req).delivery).toBe('held')
    await a.drain()
    expect(a.list()[0].state).toBe('held')
    expect(a.sent).toHaveLength(1)
    await a.drain()
    expect(a.list()[0].state).toBe('delivered')
    expect(a.sent).toHaveLength(2)
    expect(a.sent[1]).toContain('ref id-1')
    a.stop()
  })

  it('counts a queued answer as unconfirmed and settles it from the transcript, never resending', async () => {
    const a = app([{ ok: true, unavailable: false, delivery: 'queued' }])
    a.hold(req)
    await a.drain()
    expect(a.list()[0].state).toBe('unconfirmed')
    a.transcript.add(a.sent[0])
    a.state.clock += 120_000
    await a.drain()
    expect(a.list()[0].state).toBe('delivered')
    expect(a.sent).toHaveLength(1)
    a.stop()
  })

  it('does not settle an unconfirmed message before the app settle window or while the chat is busy', async () => {
    const a = app([{ ok: true, unavailable: false, delivery: 'queued' }])
    a.hold(req)
    await a.drain()
    a.state.clock += 60_000
    await a.drain()
    expect(a.list()[0].state).toBe('unconfirmed')
    a.state.clock += 120_000
    a.state.idle = false
    await a.drain()
    expect(a.list()[0].state).toBe('unconfirmed')
    expect(a.sent).toHaveLength(1)
    a.stop()
  })

  it('sends an absent message once more, then marks it not-arrived without a third send', async () => {
    const a = app([
      { ok: true, unavailable: false, delivery: 'queued' },
      { ok: true, unavailable: false, delivery: 'queued' },
    ])
    a.hold(req)
    await a.drain()
    a.state.clock += 120_000
    await a.drain()
    expect(a.sent).toHaveLength(2)
    expect(a.list()[0].state).toBe('unconfirmed')
    a.state.clock += 120_000
    await a.drain()
    expect(a.list()[0].state).toBe('not-arrived')
    expect(a.sent).toHaveLength(2)
    a.stop()
  })

  it('settles a send the daemon was stopped in from the transcript, not by a blind resend', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-hold-'))
    const journalPath = join(dir, 'held-sends.json')
    writeFileSync(
      journalPath,
      JSON.stringify([
        { id: 'id-1', ...req, state: 'sending', createdAt: 1, updatedAt: 1, attempts: 1 },
      ]),
    )
    const sent: string[] = []
    const hold = createNativeSendHold({
      journalPath,
      send: async (r) => {
        sent.push(r.text)
        return { ok: false, unavailable: true }
      },
      transcriptHas: () => false,
      isIdle: async () => true,
    })
    expect(readHoldJournal(journalPath)[0].state).toBe('unconfirmed')
    expect(sent).toHaveLength(0)
    hold.stop()
  })

  it('never sends a message held past the expiry', async () => {
    const a = app([])
    a.hold(req)
    a.state.clock += 25 * HOUR
    await a.drain()
    expect(a.sent).toHaveLength(0)
    expect(a.list()[0].state).toBe('expired')
    a.stop()
  })

  it('never sends a note held past its own time limit, long before the 24 h expiry', async () => {
    const a = app([])
    a.hold(req, 10 * 60 * 1000)
    a.state.clock += 11 * 60 * 1000
    await a.drain()
    expect(a.sent).toHaveLength(0)
    expect(a.list()[0].state).toBe('expired')
    a.stop()
  })

  it('settles a note the app refused as final, and never sends it again', async () => {
    const a = app([
      {
        ok: false,
        unavailable: true,
        refused: true,
        reason: 'NATIVE_REFUSAL: the chat is archived',
      },
    ])
    a.hold(req)
    await a.drain()
    expect(a.list()[0].state).toBe('not-arrived')
    expect(a.list()[0].reason).toBe('NATIVE_REFUSAL: the chat is archived')
    await a.drain()
    expect(a.sent).toHaveLength(1)
    a.stop()
  })

  it('sends a message held by an earlier daemon once its chat is idle, with no new hold', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-hold-'))
    const journalPath = join(dir, 'held-sends.json')
    writeFileSync(
      journalPath,
      JSON.stringify([
        {
          id: 'id-1',
          ...req,
          state: 'held',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          attempts: 0,
        },
      ]),
    )
    const sent: string[] = []
    const hold = createNativeSendHold({
      journalPath,
      intervalMs: 5,
      send: async (r) => {
        sent.push(r.text)
        return { ok: true, unavailable: false, delivery: 'delivered' }
      },
      transcriptHas: () => false,
      isIdle: async () => true,
    })
    for (let i = 0; i < 200 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    hold.stop()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('ref id-1')
  })

  it('does not send a held message whose attempt another daemon has already claimed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-hold-'))
    const journalPath = join(dir, 'held-sends.json')
    writeFileSync(
      journalPath,
      JSON.stringify([
        {
          id: 'id-1',
          ...req,
          state: 'held',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          attempts: 0,
        },
      ]),
    )
    // The other daemon took attempt 1 (its claim file exists) and has not yet written `sending`.
    mkdirSync(join(dir, 'claims'))
    writeFileSync(join(dir, 'claims', 'id-1.1.lock'), '')
    const sent: string[] = []
    const hold = createNativeSendHold({
      journalPath,
      intervalMs: HOUR,
      send: async (r) => {
        sent.push(r.text)
        return { ok: true, unavailable: false, delivery: 'delivered' }
      },
      transcriptHas: () => false,
      isIdle: async () => true,
    })
    await hold.drain()
    hold.stop()
    expect(sent).toHaveLength(0)
  })
})
