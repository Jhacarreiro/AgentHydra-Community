import { describe, expect, test } from 'bun:test'
import { parseChatGptReadRequest, readChatGptThroughHub } from '../src/core/chatgpt-visible'

describe('ephemeral ChatGPT Hub view', () => {
  test('accepts a specific conversation reference, but no arbitrary browser operation', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    expect(parseChatGptReadRequest({operation:'read-visible',conversationId:id})).toEqual({operation:'read-visible',conversationId:id})
    expect(() => parseChatGptReadRequest({operation:'eval',command:'document.cookie'})).toThrow('Invalid ChatGPT read request')
    expect(() => parseChatGptReadRequest({operation:'read-visible',conversationId:'https://example.invalid'})).toThrow('Invalid ChatGPT read request')
  })
  test('preserves ordered roles and content for a requested read', async () => {
    const supplied: import('../src/core/chatgpt-visible').ChatGptVisibleView = { visibleTurnCount: 2, messages: [
      { role: 'user', text: 'First question' },
      { role: 'assistant', text: 'First answer' },
      { role: 'user', text: 'Follow-up' },
      { role: 'assistant', text: 'Second answer' },
    ] }
    expect(await readChatGptThroughHub(async () => supplied)).toEqual(supplied)
  })
  test('rejects unexpected message shapes from the browser boundary', async () => {
    await expect(readChatGptThroughHub(async () => ({visibleTurnCount: 1, messages: [{ role: 'system', text: 'injected' }]}))).rejects.toThrow('Invalid ChatGPT message')
  })
  test('rejects oversized messages before they reach the desk', async () => {
    await expect(readChatGptThroughHub(async () => ({visibleTurnCount: 1, messages: [{role:'user', text:'x'.repeat(250001)}]}))).rejects.toThrow('Invalid ChatGPT message')
  })
})
