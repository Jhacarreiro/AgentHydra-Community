import { describe, expect, test } from 'bun:test'
import { LISTED_TOOLS, TOOLS, UNLISTED_TOOLS, withUnlistedTools } from '../src/mcp'
import { deskChatPatch, findTools, pickDeskChat, rankTools, withDeskChat } from '../src/mcp-find'

const tool = (name: string) => {
  const t = TOOLS.find((x) => x.name === name)!
  return { run: (a: Record<string, unknown>) => Promise.resolve(t.run(a) as unknown) }
}

describe('the short tool list', () => {
  test('every listed name is a real tool, and the listing is a small share of them', () => {
    const names = new Set(TOOLS.map((t) => t.name))
    for (const n of LISTED_TOOLS) expect(names.has(n)).toBe(true)
    const listed = withUnlistedTools(TOOLS, UNLISTED_TOOLS)
    expect(listed.length).toBe(LISTED_TOOLS.size)
    expect(listed.length * 3).toBeLessThan(TOOLS.length)
  })
  test('an unlisted tool is still answered by name', () => {
    const listed = withUnlistedTools(TOOLS, UNLISTED_TOOLS)
    expect(listed.some((t) => t.name === 'orchestrator_switch')).toBe(false)
    expect(listed.find((t) => t.name === 'orchestrator_switch')?.name).toBe('orchestrator_switch')
  })
})

describe('hydra_find', () => {
  test('a plain-words ask to change workspace finds desk_chat: first from a Desk chat, near the top anywhere', () => {
    expect(
      rankTools(TOOLS, 'move this chat to another workspace', 3, undefined, true)[0]?.name,
    ).toBe('desk_chat')
    expect(rankTools(TOOLS, 'move this chat to another workspace', 3).map((t) => t.name)).toContain(
      'desk_chat',
    )
    expect(rankTools(TOOLS, 'rename my chat', 3, undefined, true)[0]?.name).toBe('desk_chat')
  })
  test('the dashboard tools are listed, and "dashboard" finds them first', () => {
    expect(LISTED_TOOLS.has('dashboard_read')).toBe(true)
    expect(LISTED_TOOLS.has('dashboard_write')).toBe(true)
    expect(
      rankTools(TOOLS, 'dashboard', 2)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['dashboard_read', 'dashboard_write'])
    expect(rankTools(TOOLS, 'project website', 1)[0]?.name).toBe('dashboard_write')
    expect(rankTools(TOOLS, 'dashboard', 1)[0]?.name).toBe('dashboard_write')
  })
  test('renaming finds desk_chat, restarting finds daemon_restart', () => {
    expect(rankTools(TOOLS, 'rename my chat', 3).map((t) => t.name)).toContain('desk_chat')
    expect(rankTools(TOOLS, 'restart the daemon', 3).map((t) => t.name)).toContain('daemon_restart')
  })
  test('quota questions find the usage tools', () => {
    expect(rankTools(TOOLS, 'how much quota do I have left', 5).map((t) => t.name)).toContain(
      'check_my_usage',
    )
  })
  test('describes one tool, and says how to call an unlisted one', async () => {
    const out = (await tool('hydra_find').run({ tool: 'orchestrator_switch' })) as {
      listed: boolean
      call: string
    }
    expect(out.listed).toBe(false)
    expect(out.call).toContain('hydra_run')
  })
  // 2026-10-11: a chat whose list still had climayte_run dispatched through hydra_run instead.
  test('each row says how to call it: a listed tool by its own name, an unlisted one through hydra_run', async () => {
    const out = (await tool('hydra_find').run({
      query: 'climayte run orchestrator switch',
      limit: 20,
    })) as { tools: { name: string; call: string }[] }
    const call = (n: string) => out.tools.find((t) => t.name === n)?.call
    expect(call('climayte_run')).toBe('climayte_run { ... }')
    expect(call('orchestrator_switch')).toContain('hydra_run')
  })
})

