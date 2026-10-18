// The From of a CliMayte task: a chat, a worker that dispatched it, or none (climayte-from.ts).
import { expect, test } from 'bun:test'
import { climayteFrom } from './climayte-from'

const base = {
  group: 'CF1',
  originSessionId: null,
  originWorkerId: null,
  originTitle: null,
  originLabel: null,
}
const tasks = [{ id: 'w-1', title: 'CF1 code pass U29' }]

test('a chat origin is the chat title, or its short session id when the title is unknown', () => {
  expect(
    climayteFrom({ ...base, originSessionId: 'sess-abcdef123', originTitle: 'Example chat' }, tasks),
  ).toEqual({ kind: 'chat', sessionId: 'sess-abcdef123', label: 'Example chat' })
  expect(climayteFrom({ ...base, originSessionId: 'sess-abcdef123' }, tasks)).toEqual({
    kind: 'chat',
    sessionId: 'sess-abcdef123',
    label: 'sess-abc',
  })
})

test('a worker origin is that worker’s title, or its id while that worker is not loaded', () => {
  const from = { ...base, originSessionId: 'sess-w1', originWorkerId: 'w-1' }
  expect(climayteFrom(from, tasks)).toEqual({ kind: 'worker', workerId: 'w-1', label: 'CF1 code pass U29' })
  expect(climayteFrom(from, [])).toEqual({ kind: 'worker', workerId: 'w-1', label: 'w-1' })
})

// A process that dispatched it and is no chat: its script's folder and file, or what it declared.
test('a process trace is its label, and a declared label beside a chat keeps the chat title', () => {
  expect(climayteFrom({ ...base, originLabel: 'michaiel/act.py' }, tasks)).toEqual({
    kind: 'process',
    label: 'michaiel/act.py',
  })
  expect(
    climayteFrom({ ...base, originSessionId: 'sess-abcdef123', originTitle: 'Example chat', originLabel: 'CreAItor' }, tasks),
  ).toEqual({ kind: 'chat', sessionId: 'sess-abcdef123', label: 'Example chat' })
})

// A task recorded before traces has no dispatcher fact at all: its group is what the From shows.
test('no trace at all shows the group, never Not traced', () => {
  expect(climayteFrom(base, tasks)).toEqual({ kind: 'group', group: 'CF1' })
})
