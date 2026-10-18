import { afterEach, expect, test } from 'bun:test'
import type { RoutinesRequest } from '@shared/routines'
import { callerKind } from '../../../server/src/caller'
import { httpPaneApi } from '../../src/components/panes/api'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

// Regression (2026-10-12): Settings > Managers > Routines sent its actions unmarked, so the server, which lets only the
// window resume, approve, discard or switch the manager and knows the window by its caller mark, refused the owner's
// own Approve with 403 "only the owner can do that, in Settings > Managers > Routines".
test("the owner's routine actions from Settings reach the server as the window's", async () => {
  globalThis.fetch = (async (_url: string, init?: RequestInit) =>
    callerKind(new Headers(init?.headers)) === 'window'
      ? Response.json({ enabled: true, routines: [], proposals: [] })
      : Response.json({ error: 'only the owner can do that' }, { status: 403 })) as typeof fetch
  const owners: RoutinesRequest[] = [{ approve: 'p' }, { discard: 'p' }, { resume: 'r' }, { enabled: false }]
  for (const body of owners) await expect(httpPaneApi.routinesAct(body)).resolves.toMatchObject({ enabled: true })
})
