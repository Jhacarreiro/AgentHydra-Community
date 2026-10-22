import { afterEach, describe, expect, test } from 'bun:test'
import { nextTick, reactive } from 'vue'
import type { ChatSummary, ExternalSession } from '@shared/protocol'
import type { View } from '../../src/components/shell/logic'
import { after, firstOther, inboxEntries, stillHeld, UNSEEN_WINDOW_MS, type InboxInputs } from '../../src/components/inbox/logic'
import { createInbox, HOLD_MS } from '../../src/components/inbox/state'
import { inboxHold, inboxHolds, setInboxHolder } from '../../src/components/inbox/hold'

// Waiting on you walks every conversation that waits on the owner, from every source, and moves on as each is answered.

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0)
const MIN = 60_000

const chat = (id: string, over: Partial<ChatSummary> = {}): ChatSummary =>
  ({ id, sessionId: null, title: id, status: 'idle', unread: false, archived: false, updatedAt: NOW - 60 * MIN, ...over }) as ChatSummary
const session = (id: string, over: Partial<ExternalSession> = {}): ExternalSession =>
  ({ id, title: id, source: 'codex', status: 'idle', unread: false, archived: false, lastActivityAt: NOW - 60 * MIN, ...over }) as ExternalSession

const inputs = (over: Partial<InboxInputs>): InboxInputs => ({
  chats: [],
  external: [],
  seen: new Map(),
  later: new Map(),
  answered: new Set(),
  held: new Map(),
  now: NOW,
  ...over
})
const keys = (over: Partial<InboxInputs>) => inboxEntries(inputs(over)).map((e) => e.key)

describe('what waits on the owner, in which order', () => {
  test('stopped agents come first, then the oldest wait first', () => {
    const chats = [
      chat('old-reply', { unread: true, lastActionAt: NOW - 90 * MIN }),
      chat('new-reply', { unread: true, lastActionAt: NOW - 5 * MIN }),
      chat('permission', { status: 'needs_you', lastActionAt: NOW - 2 * MIN })
    ]
    const external = [session('codex-question', { lastActivityAt: NOW - 30 * MIN }), session('cli-blocked', { source: 'cli', status: 'needs_you', lastActivityAt: NOW - 10 * MIN })]
    expect(keys({ chats, external })).toEqual(['cli-blocked', 'permission', 'old-reply', 'codex-question', 'new-reply'])
  })

  test('a chat stopped at a usage limit with something unread waits', () => {
    expect(keys({ chats: [chat('limited', { status: 'limited', unread: true })] })).toEqual(['limited'])
  })

  test('running, read, or archived conversations do not wait', () => {
    const chats = [chat('working', { status: 'working', unread: true }), chat('read'), chat('archived', { unread: true, archived: true })]
    const external = [session('busy', { status: 'working' }), session('gone', { archived: true })]
    expect(keys({ chats, external })).toEqual([])
  })

  test('an outside session waits when it wrote after the owner last looked at it here', () => {
    const external = [session('looked-before', { lastActivityAt: NOW - 10 * MIN }), session('looked-after', { lastActivityAt: NOW - 10 * MIN })]
    const seen = new Map([
      ['looked-before', NOW - 20 * MIN],
      ['looked-after', NOW - 5 * MIN]
    ])
    expect(keys({ external, seen })).toEqual(['looked-before'])
  })

  test('an outside session never opened here waits only when it wrote in the last day', () => {
    const external = [session('today', { lastActivityAt: NOW - UNSEEN_WINDOW_MS + MIN }), session('last-week', { status: 'stale', lastActivityAt: NOW - 7 * UNSEEN_WINDOW_MS })]
    expect(keys({ external })).toEqual(['today'])
  })

  test('a session Desk runs as one of its own chats is listed once, as that chat', () => {
    expect(keys({ chats: [chat('desk', { sessionId: 's1', unread: true })], external: [session('s1')] })).toEqual(['desk'])
  })

  test('a held conversation stays though opening it marked it read, until it runs again', () => {
    const held = new Map([
      ['read-now', 1],
      ['answered-elsewhere', 2]
    ])
    const chats = [chat('read-now'), chat('answered-elsewhere', { status: 'working' })]
    expect(keys({ chats, held })).toEqual(['read-now'])
    expect([...stillHeld(held, chats, []).keys()]).toEqual(['read-now'])
  })

  test('one the queue took later goes behind those it holds, though it waits since longer; stopped agents still first', () => {
    const chats = [
      chat('held-reply', { unread: true, lastActionAt: NOW - 5 * MIN }),
      chat('marked-unread-later', { unread: true, lastActionAt: NOW - 90 * MIN }),
      chat('new-permission', { status: 'needs_you', lastActionAt: NOW - MIN })
    ]
    const held = new Map([
      ['held-reply', 1],
      ['marked-unread-later', 2],
      ['new-permission', 3]
    ])
    expect(keys({ chats, held })).toEqual(['new-permission', 'held-reply', 'marked-unread-later'])
  })

  test('Later goes behind everything that waits, in the order it was pressed', () => {
    const chats = [chat('a', { status: 'needs_you' }), chat('b', { unread: true }), chat('c', { unread: true, lastActionAt: NOW })]
    const later = new Map([
      ['a', NOW + 2],
      ['b', NOW + 1]
    ])
    expect(keys({ chats, later })).toEqual(['c', 'b', 'a'])
  })

  test('a conversation just answered stays out while its answer lands', () => {
    expect(keys({ chats: [chat('a', { status: 'needs_you' })], answered: new Set(['a']) })).toEqual([])
  })

  test('Next goes round; answering goes to the first other one', () => {
    const list = inboxEntries(inputs({ chats: [chat('a', { unread: true, lastActionAt: 1 }), chat('b', { unread: true, lastActionAt: 2 }), chat('c', { unread: true, lastActionAt: 3 })] }))
    expect(after(list, 'b')?.key).toBe('c')
    expect(after(list, 'c')?.key).toBe('a')
    expect(firstOther(list, 'a')?.key).toBe('b')
    expect(firstOther(list.slice(0, 1), 'a')).toBeNull()
  })
})

