import { describe, expect, test } from 'bun:test'
import {
  BRIDGE_SESSION,
  bridgeBase,
  ChatGptBridgeError,
  createChatGptBridge,
} from '../src/core/chatgpt-bridge'
import {
  parseConversation,
  parseConversationList,
  turnState,
} from '../src/core/chatgpt-conversation'

const ID = '11111111-2222-3333-4444-555555555555'
const NEW = '66666666-7777-8888-9999-000000000000'
const now = 1_800_000_000_000
const msg = (id: string, role: string, extra: Record<string, unknown> = {}) => ({
  id,
  author: { role },
  recipient: 'all',
  status: 'finished_successfully',
  create_time: now / 1000 - 30,
  content: { content_type: 'text', parts: [`${role} ${id}`] },
  ...extra,
})
function conversation(messages: Record<string, unknown>[]) {
  const mapping: Record<string, unknown> = { root: { parent: null, message: null } }
  let parent = 'root'
  for (const m of messages) {
    mapping[m.id as string] = { parent, message: m }
    parent = m.id as string
  }
  return { conversation_id: ID, title: 'Example chat', current_node: parent, mapping }
}

describe('ChatGPT conversations', () => {
  test('lists conversations and drops entries without a real id', () => {
    expect(
      parseConversationList({
        items: [
          { id: ID, title: 'Example', update_time: '2026-10-20T10:00:00Z' },
          { id: 'javascript:alert(1)', title: 'x' },
        ],
      }),
    ).toEqual([{ id: ID, title: 'Example', updatedAt: '2026-10-20T10:00:00Z' }])
    expect(() => parseConversationList({})).toThrow('Invalid ChatGPT conversation list')
  })

  test('keeps the visible messages of the current branch, oldest first', () => {
    const view = parseConversation(
      conversation([
        msg('u1', 'user'),
        msg('t1', 'assistant', { content: { content_type: 'thoughts' } }),
        msg('c1', 'assistant', { recipient: 'web.run' }),
        msg('tool', 'tool'),
        msg('h1', 'user', { metadata: { is_visually_hidden_from_conversation: true } }),
        msg('a1', 'assistant', { end_turn: true }),
      ]),
      now,
    )
    expect(view.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'user u1'],
      ['assistant', 'assistant a1'],
    ])
    expect(view.state).toBe('idle')
    expect(view.title).toBe('Example chat')
  })

  test('tells thinking, writing, stopped and answered apart', () => {
    const user = msg('u1', 'user')
    expect(turnState([user], now)).toBe('thinking')
    expect(turnState([{ ...user, create_time: now / 1000 - 3600 }], now)).toBe('stopped')
    expect(
      turnState(
        [
          user,
          msg('t', 'assistant', { status: 'in_progress', content: { content_type: 'thoughts' } }),
        ],
        now,
      ),
    ).toBe('thinking')
    expect(turnState([user, msg('a', 'assistant', { status: 'in_progress' })], now)).toBe(
      'generating',
    )
    expect(turnState([user, msg('a', 'assistant', { end_turn: true })], now)).toBe('idle')
    expect(
      turnState(
        [user, msg('a', 'assistant', { end_turn: true, status: 'finished_partial_completion' })],
        now,
      ),
    ).toBe('stopped')
    expect(turnState([], now)).toBe('idle')
  })

  test('rejects a conversation without a real id', () => {
    expect(() => parseConversation({ ...conversation([]), conversation_id: '../x' })).toThrow(
      'Invalid ChatGPT conversation',
    )
  })
})

type Sent = {
  action: string
  session: string
  code?: string
  text?: string
  url?: string
  page?: string
}
function fakeDaemon(answer: (body: Sent) => unknown) {
  const sent: Sent[] = []
  const fetcher = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Sent
    expect((init.headers as Record<string, string>)['x-opencli']).toBe('1')
    sent.push(body)
    return Response.json({
      ok: true,
      data: answer(body),
      page: body.action === 'navigate' ? 'P1' : undefined,
    })
  }
  return {
    sent,
    bridge: createChatGptBridge(fetcher, () => new URL('http://bridge.example.test:19825')),
  }
}
const tabs = [{ page: 'P1', url: 'https://chatgpt.com/', active: true }]

