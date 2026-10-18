// server/tests/hydra-core-slot.test.ts - what a slot chat receives: a slot rebuilt on every launch from the chat's
// stored lead and first message, reused only when its text is the same, sized for the system prompt, and per-message
// additions scored on the owner's own words.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error the hook is plain ESM with no type declarations
import { run } from '../../hydra-core/hook.mjs'
import { chatPromptText } from '../src/climayte-launch'
import type { CliMayteWorker } from '../src/climayte-lib'
import { readLog } from '../src/hydra-core/log'
import { matchFor, packFor, TOTAL_CAP } from '../src/hydra-core/pack'
import { chatPaths } from '../src/hydra-core/paths'
import { APPEND_MAX, placeChat, SLOT_CAP } from '../src/hydra-core/placement'
import { scratch } from './hydra-core-fixture'

const T = Date.parse('2026-10-14T09:00:00Z')
const CWD = 'C:/Users/me/app'
const RULES = 'Repo rules: the invented test app uses one button style.'
const LEAD_PROMPT = 'sketch the dashboard layout'

let dir: string
let savedFetch: typeof fetch

function addRules(core: string, text = `${RULES}\n`): void {
  const rules = join(core, 'repo-rules.md')
  writeFileSync(rules, text)
  writeFileSync(
    join(core, 'catalog', 'hand-repo-fixture.json'),
    JSON.stringify([
      {
        id: 'knowledge:repo-rules',
        kind: 'knowledge',
        name: 'Repo Rules',
        when: 'Button style rules for the app',
        tags: ['repo'],
        folders: [CWD],
        cost: 'free',
        how: 'read the repo rules',
        load: { type: 'file', path: rules },
      },
      {
        id: 'knowledge:pricing-tables',
        kind: 'knowledge',
        name: 'Pricing Tables',
        when: 'Pricing tables for plans and pricing',
        tags: ['pricing'],
        cost: 'free',
        how: 'read the pricing tables',
        load: { type: 'file', path: join(core, 'pricing-tables.md') },
      },
    ]),
  )
  writeFileSync(join(core, 'pricing-tables.md'), 'Pricing tables: invented plans cost 3 coins.\n')
}

const slotReq = (
  chat: string,
  session: string,
  over: Partial<{ fresh: boolean; prompt: string }> = {},
) => ({
  chat,
  session,
  fresh: true,
  cwd: CWD,
  prompt: LEAD_PROMPT,
  placement: 'slot' as const,
  ...over,
})

beforeEach(() => {
  dir = scratch()
  addRules(dir)
  savedFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = savedFetch
  rmSync(dir, { recursive: true, force: true })
})

describe('the slot is rebuilt on every launch and reused when its text is the same (A1-F3)', () => {
  test('scope-log churn in hydra.md leaves the slot as it was', () => {
    const first = placeChat(dir, slotReq('churn', 's1'), new Date(T))
    const files = chatPaths(dir, 'churn')
    writeFileSync(files.hydraMd, '# hydra.md\n\n## Scope log\n- 09:01 scoped the first task\n')
    const second = placeChat(dir, slotReq('churn', 's1', { fresh: false }), new Date(T + 1))
    writeFileSync(
      files.hydraMd,
      '# hydra.md\n\n## Scope log\n- 09:01 scoped the first task\n- 09:02 and another\n',
    )
    const third = placeChat(dir, slotReq('churn', 's1', { fresh: false }), new Date(T + 2))
    expect(second.reused).toBe(true)
    expect(third.reused).toBe(true)
    expect(third.hash).toBe(first.hash)
  })

  test('the hash is the hash of the slot text', () => {
    const placed = placeChat(dir, slotReq('hashed', 's1'), new Date(T))
    expect(placed.hash).toBe(createHash('sha256').update(placed.text).digest('hex'))
  })

  test('an edited lead brief reaches the chat on its next launch, though no input the old hash covered changed', () => {
    const first = placeChat(dir, slotReq('brief', 's1'), new Date(T))
    expect(first.text).toContain('Lead for this message: Iris Example')
    expect(first.text).toContain('Iris Example: full persona text.')
    writeFileSync(join(dir, 'persona-iris.md'), 'Iris Example: the brief as edited today.\n')
    const next = placeChat(dir, slotReq('brief', 's1', { fresh: false }), new Date(T + 1))
    expect(next.reused).toBe(false)
    expect(next.text).toContain('the brief as edited today')
    expect(readFileSync(chatPaths(dir, 'brief').slot, 'utf8')).toBe(next.text)
  })

  test('a changed hydra.md lead still changes the slot', () => {
    placeChat(dir, slotReq('relead', 's1'), new Date(T))
    const brief = join(dir, 'persona-dana.md')
    writeFileSync(brief, 'Dana Example: the design lead brief.\n')
    writeFileSync(
      chatPaths(dir, 'relead').hydraMd,
      `## Lead\nDana Example - Design lead. Full text: ${brief}\n`,
    )
    const next = placeChat(dir, slotReq('relead', 's1', { fresh: false }), new Date(T + 1))
    expect(next.reused).toBe(false)
    expect(next.text).toContain('Dana Example: the design lead brief.')
  })
})

