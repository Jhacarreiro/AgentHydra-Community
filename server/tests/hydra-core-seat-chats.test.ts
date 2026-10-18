import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatPaths } from '../src/hydra-core/paths'
import { addSeatChat, forgetChat, readSeatChats } from '../src/hydra-core/seat-chats'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hydra-core-seat-chats-'))
})
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function folder(chat: string, seats?: Record<string, { chat: string; title: string }>): string {
  const p = chatPaths(dir, chat)
  mkdirSync(p.root, { recursive: true })
  writeFileSync(p.hydraMd, '# hydra\n')
  if (seats) writeFileSync(p.seats, JSON.stringify(seats))
  return p.root
}

test('a deleted seat leaves no core folder, no seat-chats.json entry and no place in its Prime roster', () => {
  folder('chat-prime', {
    'person:iris-ui': { chat: 'chat-seat-1', title: 'Iris' },
    'person:ops-lead': { chat: 'chat-seat-2', title: 'Ops' },
  })
  const seat = folder('chat-seat-1')
  addSeatChat(dir, 'chat-seat-1', 'person:iris-ui', 'chat-prime')
  addSeatChat(dir, 'chat-seat-2', 'person:ops-lead', 'chat-prime')
  forgetChat(dir, 'chat-seat-1')
  expect(existsSync(seat)).toBe(false)
  expect(readSeatChats(dir)).toEqual({
    'chat-seat-2': { persona: 'person:ops-lead', parent: 'chat-prime' },
  })
  expect(JSON.parse(readFileSync(chatPaths(dir, 'chat-prime').seats, 'utf8'))).toEqual({
    'person:ops-lead': { chat: 'chat-seat-2', title: 'Ops' },
  })
})

test('a deleted Prime leaves no core folder; a key that is no chat key touches nothing', () => {
  const prime = folder('chat-prime')
  forgetChat(dir, 'chat-prime')
  expect(existsSync(prime)).toBe(false)
  forgetChat(dir, '..')
  expect(existsSync(dir)).toBe(true)
})
