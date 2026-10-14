// server/src/cloud-sessions.ts + the claude-cloud foreign adapter - which logins can read the cloud
// session list, what a listed session means for "waiting on you", and that one sync pass leaves a
// cache the adapter reads back and status rows the session list shows.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// db.ts opens the file on import, so the scratch home has to be in place first.
const scratch = `${process.env.TEMP ?? '/tmp'}/agenthydra-cloud-sessions-test-${crypto.randomUUID()}`
process.env.AGENTHYDRA_HOME = scratch

const { db } = await import('../src/db')
const { getAgentStatus } = await import('../src/agent-status')
const { cliCloudAccount, cloudAccounts, cloudStatusEvent, syncCloudSessions, toCloudRow } =
  await import('../src/cloud-sessions')
const { readForeignSession, listForeignSessions } = await import('../src/foreign-sessions')

const NOW = Date.parse('2026-01-01T12:00:00.000Z')
const ORG = '00000000-0000-4000-8000-000000000001'

function login(
  dir: string,
  oauth: Record<string, unknown>,
  userConfig = join(dir, '.claude.json'),
) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }))
  writeFileSync(userConfig, JSON.stringify({ oauthAccount: { organizationUuid: ORG } }))
}

const live = {
  accessToken: 'test-token',
  expiresAt: NOW + 3_600_000,
  scopes: ['user:inference', 'user:sessions:claude_code'],
}

beforeEach(() => {
  db.exec('delete from agent_status')
})

afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // scratch cleanup is best-effort
  }
})

describe('accounts', () => {
  test('a live login with the sessions scope is an account', () => {
    const dir = join(scratch, 'login-ok')
    login(dir, live)
    expect(cliCloudAccount(dir, join(dir, '.claude.json'), NOW)).toEqual({
      key: `org-${ORG}`,
      token: 'test-token',
      orgUuid: ORG,
    })
  })

  test('an expired token or one without the sessions scope is skipped', () => {
    const expired = join(scratch, 'login-expired')
    login(expired, { ...live, expiresAt: NOW - 1 })
    expect(cliCloudAccount(expired, join(expired, '.claude.json'), NOW)).toBeNull()
    const narrow = join(scratch, 'login-narrow')
    login(narrow, { ...live, scopes: ['user:inference'] })
    expect(cliCloudAccount(narrow, join(narrow, '.claude.json'), NOW)).toBeNull()
  })

  test('a setup token in the environment is used, and a second login to the same org is not', () => {
    const home = join(scratch, 'home-env')
    login(join(home, '.claude'), live, join(home, '.claude.json'))
    const accounts = cloudAccounts([], { CLAUDE_CODE_OAUTH_TOKEN: 'setup-token' }, home)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.token).toBe('setup-token')
  })
})

describe('status', () => {
  const row = (over: Record<string, unknown>) => {
    const r = toCloudRow({
      id: 'cse_1',
      last_event_at: '2026-01-01T11:00:00.000Z',
      status_bucket: 'completed',
      worker_status: 'idle',
      unread: false,
      ...over,
    })
    if (!r) throw new Error('row rejected')
    return r
  }

  test('a running turn is working whatever its bucket', () => {
    expect(cloudStatusEvent(row({ worker_status: 'running', unread: true })).event).toBe(
      'cloud-working',
    )
  })

  test('an unread reply or a blocked bucket waits on the person', () => {
    expect(cloudStatusEvent(row({ unread: true }))).toMatchObject({
      event: 'cloud-blocked',
      notificationType: 'unread',
    })
    expect(cloudStatusEvent(row({ status_bucket: 'blocked' }))).toMatchObject({
      event: 'cloud-blocked',
      notificationType: 'input',
    })
  })

  test('a Project thread waits on its bucket alone, since its unread flag never clears', () => {
    const tags = ['hearth-thread']
    expect(cloudStatusEvent(row({ tags, unread: true })).event).toBe('cloud-done')
    expect(
      cloudStatusEvent(row({ tags, unread: true, status_bucket: 'review_ready' })),
    ).toMatchObject({ event: 'cloud-blocked', notificationType: 'review' })
  })

  test('a read, finished session is done', () => {
    expect(cloudStatusEvent(row({})).event).toBe('cloud-done')
  })
})