describe('the queue moving on', () => {
  afterEach(() => setInboxHolder(null))

  function setup(chats: ChatSummary[], external: ExternalSession[] = []) {
    const world = reactive({ chats, external, selected: { kind: 'chat', id: '' } as View, read: [] as string[] })
    const timers: { fn: () => void; at: number }[] = []
    let clock = NOW
    const inbox = createInbox({
      chats: () => world.chats,
      external: () => world.external,
      selected: () => world.selected,
      select: (view) => (world.selected = view),
      markRead: (id) => world.read.push(id),
      storage: null,
      now: () => clock,
      timers: {
        set: (fn, ms) => {
          const t = { fn, at: clock + ms }
          timers.push(t)
          return t
        },
        clear: (t) => timers.splice(timers.indexOf(t as never), 1)
      }
    })
    setInboxHolder({ holds: inbox.holds, hold: inbox.hold })
    const tick = async (ms: number) => {
      clock += ms
      for (const t of timers.filter((x) => x.at <= clock)) {
        timers.splice(timers.indexOf(t), 1)
        t.fn()
      }
      await nextTick()
    }
    return { world, inbox, tick }
  }

  test('answering the conversation on screen opens the next at once, and the answer goes when Undo runs out', async () => {
    const { world, inbox, tick } = setup([chat('a', { status: 'needs_you' }), chat('b', { unread: true })])
    inbox.start()
    await nextTick()
    expect(world.selected).toEqual({ kind: 'chat', id: 'a' })
    let sent = null as boolean | null
    void inboxHold('a', 'permission').then((go) => (sent = go))
    await nextTick()
    expect(world.selected).toEqual({ kind: 'chat', id: 'b' })
    expect(inbox.pending.value?.key).toBe('a')
    await tick(HOLD_MS - 1)
    expect(sent).toBeNull()
    await tick(1)
    expect(sent).toBe(true)
    expect(inbox.pending.value).toBeNull()
  })

  test('Undo never sends, and goes back to that conversation', async () => {
    const { world, inbox, tick } = setup([chat('a', { unread: true, lastActionAt: 1 }), chat('b', { unread: true, lastActionAt: 2 })])
    inbox.start()
    await nextTick()
    const sent = inboxHold('a', 'message')
    await nextTick()
    expect(world.selected).toEqual({ kind: 'chat', id: 'b' })
    inbox.undo()
    expect(await sent).toBe(false)
    expect(world.selected).toEqual({ kind: 'chat', id: 'b' }) // the undone text lands in a's draft first
    await tick(0)
    expect(world.selected).toEqual({ kind: 'chat', id: 'a' })
    expect(inbox.entries.value.map((e) => e.key)).toEqual(['a', 'b'])
  })

  test('a send to another conversation, or with the queue off, goes at once', async () => {
    const { inbox } = setup([chat('a', { unread: true, lastActionAt: 1 }), chat('b', { unread: true, lastActionAt: 2 })])
    expect(inboxHolds('a')).toBe(false)
    expect(await inboxHold('a', 'message')).toBe(true)
    inbox.start()
    await nextTick()
    expect(inboxHolds('b')).toBe(false)
    expect(await inboxHold('b', 'message')).toBe(true)
  })

  test('a second answer sends the first one at once', async () => {
    const { inbox } = setup([chat('a', { unread: true, lastActionAt: 1 }), chat('b', { unread: true, lastActionAt: 2 }), chat('c', { unread: true, lastActionAt: 3 })])
    inbox.start()
    await nextTick()
    const first = inboxHold('a', 'message')
    await nextTick()
    void inboxHold('b', 'message')
    expect(await first).toBe(true)
    expect(inbox.pending.value?.key).toBe('b')
  })

  test('Later keeps a conversation that opening marked read, at the end', async () => {
    const { world, inbox } = setup([chat('a', { unread: true, lastActionAt: 1 }), chat('b', { unread: true, lastActionAt: 2 })])
    inbox.start()
    await nextTick()
    world.chats[0]!.unread = false // opening it read it
    await nextTick()
    inbox.later()
    await nextTick()
    expect(world.selected).toEqual({ kind: 'chat', id: 'b' })
    expect(inbox.entries.value.map((e) => e.key)).toEqual(['b', 'a'])
  })

  test('Done takes an outside session out until it writes again, though it still reads as waiting', async () => {
    // A claude.ai Project thread resolved there can read blocked for weeks: Done is how it stops waiting here.
    const { world, inbox, tick } = setup([], [session('s1', { status: 'needs_you', lastActivityAt: NOW - 2 * MIN }), session('s2', { lastActivityAt: NOW - MIN })])
    inbox.start()
    await nextTick()
    expect(world.selected).toEqual({ kind: 'external', id: 's1' })
    await tick(MIN)
    inbox.done()
    await nextTick()
    expect(world.selected).toEqual({ kind: 'external', id: 's2' })
    expect(inbox.waiting.value.map((e) => e.key)).toEqual(['s2'])
    world.external[0]!.lastActivityAt = NOW + 5 * MIN
    await nextTick()
    // Written again, it waits again, first as a stopped agent.
    expect(inbox.waiting.value.map((e) => e.key)).toEqual(['s1', 's2'])
  })

  test('a conversation answered from somewhere else moves the queue on', async () => {
    const { world, inbox } = setup([chat('a', { status: 'needs_you' }), chat('b', { unread: true })])
    inbox.start()
    await nextTick()
    world.chats[0]!.status = 'working'
    await nextTick()
    await nextTick()
    expect(world.selected).toEqual({ kind: 'chat', id: 'b' })
  })

  test('turning it on over a read conversation opens the first that waits; Done on the last one leaves nothing', async () => {
    const { world, inbox } = setup([chat('read'), chat('a', { unread: true })])
    world.selected = { kind: 'chat', id: 'read' }
    await nextTick()
    inbox.start()
    await nextTick()
    expect(world.selected).toEqual({ kind: 'chat', id: 'a' })
    expect(inbox.entries.value.map((e) => e.key)).toEqual(['a'])
    world.chats[1]!.unread = false
    inbox.done()
    await nextTick()
    expect(inbox.entries.value).toEqual([])
    expect(inbox.current.value).toBeNull()
  })

  test('with Auto-advance off, an answer stays on the conversation', async () => {
    const { world, inbox } = setup([chat('a', { status: 'needs_you' }), chat('b', { unread: true })])
    inbox.start()
    inbox.setAuto(false)
    await nextTick()
    void inboxHold('a', 'plan')
    await nextTick()
    expect(world.selected).toEqual({ kind: 'chat', id: 'a' })
  })

  test('a send to a chat opened by hand that does not wait goes at once, and Undo cannot bring it in', async () => {
    const { world, inbox } = setup([chat('a', { unread: true }), chat('read')])
    inbox.start()
    await nextTick()
    world.selected = { kind: 'chat', id: 'read' }
    await nextTick()
    expect(inboxHolds('read')).toBe(false)
    expect(await inboxHold('read', 'message')).toBe(true)
    expect(world.selected).toEqual({ kind: 'chat', id: 'read' })
    expect(inbox.pending.value).toBeNull()
  })

  test('with Auto-advance off, a second send to the same conversation still waits behind the first', async () => {
    const { inbox } = setup([chat('a', { status: 'needs_you' }), chat('b', { unread: true })])
    inbox.start()
    inbox.setAuto(false)
    await nextTick()
    const first = inboxHold('a', 'permission')
    await nextTick()
    expect(inboxHolds('a')).toBe(true)
    void inboxHold('a', 'message')
    expect(await first).toBe(true)
    expect(inbox.pending.value?.key).toBe('a')
    expect(inbox.pending.value?.kind).toBe('message')
  })

  test('one that starts waiting joins the end of the queue', async () => {
    const { world, inbox } = setup([chat('a', { unread: true, lastActionAt: NOW - 5 * MIN }), chat('b', { unread: true, lastActionAt: NOW - 4 * MIN }), chat('old')])
    inbox.start()
    await nextTick()
    world.chats[2]!.unread = true // marked unread by hand: it waits since long ago, but came in last
    await nextTick()
    expect(inbox.entries.value.map((e) => e.key)).toEqual(['a', 'b', 'old'])
  })

  test('Undo puts it back in its place', async () => {
    const { inbox } = setup([chat('a', { unread: true, lastActionAt: 1 }), chat('b', { unread: true, lastActionAt: 2 }), chat('c', { unread: true, lastActionAt: 3 })])
    inbox.start()
    await nextTick()
    inbox.next()
    await nextTick()
    void inboxHold('b', 'message')
    await nextTick()
    inbox.undo()
    await nextTick()
    expect(inbox.entries.value.map((e) => e.key)).toEqual(['a', 'b', 'c'])
  })
})
