// A profile signed into another account kept the old account's name and plan on its row until the next list poll,
// two minutes later (owner, 2026-10-14: #5 read "Max 20×" after it was signed into a Pro account). followLogins
// reads the logins off disk (no process scan) and a row whose login moved shows the new account at once.
import { expect, it } from 'bun:test'
import { useInstances } from './useInstances'

const dir = 'C:/Users/me/.claude-instances/five'
const account = (uuid: string, email: string, planLabel: string) => ({ accountUuid: uuid, email, name: 'Example Owner', planLabel, status: 'live' })

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

it("a profile signed into another account drops the old account's name and plan and shows the new one at once", async () => {
  let login = 'old-uuid'
  const accounts: Record<string, ReturnType<typeof account>> = {
    'old-uuid': account('old-uuid', 'old@example.com', 'Max 20×'),
    'new-uuid': account('new-uuid', 'new@example.com', 'Pro'),
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    const body = u.endsWith('/api/instances/logins')
      ? [{ dir, loginUuid: login }]
      : u.includes('/account')
        ? accounts[login]
        : [{ dir, name: 'five', number: 5, isRunning: false, account: null, loginUuid: 'old-uuid' }]
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  try {
    const { instances, refreshInstances, followLogins } = useInstances()
    await refreshInstances({ silent: true })
    await waitFor(() => instances.value[0]?.account?.planLabel === 'Max 20×')

    login = 'new-uuid'
    await followLogins()
    // The old account is never shown against the new login, not even for the moment the resolve takes.
    expect(instances.value[0]?.account?.email).not.toBe('old@example.com')
    await waitFor(() => instances.value[0]?.account?.planLabel === 'Pro')
    expect([instances.value[0]?.loginUuid, instances.value[0]?.account?.email]).toEqual(['new-uuid', 'new@example.com'])
  } finally {
    globalThis.fetch = realFetch
  }
})