describe('sync', () => {
  const account = { key: `org-${ORG}`, token: 'test-token', orgUuid: ORG }
  const page = (data: unknown[]) =>
    new Response(JSON.stringify({ data, next_cursor: null }), { status: 200 })
  const sessions = [
    {
      id: 'cse_waiting',
      title: 'Example task',
      environment_kind: 'anthropic_cloud',
      status_bucket: 'review_ready',
      worker_status: 'idle',
      unread: true,
      last_event_at: '2026-01-01T11:00:00.000Z',
    },
    {
      id: 'cse_bridge',
      title: 'Example remote task',
      environment_kind: 'bridge',
      status_bucket: 'completed',
      worker_status: 'idle',
      unread: false,
      last_event_at: '2026-01-01T10:00:00.000Z',
    },
  ]

  test('falls through a host that does not serve the list, then caches and records status', async () => {
    const root = join(scratch, 'cache-1')
    const asked: string[] = []
    const fetchFn = async (url: string) => {
      asked.push(new URL(url).host)
      return url.startsWith('https://first.example.test')
        ? new Response('{}', { status: 404 })
        : page(sessions)
    }
    const out = await syncCloudSessions({
      accounts: () => [account],
      root,
      bases: ['https://first.example.test', 'https://second.example.test'],
      fetchFn,
      live: false,
    })
    // The second host answers both the default list and the tagged one.
    expect(asked).toEqual(['first.example.test', 'second.example.test', 'second.example.test'])
    expect(out.get(account.key)?.map((r) => r.id)).toEqual(['cse_waiting', 'cse_bridge'])
    expect(getAgentStatus('cse_waiting')).toMatchObject({ state: 'blocked', waiting: 'unread' })
    expect(getAgentStatus('cse_bridge')?.state).toBe('done')

    const listed = listForeignSessions('claude-cloud', root)
    expect(listed.map((s) => [s.session_id, s.project])).toEqual([
      ['cse_waiting', 'claude-cloud'],
      ['cse_bridge', 'claude-remote-control'],
    ])
  })

  test('a refused token is not retried on the next host and leaves existing rows alone', async () => {
    const root = join(scratch, 'cache-2')
    await syncCloudSessions({
      accounts: () => [account],
      root,
      bases: ['https://ok.example.test'],
      fetchFn: async () => page(sessions),
      live: false,
    })
    const asked: string[] = []
    await syncCloudSessions({
      accounts: () => [account],
      root,
      bases: ['https://a.example.test', 'https://b.example.test'],
      fetchFn: async (url: string) => {
        asked.push(new URL(url).host)
        return new Response('{}', { status: 401 })
      },
      live: false,
    })
    expect(asked).toEqual(['a.example.test'])
    expect(getAgentStatus('cse_waiting')?.state).toBe('blocked')
  })

  test('tagged sessions come from a second query, and a refused tagged query costs only them', async () => {
    const root = join(scratch, 'cache-4')
    const project = {
      id: 'cse_project',
      title: 'Example project thread',
      environment_kind: 'anthropic_cloud',
      status_bucket: 'blocked',
      worker_status: 'idle',
      unread: true,
      last_event_at: '2026-01-01T11:30:00.000Z',
      tags: ['hearth-thread'],
    }
    const opts = {
      accounts: () => [account],
      root,
      bases: ['https://ok.example.test'],
      live: false,
    }
    const out = await syncCloudSessions({
      ...opts,
      fetchFn: async (url: string) =>
        new URL(url).searchParams.getAll('tags').includes('hearth-thread')
          ? page([project, sessions[0]])
          : page(sessions),
    })
    expect(out.get(account.key)?.map((r) => r.id)).toEqual([
      'cse_waiting',
      'cse_bridge',
      'cse_project',
    ])
    expect(getAgentStatus('cse_project')).toMatchObject({ state: 'blocked', waiting: 'input' })
    expect(
      listForeignSessions('claude-cloud', root).find((s) => s.session_id === 'cse_project')
        ?.project,
    ).toBe('claude-projects')

    const refused = await syncCloudSessions({
      ...opts,
      fetchFn: async (url: string) =>
        new URL(url).searchParams.has('tags')
          ? new Response('{}', { status: 400 })
          : page(sessions),
    })
    expect(refused.get(account.key)?.map((r) => r.id)).toEqual(['cse_waiting', 'cse_bridge'])
  })

  test('a session that left the list loses its status row', async () => {
    const root = join(scratch, 'cache-3')
    const opts = {
      accounts: () => [account],
      root,
      bases: ['https://ok.example.test'],
      live: false,
    }
    await syncCloudSessions({ ...opts, fetchFn: async () => page(sessions) })
    await syncCloudSessions({ ...opts, fetchFn: async () => page(sessions.slice(1)) })
    expect(getAgentStatus('cse_waiting')).toBeNull()
    expect(getAgentStatus('cse_bridge')).not.toBeNull()
  })
})

describe('adapter', () => {
  test('reads streamed SDK messages as turns and skips what is not a turn', () => {
    const file = join(scratch, 'events.jsonl')
    const lines = [
      { type: 'user', created_at: '2026-01-01T10:00:00Z', message: { content: 'Fix the build' } },
      {
        type: 'assistant',
        uuid: 'u-1',
        created_at: '2026-01-01T10:00:05Z',
        message: {
          content: [
            { type: 'text', text: 'Running the tests.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
          ],
        },
      },
      { type: 'system', subtype: 'status' },
    ]
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"type":"assis`)
    const events = readForeignSession('claude-cloud', file)
    expect(events.map((e) => [e.role, e.kind, e.tool_name])).toEqual([
      ['user', 'text', null],
      ['assistant', 'text', null],
      ['assistant', 'tool_use', 'Bash'],
    ])
    expect(events[1]?.uuid).toBe('u-1')
  })

  test('a session with no event file reads as empty', () => {
    expect(readForeignSession('claude-cloud', join(scratch, 'missing.jsonl'))).toEqual([])
  })
})
