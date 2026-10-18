// Who dispatched a CliMayte worker, as ids and a chat's title (climayte-origin.ts), for the queue and the list.
import { describe, expect, test } from 'bun:test'
import { NO_ORIGIN_LOOKUP, originFields } from '../src/climayte-origin'

const lookup = {
  sessionOf: (workerId: string) => (workerId === 'w-1' ? 'sess-w1' : null),
  titleOf: (sessionId: string) => (sessionId === 'sess-chat' ? 'Example chat' : null),
}

describe('originFields', () => {
  test('a chat origin: its session and the cached title', () => {
    expect(
      originFields(
        { kind: 'chat', sessionId: 'sess-chat', home: '', transcript: '', how: 'x' } as never,
        lookup,
      ),
    ).toEqual({
      originSessionId: 'sess-chat',
      originWorkerId: null,
      originTitle: 'Example chat',
      originLabel: null,
    })
  })

  test('a worker origin: its worker id and that worker session, no title', () => {
    expect(originFields({ kind: 'worker', workerId: 'w-1' }, lookup)).toEqual({
      originSessionId: 'sess-w1',
      originWorkerId: 'w-1',
      originTitle: null,
      originLabel: null,
    })
  })

  test('no origin and no trace: all null (a worker recorded before traces)', () => {
    expect(originFields(undefined, lookup)).toEqual({
      originSessionId: null,
      originWorkerId: null,
      originTitle: null,
      originLabel: null,
    })
  })

  // Without a ping origin the From reads the trace: a chat's title, a worker, or a process's label.
  test('no ping origin: the trace names the chat (with its title), the worker or the process', () => {
    expect(originFields(undefined, lookup, { sessionId: 'sess-chat' })).toEqual({
      originSessionId: 'sess-chat',
      originWorkerId: null,
      originTitle: 'Example chat',
      originLabel: null,
    })
    expect(originFields(undefined, lookup, { workerId: 'w-1' }).originSessionId).toBe('sess-w1')
    expect(originFields(undefined, lookup, { label: 'michaiel/act.py' })).toEqual({
      originSessionId: null,
      originWorkerId: null,
      originTitle: null,
      originLabel: 'michaiel/act.py',
    })
  })

  test('a declared label and chat with no ping origin: the chat is named and the label kept', () => {
    expect(
      originFields(undefined, lookup, { sessionId: 'sess-chat', label: 'CreAItor' }),
    ).toMatchObject({
      originSessionId: 'sess-chat',
      originTitle: 'Example chat',
      originLabel: 'CreAItor',
    })
  })

  test('a ping origin is what the From names; the trace only adds a label', () => {
    const chat = {
      kind: 'chat',
      sessionId: 'sess-chat',
      home: '',
      transcript: '',
      how: 'x',
    } as never
    expect(originFields(chat, lookup, { sessionId: 'sess-other' }).originSessionId).toBe(
      'sess-chat',
    )
    expect(originFields(chat, lookup, { label: 'CreAItor' }).originLabel).toBe('CreAItor')
  })

  test('without lookups a chat keeps its id and a worker keeps its id', () => {
    expect(originFields({ kind: 'worker', workerId: 'w-1' }, NO_ORIGIN_LOOKUP).originWorkerId).toBe(
      'w-1',
    )
    expect(
      originFields({
        kind: 'chat',
        sessionId: 'sess-chat',
        home: '',
        transcript: '',
        how: 'x',
      } as never).originSessionId,
    ).toBe('sess-chat')
  })
})