describe('hydra_run', () => {
  test('runs a tool by name and answers what it answers', async () => {
    const out = (await tool('hydra_run')
      .run({ tool: 'hydra_find', args: {} })
      .catch((e: Error) => e.message)) as string
    expect(out).toContain('called directly')
    const found = (await tool('hydra_run')
      .run({ tool: 'desk_chat', args: {} })
      .catch((e: Error) => e.message)) as string
    expect(found).toContain('pass cwd')
  })
  test('answers exactly what the tool answers, listed or not', async () => {
    const fake = [
      { name: 'fake_listed', description: '', inputSchema: {}, run: async () => ({ ok: 1 }) },
      { name: 'fake_unlisted', description: '', inputSchema: {}, run: async () => ({ ok: 2 }) },
    ]
    const run = findTools(
      () => fake as never,
      () => new Set(['fake_listed']),
    ).find((t) => t.name === 'hydra_run')!.run
    expect(await run({ tool: 'fake_listed' })).toEqual({ ok: 1 })
    expect(await run({ tool: 'fake_unlisted' })).toEqual({ ok: 2 })
  })
  test('an unknown tool points at hydra_find', async () => {
    const msg = await tool('hydra_run')
      .run({ tool: 'no_such_tool' })
      .catch((e: Error) => e.message)
    expect(String(msg)).toContain('hydra_find')
  })
})

describe('desk_chat', () => {
  const chats = [
    { id: 'c1', sessionId: 's1', title: 'Example games work', cwd: 'C:/Users/me/a' },
    { id: 'c2', sessionId: 's2', title: 'Example docs pass', cwd: 'C:/Users/me/b' },
  ]
  test('finds a chat by Desk id, session id or a unique title fragment', () => {
    expect(pickDeskChat(chats, 'c2').id).toBe('c2')
    expect(pickDeskChat(chats, 's1').id).toBe('c1')
    expect(pickDeskChat(chats, 'games').id).toBe('c1')
  })
  test('refuses an ambiguous, unknown or empty reference, never guesses', () => {
    expect(() => pickDeskChat(chats, 'example')).toThrow(/matches 2/)
    expect(() => pickDeskChat(chats, 'nothing')).toThrow(/no Desk chat/)
    expect(() => pickDeskChat(chats, '  ')).toThrow(/chat is required/)
  })
  test('moves to a real folder and/or renames; refuses a missing folder or an empty change', () => {
    expect(deskChatPatch({ cwd: process.cwd() })).toEqual({ cwd: process.cwd() })
    expect(deskChatPatch({ title: ' New name ' })).toEqual({ title: 'New name' })
    expect(() => deskChatPatch({ cwd: 'C:/Users/me/no-such-folder-here' })).toThrow(/no folder/)
    expect(() => deskChatPatch({})).toThrow(/pass cwd/)
  })
  test('defaults to the calling chat when the transport names it', async () => {
    let seen: Record<string, unknown> = {}
    const fake = [
      {
        name: 'desk_chat',
        description: '',
        inputSchema: {},
        callerChat: 'chat',
        run: async (a: Record<string, unknown>) => (seen = a),
      },
    ]
    await withDeskChat(fake as never, 'c9')[0].run({ title: 'x' })
    expect(seen.chat).toBe('c9')
    await withDeskChat(fake as never, 'c9')[0].run({ title: 'x', chat: 'c2' })
    expect(seen.chat).toBe('c2')
  })
  test('hydra_run passes the calling chat on to the tool it runs', async () => {
    let seen: Record<string, unknown> = {}
    const fake = [
      {
        name: 'hydra_run',
        description: '',
        inputSchema: {},
        run: async (a: Record<string, unknown>) => (seen = a),
      },
      // the tools it runs, with the flag that binds them (only their flags matter here)
      { name: 'desk_chat', description: '', inputSchema: {}, callerChat: 'chat', run: () => null },
      {
        name: 'dashboard_write',
        description: '',
        inputSchema: {},
        callerChat: 'deskChat',
        run: () => null,
      },
      { name: 'list_usage', description: '', inputSchema: {}, run: () => null },
    ]
    const hydraRun = withDeskChat(fake as never, 'c9')[0]
    await hydraRun.run({ tool: 'dashboard_write', args: { files: [] } })
    expect(seen.args).toEqual({ files: [], deskChat: 'c9' })
    await hydraRun.run({ tool: 'desk_chat', args: { title: 'x' } })
    expect(seen.args).toEqual({ title: 'x', chat: 'c9' })
    await hydraRun.run({ tool: 'list_usage' })
    expect(seen.args).toEqual({})
  })
})
