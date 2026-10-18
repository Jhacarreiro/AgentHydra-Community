// manager_open, manager_ask and manager_read refuse what they cannot do before they reach the Desk window.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANAGER_TOOLS, managerName, replyWhenDone } from '../src/mcp-managers'

const tool = (name: string) => {
  const t = MANAGER_TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return (a: Record<string, unknown>) =>
    (t.run as (x: Record<string, unknown>) => Promise<unknown>)(a)
}

let dir = ''
const oldDir = process.env.AGENTHYDRA_MANAGERS_DIR
const oldChat = process.env.HYDRA_DESK_CHAT_ID

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-managers-'))
  process.env.AGENTHYDRA_MANAGERS_DIR = dir
  delete process.env.HYDRA_DESK_CHAT_ID
  mkdirSync(join(dir, 'example-manager'))
  writeFileSync(
    join(dir, 'example-manager', 'persona.json'),
    JSON.stringify({ slug: 'example-manager', name: 'Example Manager' }),
  )
  mkdirSync(join(dir, 'nameless'))
  writeFileSync(join(dir, 'nameless', 'persona.json'), JSON.stringify({ slug: 'nameless' }))
})

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  if (oldDir === undefined) delete process.env.AGENTHYDRA_MANAGERS_DIR
  else process.env.AGENTHYDRA_MANAGERS_DIR = oldDir
  if (oldChat === undefined) delete process.env.HYDRA_DESK_CHAT_ID
  else process.env.HYDRA_DESK_CHAT_ID = oldChat
})

describe('manager_open refuses', () => {
  it('a call that is not from a Desk chat', async () => {
    await expect(
      tool('manager_open')({ manager: 'example-manager', prompt: 'hi' }),
    ).rejects.toThrow('not a Desk chat')
  })
  it('a slug that is not a manager slug', async () => {
    await expect(
      tool('manager_open')({ deskChat: 'chat-1', manager: '../evil', prompt: 'hi' }),
    ).rejects.toThrow('not a manager slug')
  })
  it('a manager with no persona.json', async () => {
    await expect(
      tool('manager_open')({ deskChat: 'chat-1', manager: 'ghost', prompt: 'hi' }),
    ).rejects.toThrow('no manager "ghost"')
  })
  it('a persona with no name', async () => {
    await expect(
      tool('manager_open')({ deskChat: 'chat-1', manager: 'nameless', prompt: 'hi' }),
    ).rejects.toThrow('has no name')
  })
  it('an empty prompt', async () => {
    await expect(
      tool('manager_open')({ deskChat: 'chat-1', manager: 'example-manager', prompt: '  ' }),
    ).rejects.toThrow('prompt is required')
  })
})

describe('manager_ask and manager_read refuse', () => {
  it('an empty message', async () => {
    await expect(tool('manager_ask')({ chat: 'chat-1', message: '' })).rejects.toThrow(
      'message is required',
    )
  })
})

describe('the persona name', () => {
  it('is read from the managers folder', () => {
    expect(managerName('example-manager')).toBe('Example Manager')
  })
  it('is refused for a path-like slug', () => {
    expect(() => managerName('../example-manager')).toThrow('not a manager slug')
  })
})

describe('a Desk chat pinned to a manager', () => {
  it('carries a manager slug in its add-ons, and anything else is refused', async () => {
    const { deskProblem } = await import('../src/climayte-dispatch')
    const desk = { append: 'Desk text.', mcpServers: {} }
    expect(deskProblem({ ...desk, manager: 'example-manager' }, true)).toBeNull()
    expect(deskProblem(desk, true)).toBeNull()
    expect(deskProblem({ ...desk, manager: '../evil' }, true)).toContain(
      'desk.manager must be a manager slug',
    )
    expect(deskProblem({ ...desk, manager: 7 }, true)).toContain(
      'desk.manager must be a manager slug',
    )
  })
  it('carries its own Desk chat id, and anything else is refused', async () => {
    const { deskProblem } = await import('../src/climayte-dispatch')
    const desk = { append: 'Desk text.', mcpServers: {} }
    expect(
      deskProblem({ ...desk, chatId: '00a6da4c-8d2f-4c21-ac6b-602437bc0b74' }, true),
    ).toBeNull()
    expect(deskProblem({ ...desk, chatId: '../evil' }, true)).toContain(
      'desk.chatId must be a Desk chat id',
    )
    expect(deskProblem({ ...desk, chatId: 7 }, true)).toContain(
      'desk.chatId must be a Desk chat id',
    )
  })
})

describe('replyWhenDone after a sent message', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function desk(polls: { status: string; items: { kind: string; text?: string }[] }[]) {
    let n = 0
    globalThis.fetch = (async (url: string | URL | Request) => {
      const p = polls[Math.min(n, polls.length - 1)]
      const body = String(url).endsWith('/transcript') ? p.items : [{ id: 'c1', status: p.status }]
      if (String(url).endsWith('/transcript')) n++
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
  }

  it('waits through an idle first poll that has only the prompt, then answers the reply', async () => {
    desk([
      { status: 'idle', items: [{ kind: 'user', text: 'q' }] },
      {
        status: 'idle',
        items: [
          { kind: 'user', text: 'q' },
          { kind: 'assistant_text', text: 'the answer' },
        ],
      },
    ])
    const r = await replyWhenDone({ id: 'c1', title: 'Seat' }, 0, 10)
    expect(r.status).toBe('done')
    expect(r.reply).toBe('the answer')
  })

  it('answers working, not an empty done, when no reply ever arrives', async () => {
    desk([{ status: 'idle', items: [{ kind: 'user', text: 'q' }] }])
    const r = await replyWhenDone({ id: 'c1', title: 'Seat' }, 0, 1)
    expect(r.status).toBe('working')
  })

  it('a resend to an idle seat ignores the earlier reply until a new one lands', async () => {
    const old = [
      { kind: 'user', text: 'old q' },
      { kind: 'assistant_text', text: 'old answer' },
    ]
    desk([
      { status: 'idle', items: [...old, { kind: 'user', text: 'new q' }] },
      {
        status: 'idle',
        items: [
          ...old,
          { kind: 'user', text: 'new q' },
          { kind: 'assistant_text', text: 'new answer' },
        ],
      },
    ])
    const r = await replyWhenDone({ id: 'c1' }, 2, 10)
    expect(r.reply).toBe('new answer')
  })
})