describe("a new session in the same chat keeps the chat's lead (A3 finding 3)", () => {
  test("a handoff's first message is not ranked for a new lead, even when the slot is rebuilt", () => {
    const first = placeChat(dir, slotReq('handoff', 'old'), new Date(T))
    expect(first.text).toContain('Lead for this message: Iris Example')
    addRules(dir, 'Repo rules: changed between the two sessions.\n')
    const next = placeChat(
      dir,
      slotReq('handoff', 'new', { prompt: 'run the release checklist for the redesign' }),
      new Date(T + 1),
    )
    expect(next.reused).toBe(false)
    expect(next.text).toContain('changed between the two sessions')
    expect(next.text).toContain('Lead for this message: Iris Example')
    expect(next.text).not.toContain('Oscar Example')
    expect(next.text).not.toContain('Dana Example')
  })
})

describe('a resumed session with the slot in its prompt gets no second pack (A1-F1)', () => {
  test('a resume launch counts as a session that has the slot', () => {
    placeChat(dir, slotReq('resumed', 'r1', { fresh: false }), new Date(T))
    const msg = matchFor(
      dir,
      {
        chat: 'resumed',
        session: 'r1',
        cwd: CWD,
        prompt: 'pricing plans for the product',
        placement: 'slot',
      },
      new Date(T + 1),
    )
    expect(msg.text).not.toContain('Hydra Core attached for this chat and message')
    expect(msg.text).not.toContain(RULES)
  })
})

describe('the slot has its own cap, and the lead brief goes in before the folder rules are whole (A1-F5, A2-F5)', () => {
  test('a 15K AGENTS.md and a 9K lead brief: the brief is whole, the rules are cut with a pointer', () => {
    addRules(dir, `${RULES}\n${'r'.repeat(15_000)}\nThe last rule of the file.\n`)
    const brief = `Iris Example: full persona text.\n${'b'.repeat(9_000)}\nIris closing line.\n`
    writeFileSync(join(dir, 'persona-iris.md'), brief)
    const placed = placeChat(dir, slotReq('big', 's1'), new Date(T))
    expect(SLOT_CAP).toBe(24_000)
    expect(placed.text.length).toBeLessThanOrEqual(SLOT_CAP)
    expect(placed.text).toContain(`Lead for this message: Iris Example\n\n${brief.trimEnd()}`)
    expect(placed.text).toContain(RULES)
    expect(placed.text).toContain('[cut at ')
    expect(placed.text).toContain('repo-rules.md]')
    expect(placed.text).not.toContain('The last rule of the file.')
  })

  test('rules and brief that fit together are both whole', () => {
    addRules(dir, `${RULES}\n${'r'.repeat(12_000)}\nThe last rule of the file.\n`)
    writeFileSync(
      join(dir, 'persona-iris.md'),
      `Iris Example: full persona text.\n${'b'.repeat(8_000)}\n`,
    )
    const placed = placeChat(dir, slotReq('fits', 's1'), new Date(T))
    expect(placed.text).toContain('The last rule of the file.')
    expect(placed.text).toContain(`${'b'.repeat(8_000)}`)
    expect(placed.text).not.toContain('[cut at ')
  })

  test('the attach path keeps its 9,500-character cap', () => {
    addRules(dir, `${RULES}\n${'r'.repeat(15_000)}\n`)
    const pack = packFor(
      dir,
      { chat: 'attach', session: 'a1', cwd: CWD, prompt: LEAD_PROMPT },
      new Date(T),
    )
    expect(TOTAL_CAP).toBe(9_500)
    expect(pack.text.length).toBeLessThanOrEqual(TOTAL_CAP)
  })
})

