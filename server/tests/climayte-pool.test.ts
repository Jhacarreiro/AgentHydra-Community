// server/tests/climayte-pool.test.ts - who else is on an account, as CliMayte's pool sees it
// (climayte-core otherSessionsIn). The tick reads every pool account's session registrations off the
// daemon's thread (refreshPoolSessions) and each pool build judges them, so a session another
// program starts in an account's folder must count once the next read lands: new work goes around it.
//
// At the owner boundary: a real CLI instance with a login file, and a real child process registered
// where the CLI registers its sessions.

import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { accountsProvider, refreshPoolSessions } from '../src/climayte-core'
import { createCliInstance, deleteCliInstance } from '../src/core/cli-instances'

const created: { id: string; name: string }[] = []
const children: ReturnType<typeof Bun.spawn>[] = []

afterAll(() => {
  for (const p of children) p.kill()
  for (const { id, name } of created) deleteCliInstance(id, name)
})

test('a session started on an account after the pool read it counts once the tick reads again', async () => {
  const name = `climayte-pool-${crypto.randomUUID().slice(0, 8)}`
  const made = createCliInstance(name)
  expect(made.ok).toBe(true)
  const id = made.data?.id as string
  created.push({ id, name })
  const dir = made.dir as string
  writeFileSync(join(dir, '.credentials.json'), '{"claudeAiOauth":{}}')
  const others = () => accountsProvider().find((a) => a.id === id)?.otherSessions

  const now = Date.now()
  await refreshPoolSessions(now)
  expect(others()).toBe(0)

  const session = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  children.push(session)
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  writeFileSync(
    join(dir, 'sessions', `${session.pid}.json`),
    JSON.stringify({ pid: session.pid, sessionId: crypto.randomUUID(), cwd: dir }),
  )
  // The tick's next read, a pool interval on.
  await refreshPoolSessions(now + 3_000)
  expect(others()).toBe(1)
  // A real child process and two process-table reads: well under a second idle, but a box at ~90%
  // CPU stretches each (2026-10-11), and bun's 5 s default is the machine's number, not the test's.
}, 30_000)
