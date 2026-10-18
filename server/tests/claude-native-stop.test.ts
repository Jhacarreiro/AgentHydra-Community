// The native stop runs inside Claude Desktop's main process; here the shipped expression runs against a stand-in of
// that process (its module cache holding a session manager), so what it would call in the app is what is checked.
import { expect, test } from 'bun:test'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import { runInNewContext } from 'node:vm'
import { nativeProgram } from '../src/core/claude-native/native-program'

const CLI = '0b6f2b0e-1111-4c4c-9a9a-123456789abc'
const PID = 4242
const appPath = path.resolve('/example-app/resources/app')
const profileDir = path.resolve('/Users/me/.claude-instances/example')

/** A desktop app whose one chat (`local_a`, CLI id CLI) has `session`; `onInterrupt` is the app's own
 *  interruptSession, so a test decides what the app's state shows after the call. */
function desktop(
  session: Record<string, unknown>,
  onInterrupt: (s: Record<string, any>) => void | Promise<void> = (s) => {
    s.isStopping = true
  },
) {
  const calls: { id: string; reason: string }[] = []
  const chat: Record<string, any> = {
    sessionId: 'local_a',
    cliSessionId: CLI,
    isArchived: false,
    isRunning: true,
    ...session,
  }
  const manager = {
    sessions: new Map([['local_a', chat]]),
    currentAccountId: 'acct',
    currentOrgId: 'org',
    userDataPath: profileDir,
    waitForInitialization: async () => {},
    getSessionList: async () => [],
    archiveSession: async () => {},
    archiveCascadeClosureOf: () => [],
    losableWorkKind: () => null,
    startingSessionIds: new Set<string>(),
    hasPendingUserInput: () => false,
    localLineageIds: () => [],
    interruptSession: async (id: string, reason: string) => {
      calls.push({ id, reason })
      await onInterrupt(chat)
    },
  }
  const file = path.join(appPath, 'index.chunk-example.js')
  const appRequire = Object.assign(
    (name: string) => (name === 'node:fs' ? { readFileSync: () => 'bundle' } : crypto),
    { cache: { [file]: { loaded: true, exports: { claudeCodeSessionManager: manager } } } },
  )
  const app = {
    getAppPath: () => appPath,
    isReady: () => true,
    getPath: () => profileDir,
    getVersion: () => '1.0.0',
  }
  const rootRequire = (name: string) =>
    name === 'electron'
      ? { app }
      : name === 'node:path'
        ? path
        : { createRequire: () => appRequire }
  const fakeProcess = { pid: PID, platform: process.platform, mainModule: { require: rootRequire } }
  const stop = (request: { profileDir?: string; cliSessionId?: string } = {}) =>
    runInNewContext(
      nativeProgram({
        action: 'stop',
        pid: PID,
        profileDir: request.profileDir ?? profileDir,
        cliSessionId: request.cliSessionId ?? CLI,
      }),
      {
        process: fakeProcess,
        setTimeout,
        clearTimeout,
      },
    ) as Promise<any>
  return { calls, chat, stop }
}

test("a working chat is stopped through the app's own interruptSession, once, and verified by its state", async () => {
  const app = desktop({})
  const stopped = await app.stop()
  expect(stopped).toMatchObject({
    ok: true,
    verified: true,
    dispatch: 'sent',
    action: 'stop',
    sessionId: 'local_a',
  })
  expect(app.calls).toEqual([{ id: 'local_a', reason: 'user' }])
})

test('a chat whose turn is already stopping, or that has no running turn, is refused before the app is called', async () => {
  const idle = desktop({ isRunning: false })
  expect(await idle.stop()).toMatchObject({ ok: false, refused: true, dispatch: 'not-sent' })
  expect(idle.calls).toEqual([])

  const stopping = desktop({ isStopping: true })
  expect(await stopping.stop()).toMatchObject({ ok: false, refused: true, dispatch: 'not-sent' })
  expect(stopping.calls).toEqual([])

  const archived = desktop({ isArchived: true })
  expect(await archived.stop()).toMatchObject({ ok: false, refused: true, dispatch: 'not-sent' })
  expect(archived.calls).toEqual([])
})

test('a wrong profile or a session id no chat holds is refused, and nothing is called', async () => {
  const app = desktop({})
  expect(
    await app.stop({ profileDir: path.resolve('/Users/me/.claude-instances/other') }),
  ).toMatchObject({ ok: false, refused: true, dispatch: 'not-sent' })
  expect(await app.stop({ cliSessionId: '11111111-2222-4333-8444-555555555555' })).toMatchObject({
    ok: false,
    refused: true,
    dispatch: 'not-sent',
    reason: expect.stringContaining('no chat in this app holds this CLI session'),
  })
  expect(app.calls).toEqual([])
})

test('a stop the app does not show stopping or stopped is reported unverified, and is never sent again', async () => {
  // The app answers but its state does not change: not verified, and the one call is not retried.
  const unchanged = desktop({}, () => {})
  const quiet = await unchanged.stop()
  expect(quiet).toMatchObject({ ok: false, verified: false, dispatch: 'sent' })
  expect(unchanged.calls).toHaveLength(1)

  // The call throws after it was made: the dispatch is 'sent' (not unavailable), nothing else is tried.
  const thrown = desktop({}, () => {
    throw new Error('renderer went away')
  })
  expect(await thrown.stop()).toMatchObject({
    ok: false,
    dispatch: 'sent',
    reason: expect.stringContaining('renderer went away'),
  })
  expect(thrown.calls).toHaveLength(1)
})