describe('launch: the whole appended prompt stays within 32,000 characters (A1-F9) and is keyed by the launched session (A1-F7)', () => {
  const prime = (over: Record<string, unknown>) =>
    ({ cwd: CWD, chat: true, prompt: LEAD_PROMPT, ...over }) as unknown as CliMayteWorker

  beforeEach(() => {
    writeFileSync(join(dir, 'ON'), '')
    writeFileSync(join(dir, 'PLACEMENT'), 'slot\n')
  })

  test('a long desk.append shortens the slot, and the cut is logged', () => {
    addRules(dir, `${RULES}\n${'r'.repeat(30_000)}\n`)
    writeFileSync(
      join(dir, 'persona-iris.md'),
      `Iris Example: full persona text.\n${'b'.repeat(9_000)}\n`,
    )
    const w = prime({
      sessionId: 'big-1',
      desk: { chatId: 'desk-big', append: 'a'.repeat(19_000), mcpServers: {} },
    })
    const text = chatPromptText(w, { id: 'big-1', resume: false })
    expect(APPEND_MAX).toBe(32_000)
    expect(text.length).toBeLessThanOrEqual(APPEND_MAX)
    expect(text).toContain('Lead for this message: Iris Example')
    const cut = readLog(dir).events.find((e) => e.event === 'placement' && e.phase === 'cut')
    expect(cut?.chat).toBe('desk-big')
    expect(cut?.room as number).toBeLessThan(SLOT_CAP)
  })

  test('a non-Desk chat:true handoff writes its slot under the new session id', () => {
    chatPromptText(prime({ sessionId: 'sess-old' }), { id: 'sess-new', resume: false })
    expect(existsSync(chatPaths(dir, 'sess-new').placed)).toBe(true)
    expect(existsSync(chatPaths(dir, 'sess-old').placed)).toBe(false)
  })
})

describe('the hook under slot', () => {
  const env = () =>
    ({ AGENTHYDRA_CORE_DIR: dir, AGENTHYDRA_DAEMON_URL: 'http://daemon.test' }) as NodeJS.ProcessEnv
  let asked: string[]

  beforeEach(() => {
    writeFileSync(join(dir, 'ON'), '')
    writeFileSync(join(dir, 'PLACEMENT'), 'slot\n')
    asked = []
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body)
      asked.push(body.prompt)
      return new Response(JSON.stringify(matchFor(dir, body, new Date(T))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  })

  const send = (prompt: string) =>
    run({ hook_event_name: 'UserPromptSubmit', session_id: 'hk1', cwd: CWD, prompt }, env())

  test("a handoff's first message is scored and recorded on the owner's sentence alone (A1-F2)", async () => {
    placeChat(dir, slotReq('hk1', 'hk1'), new Date(T))
    const owner = 'where are we on the invented settings page'
    const handoff =
      `${owner}\n\n---\nAn earlier session already worked on this task on this account and handed off because its ` +
      'conversation had grown large. Continue from its handoff below (also saved at C:/Users/me/handoff.md).' +
      '\n\nThe orchestrator also sent these messages, which the earlier session did not get to:\n- and check the pricing plans' +
      '\n\n--- HANDOFF ---\npricing plans pricing tables for the product, done and committed'
    await send(handoff)
    expect(asked).toEqual([`${owner}\n\nand check the pricing plans`])
    expect(readFileSync(chatPaths(dir, 'hk1').prompt, 'utf8')).toBe(asked[0])
  })

  test("the Send now and urgent prefaces and a trailing task notification are not the owner's words (A1-F2)", async () => {
    placeChat(dir, slotReq('hk1', 'hk1'), new Date(T))
    await send(
      '[Sent now: the user stopped your previous turn mid-step to send this message. Act on it first.]\nfix the button',
    )
    await send(
      'AgentHydra stopped your previous turn mid-step to deliver this message from the orchestrator. Act on it first.\n\nship the fix',
    )
    await send(
      'look at the logs\n<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>',
    )
    expect(asked).toEqual(['fix the button', 'ship the fix', 'look at the logs'])
  })

  test("after compaction the session's sent additions are cleared, so they can be sent again (A1-F8)", async () => {
    placeChat(dir, slotReq('hk1', 'hk1'), new Date(T))
    const first = await send('pricing plans for the product')
    expect(first?.hookSpecificOutput?.additionalContext ?? '').toContain('knowledge:pricing-tables')
    expect(await send('pricing plans for the product')).toBeNull()
    const sent = chatPaths(dir, 'hk1').sent
    writeFileSync(
      sent,
      JSON.stringify({ ...JSON.parse(readFileSync(sent, 'utf8')), other: ['knowledge:x'] }),
    )
    expect(
      await run(
        { hook_event_name: 'SessionStart', source: 'compact', session_id: 'hk1', cwd: CWD },
        env(),
      ),
    ).toBeNull()
    expect(JSON.parse(readFileSync(sent, 'utf8'))).toEqual({ other: ['knowledge:x'] })
    const again = await send('pricing plans for the product')
    expect(again?.hookSpecificOutput?.additionalContext ?? '').toContain('knowledge:pricing-tables')
  })
})

describe('slot and session bookkeeping', () => {
  test("the chat's lead and first message are stored with its placement", () => {
    placeChat(dir, slotReq('kept', 's1'), new Date(T))
    const placed = JSON.parse(readFileSync(chatPaths(dir, 'kept').placed, 'utf8'))
    expect(placed.lead).toBe('person:iris-ui')
    expect(placed.prompt).toBe(LEAD_PROMPT)
  })
})