describe('ChatGPT browser bridge', () => {
  test('only takes a plain http address for the daemon', () => {
    expect(bridgeBase(undefined).toString()).toBe('http://127.0.0.1:19825/')
    expect(bridgeBase('http://host.docker.internal:19825').hostname).toBe('host.docker.internal')
    expect(() => bridgeBase('file:///etc/passwd')).toThrow()
    expect(() => bridgeBase('http://user:pw@example.test:1/')).toThrow()
  })

  test('reads in the page with its own sign-in and returns no token', async () => {
    const { sent, bridge } = fakeDaemon((b) =>
      b.action === 'tabs'
        ? tabs
        : JSON.stringify({
            body: {
              ...conversation([msg('u1', 'user'), msg('a1', 'assistant', { end_turn: true })]),
              busy: false,
            },
          }),
    )
    const view = await bridge.read(ID)
    expect(view.messages).toHaveLength(2)
    expect(view.state).toBe('idle')
    const exec = sent.find((s) => s.action === 'exec')!
    expect(exec.session).toBe(BRIDGE_SESSION)
    expect(exec.code).toContain(`https://chatgpt.com/backend-api/conversation/${ID}`)
    expect(JSON.stringify(view)).not.toContain('accessToken')
  })

  test('a conversation ChatGPT is still answering in the window reads as writing', async () => {
    const { bridge } = fakeDaemon((b) =>
      b.action === 'tabs'
        ? tabs
        : JSON.stringify({
            body: {
              ...conversation([msg('u1', 'user'), msg('a1', 'assistant', { end_turn: true })]),
              busy: true,
            },
          }),
    )
    expect((await bridge.read(ID)).state).toBe('generating')
  })

  test('reports a signed-out window and refuses ids that are not conversation ids', async () => {
    const { sent, bridge } = fakeDaemon((b) =>
      b.action === 'tabs' ? tabs : JSON.stringify({ signedOut: true }),
    )
    await expect(bridge.list()).rejects.toMatchObject({ code: 'CHATGPT_SIGNED_OUT' })
    const before = sent.length
    await expect(bridge.read('"); alert(1); ("')).rejects.toBeInstanceOf(ChatGptBridgeError)
    expect(sent.length).toBe(before)
  })

  test('opens a ChatGPT window when the bridge has none', async () => {
    const { sent, bridge } = fakeDaemon((b) =>
      b.action === 'tabs' ? [] : JSON.stringify({ body: { items: [] } }),
    )
    expect(await bridge.list()).toEqual([])
    expect(sent.find((s) => s.action === 'navigate')?.url).toBe('https://chatgpt.com/')
  })

  test('sends the text through the composer, never inside page code, and returns a new chat id', async () => {
    let path = '/'
    let typed = 0
    const text = 'Hello "there"\n`; alert(1)'
    const { sent, bridge } = fakeDaemon((b) => {
      if (b.action === 'tabs') return tabs
      if (b.action === 'insert-text') {
        typed = b.text!.length
        return { inserted: true }
      }
      if (b.action === 'navigate') return {}
      const code = b.code!
      if (code.includes('selectAll')) return 'ready'
      if (code.includes('innerText.trim().length')) return typed
      if (code.includes('send-button')) {
        path = `/c/${NEW}`
        return true
      }
      if (code.includes('location.pathname')) return path
      return null
    })
    expect(await bridge.send(null, text)).toEqual({ id: NEW })
    expect(sent.filter((s) => s.action === 'insert-text').map((s) => s.text)).toEqual([text])
    expect(sent.some((s) => s.code?.includes('alert(1)'))).toBe(false)
    expect(sent.filter((s) => s.code?.includes('send-button'))).toHaveLength(1)
  })

  test('stops only the conversation the window has open', async () => {
    const { bridge } = fakeDaemon((b) => (b.action === 'tabs' ? tabs : '/'))
    await expect(bridge.stop(ID)).rejects.toMatchObject({ code: 'CHATGPT_NOT_OPEN' })
  })
})
