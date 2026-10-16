import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionSummary, TitleSource } from '../src/types'

// scripts/screenshots/page-fixtures.js is evaluated as a browser script, not imported as a module
// (see its own header comment) — it replaces `window.fetch` before the SPA boots. To exercise it
// from a bun test we sandbox it behind a fake `window`, exactly the shape capture.mjs's injected
// page provides, then drive the `fetch` it installs the same way the app does.
function loadFixtureFetch(): typeof fetch {
  const src = readFileSync(
    join(import.meta.dir, '../../scripts/screenshots/page-fixtures.js'),
    'utf8',
  )
  const fakeWindow: { fetch: typeof fetch; EventSource?: unknown; __fixtureEscapes?: string[] } = {
    fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
  }
  // This IS the thing under test: running the fixture the same way the browser does, with a fake
  // `window` standing in for the page's real one.
  const run = new Function('window', src)
  run(fakeWindow)
  return fakeWindow.fetch
}

/** The keys of T that are not optional (a `T | null` property is still required). */
type RequiredKey<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T]

// Both lists are checked by the compiler against the types, both ways: a member added to the type
// without an entry here, or an entry the type no longer has, fails typecheck. The hand-copied
// field list this replaces went stale while staying green: SessionSummary gained instance_ref,
// instance_num, model and effort, the fixture rows carried none of them, and nothing failed.
const ALLOWED_TITLE_SOURCES = Object.keys({
  custom: true,
  ai: true,
  store: true,
  envelope: true,
  message: true,
  id: true,
} satisfies Record<TitleSource, true>)

// AH-41: the fixture omitted `title_source`, session-labels.ts's i18n lookup threw on the missing
// key, and the built UI rendered no session list at all.
const REQUIRED_SESSION_FIELDS = Object.keys({
  session_id: true,
  source: true,
  tool: true,
  locator: true,
  title: true,
  cwd: true,
  project: true,
  git_branch: true,
  message_count: true,
  created_at: true,
  last_activity_at: true,
  last_role: true,
  last_text_preview: true,
  size_bytes: true,
  transcript_path: true,
  queue_status: true,
  instance: true,
  instance_ref: true,
  instance_num: true,
  archived: true,
  done: true,
  subagent_count: true,
  dispatched: true,
  limit_stop: true,
  title_source: true,
  title_tag: true,
  copy_index: true,
  copy_count: true,
  ended_because: true,
  model: true,
  effort: true,
} satisfies Record<RequiredKey<SessionSummary>, true>)

test('every fixture session row carries every field SessionSummary requires', async () => {
  const fetchStub = loadFixtureFetch()
  const res = await fetchStub('http://fixture.test/api/sessions')
  const sessions = (await res.json()) as Record<string, unknown>[]
  expect(sessions.length).toBeGreaterThan(0)
  for (const row of sessions) {
    for (const field of REQUIRED_SESSION_FIELDS) {
      expect(row).toHaveProperty(field)
    }
    expect(ALLOWED_TITLE_SOURCES).toContain(row.title_source as string)
  }
})

test('a queue-create POST is refused, mirroring headlessRunsAllowed() === false', async () => {
  const fetchStub = loadFixtureFetch()
  const res = await fetchStub('http://fixture.test/api/queue', {
    method: 'POST',
    body: JSON.stringify({ title: 't', cwd: 'C:\\x', prompt: 'p' }),
  })
  expect(res.status).toBe(409)
  const body = (await res.json()) as { error: string }
  expect(body.error).toMatch(/no-headless/)
})
