import { describe, it, expect } from 'bun:test'
import type { ChatServiceInfo, ChatSummary, ExternalSession } from '@shared/protocol'
import {
  accountFace,
  chatRow,
  elapsedLabel,
  timeAgo,
  childrenByRow,
  entryKey,
  entryRunning,
  foldChildren,
  externalGlyph,
  externalRename,
  externalRow,
  folderLabel,
  glyphDotClass,
  groupChats,
  groupChoices,
  hideable,
  moveInOrder,
  setHidden,
  deskGlyphs,
  rowDropBefore,
  raiseNewlyOrange,
  recordOrder,
  parseFilter,
  resumeCommand,
  revealChat,
  rowMenu,
  rowPatch,
  runningSessionIds,
  runPulse,
  shortcutItem,
  sortFolders,
  statusGlyph,
  SWARM_RUNNING,
  withThreads,
  type AccountChoice,
  type ChatGroup,
  type RowMenuEntry,
  type SidebarGroups,
  type RowMenuItem
} from '@/components/sidebar/logic'
import { accountChoices, ahInstances } from '@/components/session-header/instances'
import { runShortcut } from '@/components/sidebar/menuClasses'
import { dimText } from '@/components/sidebar/rowClasses'

const ids = (g: ChatGroup | null | undefined) => g?.entries.map((e) => e.id)

function chat(id: string, over: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    sessionId: null,
    title: `Chat ${id}`,
    cwd: 'C:/work/alpha',
    account: { id: '1', label: '#1', configDir: null, number: 1 },
    accountAuto: true,
    model: null,
    effort: null,
    permissionMode: 'default',
    delegateToCliMayte: true,
    status: 'idle',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: 0,
    updatedAt: 0,
    costUsd: 0,
    contextPct: null,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0,
    ...over
  }
}

describe('sidebar groups', () => {
  const chats = [
    chat('a1', { updatedAt: 10 }),
    chat('a2', { updatedAt: 30 }),
    chat('b1', { cwd: 'C:\\work\\Beta', updatedAt: 50, title: 'Shader cache' }),
    chat('p', { pinned: true, updatedAt: 5 }),
    chat('z', { archived: true, updatedAt: 99 })
  ]

  it('labels a folder by its basename with the case kept', () => {
    expect(folderLabel('C:\\work\\Beta')).toBe('Beta')
    expect(folderLabel('/home/j/nexuscode-2d/')).toBe('nexuscode-2d')
  })

  it('puts pinned chats in their own group, folders A-Z by label and rows newest first', () => {
    const g = groupChats(chats)
    expect(ids(g.pinned)).toEqual(['p'])
    expect(g.folders.map((f) => f.label)).toEqual(['alpha', 'Beta'])
    expect(ids(g.folders[0])).toEqual(['a2', 'a1'])
    expect(g.archived).toBeNull()
  })

  it('hides Pinned when empty; Active (the default) leaves archived chats out', () => {
    expect(groupChats([chat('a')]).pinned).toBeNull()
    const active = groupChats(chats, { filter: 'active' })
    expect(active.folders.flatMap((f) => ids(f))).not.toContain('z')
    expect(active.archived).toBeNull()
  })

  it('Archived lists only the archived chats, by folder, a pinned one included', () => {
    const list = [...chats, chat('zp', { archived: true, pinned: true, cwd: 'C:\\work\\Beta', updatedAt: 70 })]
    const g = groupChats(list, { filter: 'archived', external: [{ id: 'e', title: 'Ext', cwd: 'C:/work/alpha', source: 'desktop', instance: null, status: 'idle', activity: null, lastActivityAt: 1, model: null, accountId: null, canResume: false, fromPc: null, pinned: false, archived: false, unread: false, group: null }] })
    expect(g.pinned).toBeNull()
    expect(g.archived).toBeNull()
    expect(g.folders.map((f) => [f.label, ids(f)])).toEqual([
      ['alpha', ['z']],
      ['Beta', ['zp']]
    ])
  })

  it('Unassigned chats wait in their own group after the folders; Archived groups them by folder; a pinned one stays in Pinned', () => {
    const outside = (id: string, over: Partial<ExternalSession> = {}): ExternalSession => ({ id, title: `Outside ${id}`, cwd: 'C:/work/alpha', source: 'desktop', instance: null, status: 'idle', activity: null, lastActivityAt: 1, model: null, accountId: null, canResume: false, fromPc: null, pinned: false, archived: false, unread: false, group: null, ...over })
    const external = [outside('u1', { unassigned: true, lastActivityAt: 3 }), outside('u2', { unassigned: true, group: 'Launch', lastActivityAt: 7 }), outside('up', { unassigned: true, pinned: true }), outside('ua', { unassigned: true, archived: true })]
    const g = groupChats(chats, { external })
    expect(g.folders.map((f) => [f.label, ids(f)])).toEqual([
      ['alpha', ['a2', 'a1']],
      ['Beta', ['b1']],
      ['Unassigned', ['u2', 'u1']]
    ])
    expect(ids(g.pinned)).toEqual(['p', 'up'])
    expect(hideable(g.folders.at(-1)!)).toBe(false)
    expect(groupChats([], { external, filter: 'archived' }).folders.map((f) => [f.label, ids(f)])).toEqual([['alpha', ['ua']]])
  })

  it('Archived is empty when nothing is archived', () => {
    const g = groupChats([chat('a'), chat('p', { pinned: true })], { filter: 'archived' })
    expect([g.pinned, g.archived, g.folders]).toEqual([null, null, []])
  })

  it('All shows the active list with an Archived group last', () => {
    const g = groupChats(chats, { filter: 'all' })
    expect(ids(g.pinned)).toEqual(['p'])
    expect(g.folders.map((f) => f.label)).toEqual(['alpha', 'Beta'])
    expect(ids(g.archived)).toEqual(['z'])
  })

  it('unarchiving moves a chat back from Archived to Active', () => {
    const before = [chat('a', { archived: true })]
    const after = [chat('a', { archived: false })]
    expect(groupChats(before).folders).toEqual([])
    expect(ids(groupChats(before, { filter: 'archived' }).folders[0])).toEqual(['a'])
    expect(ids(groupChats(after).folders[0])).toEqual(['a'])
    expect(groupChats(after, { filter: 'archived' }).folders).toEqual([])
  })

  it('search drops rows and the groups left empty, in every filter', () => {
    expect(groupChats(chats, { query: 'shader' }).folders.map((f) => f.label)).toEqual(['Beta'])
    expect(groupChats(chats, { query: 'shader', filter: 'archived' }).folders).toEqual([])
    expect(ids(groupChats(chats, { query: 'chat z', filter: 'all' }).archived)).toEqual(['z'])
  })
})

describe('sessions running elsewhere in the same list', () => {
  function ext(id: string, over: Partial<ExternalSession> = {}): ExternalSession {
    return { id, title: `Ext ${id}`, cwd: 'C:/work/alpha', source: 'desktop', instance: null, status: 'idle', activity: null, lastActivityAt: 20, model: null, accountId: null, canResume: false, fromPc: null, pinned: false, archived: false, unread: false, group: null, ...over }
  }

  it('merges them into the folder groups by activity, newest first', () => {
    const g = groupChats([chat('a1', { updatedAt: 10 }), chat('a2', { updatedAt: 30 })], { external: [ext('e', { lastActivityAt: 20 })] })
    expect(g.folders[0]!.entries.map((e) => `${e.kind}:${e.id}`)).toEqual(['chat:a2', 'external:e', 'chat:a1'])
  })

  it("a folded group's green count is the rows whose turn runs, ours and elsewhere's, never one waiting on you; the cloud list draws every desk row's dot by session", () => {
    const chats = [chat('w', { status: 'working', sessionId: 's-w' }), chat('s', { status: 'starting' }), chat('q', { status: 'needs_you', sessionId: 's-q' }), chat('i')]
    const external = [ext('e-run', { status: 'working' }), ext('e-ask', { status: 'needs_you' }), ext('e-idle')]
    expect(groupChats(chats, { external }).folders[0]!.entries.filter(entryRunning).map((e) => e.id).sort()).toEqual(['e-run', 's', 'w'])
    // The cloud list knows a row by its session: a running chat with none yet has nothing to match.
    expect([...runningSessionIds(chats, external)].sort()).toEqual(['e-run', 's-w'])
    // Its dot is the desk row's: gray blinking while it runs, orange pulsing while it waits on you, a hollow ring when idle.
    expect([...deskGlyphs(chats, [...external, ext('cm', { source: 'climayte' })])].map(([id, g]) => `${id}:${g.shape}:${g.tone}:${g.motion}`).sort()).toEqual([
      'e-ask:dot:warning:pulse',
      'e-idle:ring:muted:none',
      'e-run:dot:muted:blink',
      's-q:dot:warning:pulse',
      's-w:dot:muted:blink'
    ])
  })

  it('a dragged row lands before the row it is dropped on, or after it on its lower half; no change is no drop', () => {
    const keys = ['a', 'b', 'c', 'd']
    expect(rowDropBefore(keys, 'd', 'b', false)).toBe('b')
    expect(rowDropBefore(keys, 'a', 'c', true)).toBe('d')
    expect(rowDropBefore(keys, 'a', 'd', true)).toBeNull()
    expect(rowDropBefore(keys, 'b', 'c', false)).toBeUndefined()
    expect(rowDropBefore(keys, 'b', 'a', true)).toBeUndefined()
    expect(rowDropBefore(keys, 'b', 'b', true)).toBeUndefined()
    expect(rowDropBefore(keys, 'b', 'other', true)).toBeUndefined()
  })

  it('skips CliMayte workers and sessions that already are one of our chats; no cwd goes under No folder', () => {
    const g = groupChats([chat('a', { sessionId: 'same' })], {
      external: [ext('same'), ext('cm', { source: 'climayte' }), ext('loose', { cwd: null, lastActivityAt: 99 })]
    })
    expect(g.folders.map((f) => [f.label, f.cwd, ids(f)])).toEqual([
      ['alpha', 'C:/work/alpha', ['a']],
      ['No folder', null, ['loose']]
    ])
  })

  it('puts two spellings of one folder in one group, labelled as its newest row spells it', () => {
    const g = groupChats([chat('a', { cwd: 'C:\\Work\\Connections', updatedAt: 10 })], {
      external: [ext('e', { cwd: 'c:/work/connections/', lastActivityAt: 20 })]
    })
    expect(g.folders.map((f) => [f.label, ids(f)])).toEqual([['connections', ['e', 'a']]])
  })

  it('shows them under Active and All, never under Archived', () => {
    const external = [ext('run', { status: 'working', lastActivityAt: 30 }), ext('idle')]
    expect(groupChats([], { external, filter: 'active' }).folders.flatMap((f) => ids(f))).toEqual(['run', 'idle'])
    expect(groupChats([], { external, filter: 'all' }).folders.flatMap((f) => ids(f))).toEqual(['run', 'idle'])
    expect(groupChats([], { external, filter: 'archived' }).folders).toEqual([])
  })

  it('draws their dot in the same language, stale a hollow ring, marked unread green', () => {
    expect(externalGlyph({ status: 'working', unread: false })).toMatchObject({ shape: 'dot', motion: 'blink' })
    expect(externalGlyph({ status: 'stale', unread: false })).toMatchObject({ shape: 'ring', active: false })
    expect(externalGlyph({ status: 'idle', unread: true })).toMatchObject({ shape: 'dot', tone: 'success', label: 'Unread' })
  })

  it('takes Hydra Desk marks: pinned to Pinned, archived to Archived, a moved-to group', () => {
    const external = [ext('pin', { pinned: true }), ext('arc', { archived: true }), ext('grp', { group: 'Ops', lastActivityAt: 40 }), ext('plain')]
    const g = groupChats([], { external, filter: 'all' })
    expect(ids(g.pinned)).toEqual(['pin'])
    expect(ids(g.archived)).toEqual(['arc'])
    expect(g.folders.map((f) => [f.key, f.label, f.cwd, ids(f)])).toEqual([
      ['C:/work/alpha', 'alpha', 'C:/work/alpha', ['plain']],
      ['group:ops', 'Ops', null, ['grp']]
    ])
    expect(groupChats([], { external, filter: 'archived' }).folders.flatMap((f) => ids(f))).toEqual(['arc'])
  })
})

describe('moved-to groups', () => {
  it('groups a chat by its group when set, else by its folder; Pinned stays its own', () => {
    const g = groupChats([
      chat('a', { updatedAt: 10 }),
      chat('m', { group: 'Launch', updatedAt: 20 }),
      chat('n', { group: 'launch', cwd: 'C:/work/other', updatedAt: 5 }),
      chat('p', { group: 'Launch', pinned: true, updatedAt: 30 })
    ])
    expect(ids(g.pinned)).toEqual(['p'])
    expect(g.folders.map((f) => [f.label, f.cwd, ids(f)])).toEqual([
      ['alpha', 'C:/work/alpha', ['a']],
      ['Launch', null, ['m', 'n']]
    ])
  })

  it('a group named like a folder group joins it, keeping the folder as its path', () => {
    const g = groupChats([chat('a', { cwd: 'C:/work/Beta', updatedAt: 10 }), chat('m', { group: 'beta', updatedAt: 20 })])
    expect(g.folders.map((f) => [f.label, f.cwd, ids(f)])).toEqual([['Beta', 'C:/work/Beta', ['m', 'a']]])
  })

  it('a hidden group is left out, the moved-to rows that joined it too, and Pinned keeps its pinned row', () => {
    const list = [
      chat('a', { cwd: 'C:/work/Beta', updatedAt: 10 }),
      chat('m', { group: 'beta', updatedAt: 20 }),
      chat('p', { cwd: 'C:/work/Beta', pinned: true, updatedAt: 30 }),
      chat('l', { group: 'Launch', updatedAt: 5 }),
      chat('o', { updatedAt: 1 })
    ]
    const hidden = new Set(['c:/work/beta', 'group:launch'])
    const g = groupChats(list, { hidden })
    expect(g.folders.map((f) => f.label)).toEqual(['alpha'])
    expect(g.hiddenOut).toBe(2)
    expect(ids(g.pinned)).toEqual(['p'])
    expect(g.folders[0]!.hidden).toBeUndefined()
  })

  it('Show hidden or a search brings a hidden group back, marked', () => {
    const list = [chat('a', { cwd: 'C:\\Work\\Beta', updatedAt: 10, title: 'Shader cache' }), chat('o', { updatedAt: 1 })]
    const hidden = new Set(['c:/work/beta'])
    const shown = groupChats(list, { hidden, showHidden: true })
    expect(shown.folders.map((f) => [f.label, f.hidden])).toEqual([
      ['alpha', undefined],
      ['Beta', true]
    ])
    expect(shown.hiddenOut).toBe(0)
    expect(groupChats(list, { hidden, query: 'shader' }).folders.map((f) => [f.label, f.hidden])).toEqual([['Beta', true]])
    expect(groupChats(list, { hidden, filter: 'all' }).folders.map((f) => f.label)).toEqual(['alpha'])
  })

  it('Hide and Unhide change only that group', () => {
    const one = setHidden(new Set(['c:/work/x']), 'group:launch', true)
    expect([...one]).toEqual(['c:/work/x', 'group:launch'])
    expect([...setHidden(one, 'c:/work/x', false)]).toEqual(['group:launch'])
    expect(hideable({ key: 'pinned' })).toBe(false)
    expect(hideable({ key: 'archived' })).toBe(false)
    expect(hideable({ key: '' })).toBe(true)
  })

  it('lists every group once, folders and moved-to ones, A-Z, CliMayte workers left out', () => {
    const chats = [chat('a'), chat('b', { cwd: 'C:/work/Beta', group: 'Launch' }), chat('c', { cwd: 'c:/work/alpha' })]
    const external = [{ cwd: 'C:/x/Gamma', group: null, source: 'desktop' as const }, { cwd: 'C:/x/Worker', group: null, source: 'climayte' as const }]
    expect(groupChoices(chats, external)).toEqual(['alpha', 'Beta', 'Gamma', 'Launch'])
  })
})

describe('status glyph language', () => {
  it('idle is a ring, running a blinking dot', () => {
    expect(statusGlyph({ status: 'idle', unread: false })).toMatchObject({ shape: 'ring', tone: 'muted', motion: 'none' })
    expect(statusGlyph({ status: 'working', unread: false })).toMatchObject({ shape: 'dot', tone: 'muted', motion: 'blink' })
  })

  it('a finished turn unread is a solid green dot; a question is orange and pulsing', () => {
    expect(statusGlyph({ status: 'idle', unread: true })).toMatchObject({ shape: 'dot', tone: 'success', motion: 'none', label: 'Done, unread' })
    expect(statusGlyph({ status: 'stopped', unread: true })).toMatchObject({ shape: 'dot', tone: 'success' })
    expect(statusGlyph({ status: 'closed', unread: true })).toMatchObject({ shape: 'dot', tone: 'success', active: true })
    expect(statusGlyph({ status: 'needs_you', unread: true })).toMatchObject({ shape: 'dot', tone: 'warning', motion: 'pulse' })
  })

  it('a replied chat whose background tasks still run is solid orange, read or not, never green or the calm ring', () => {
    // Owner, 2026-10-14: done speaking with workers still running is orange; green is done with nothing running.
    for (const status of ['idle', 'stopped', 'closed'] as const)
      expect(statusGlyph({ status, unread: false, climayteActive: 2 })).toMatchObject({ shape: 'dot', tone: 'warning', motion: 'none', active: true, label: 'Replied, workers still running' })
    expect(statusGlyph({ status: 'idle', unread: true, climayteActive: 1 })).toMatchObject({ tone: 'warning', motion: 'none', label: 'Replied, workers still running' })
    // A question pulses; the replied-with-workers dot does not, so the two oranges differ.
    expect(statusGlyph({ status: 'needs_you', unread: true, climayteActive: 1 })).toMatchObject({ tone: 'warning', motion: 'pulse' })
  })

  it("a replied chat whose own background commands still run has the running look, with no CliMayte worker", () => {
    // The NexusCode chat, 2026-10-04: read, deploy still building, a gray ring; it must never look done while it runs.
    expect(statusGlyph({ status: 'idle', unread: false, climayteActive: 0, backgroundActive: 2 })).toMatchObject({ shape: 'dot', tone: 'warning', motion: 'none' })
  })

  it('once read, a finished chat is the calm idle ring again', () => {
    expect(statusGlyph({ status: 'idle', unread: false })).toMatchObject({ shape: 'ring', tone: 'muted' })
    expect(statusGlyph({ status: 'closed', unread: false })).toMatchObject({ shape: 'ring', active: false })
  })

  it('a row is quiet, its title and logo dimmed, when nothing in it runs, waits on you or is unread; selected never dims', () => {
    // Owner, 2026-10-10: "the text should be dimmed and so should the icon" when the task is not running. The one predicate is
    // isQuiet (ProjectRing reads it too); the old per-glyph dim flag dimmed a closed unread chat's title and not its idle one.
    for (const g of [statusGlyph({ status: 'idle', unread: false }), statusGlyph({ status: 'closed', unread: false }), externalGlyph({ status: 'stale', unread: false })])
      expect(dimText(g, false)).toBe('text-text-muted')
    expect(dimText(statusGlyph({ status: 'idle', unread: false }), true)).toBe('')
    for (const g of [
      statusGlyph({ status: 'working', unread: false }),
      statusGlyph({ status: 'needs_you', unread: true }),
      statusGlyph({ status: 'idle', unread: true }),
      statusGlyph({ status: 'closed', unread: true }),
      statusGlyph({ status: 'idle', unread: false, climayteActive: 1 }),
      statusGlyph({ status: 'error', unread: false })
    ])
      expect(dimText(g, false)).toBe('')
  })

  it('an idle row whose sub-tasks run is solid orange and is not dimmed; a row with none keeps its ring', () => {
    // The sub-tasks are CliMayte tasks, HSwarm jobs or nested rows; Sidebar.vue counts them and passes the count here.
    const idle = statusGlyph({ status: 'idle', unread: false })
    expect(withThreads(idle, 0)).toBe(idle)
    expect(withThreads(idle, 2)).toMatchObject({ shape: 'dot', tone: 'warning', motion: 'none', active: true, label: 'Replied, workers still running' })
    expect(dimText(withThreads(idle, 1), false)).toBe('')
  })

  it('sub-tasks never take a question its pulse or an error its red; a green unread row with sub-tasks turns orange', () => {
    expect(withThreads(statusGlyph({ status: 'needs_you', unread: false }), 2)).toMatchObject({ tone: 'warning', motion: 'pulse' })
    expect(withThreads(statusGlyph({ status: 'error', unread: false }), 2)).toMatchObject({ tone: 'danger' })
    // A Prime on a usage limit keeps its pink ring while its threads run: the limit is its own row in the rulebook.
    expect(withThreads(statusGlyph({ status: 'limited', unread: false }), 2)).toMatchObject({ shape: 'ring', tone: 'limited', label: 'Usage limit' })
    expect(withThreads(statusGlyph({ status: 'idle', unread: true }), 1)).toMatchObject({ tone: 'warning', motion: 'none', label: 'Replied, workers still running' })
    expect(withThreads(statusGlyph({ status: 'working', unread: false }), 1)).toMatchObject({ tone: 'muted', motion: 'blink' })
  })

  it('a usage limit is its own pink ring, unread or not; error stays red', () => {
    for (const unread of [true, false]) expect(statusGlyph({ status: 'limited', unread })).toMatchObject({ shape: 'ring', tone: 'limited' })
    expect(statusGlyph({ status: 'error', unread: true })).toMatchObject({ shape: 'dot', tone: 'danger' })
  })

  it('draws each glyph with its own token', () => {
    expect(glyphDotClass(statusGlyph({ status: 'idle', unread: true }))).toBe('bg-[var(--status-done)]')
    expect(glyphDotClass(statusGlyph({ status: 'idle', unread: false, climayteActive: 1 }))).toBe('bg-[var(--status-needs-you)]')
    expect(glyphDotClass(statusGlyph({ status: 'needs_you', unread: true }))).toBe('bg-[var(--status-needs-you)] animate-dot-pulse')
    expect(glyphDotClass(statusGlyph({ status: 'working', unread: false }))).toBe('bg-[var(--status-working)] run-pulse')
    expect(glyphDotClass(statusGlyph({ status: 'limited', unread: true }))).toBe('border-[1.5px] border-[var(--status-limited)]')
    expect(glyphDotClass(statusGlyph({ status: 'error', unread: true }))).toBe('bg-[var(--status-error)]')
  })

  it('only an HSwarm job is blue, pulsing as a working dot does (owner, 2026-10-05)', () => {
    const chats = (['starting', 'working', 'needs_you', 'idle', 'stopped', 'error', 'limited', 'closed'] as const).flatMap((status) =>
      [true, false].map((unread) => statusGlyph({ status, unread }))
    )
    const outside = (['working', 'needs_you', 'idle', 'stale'] as const).flatMap((status) => [true, false].map((unread) => externalGlyph({ status, unread })))
    for (const g of [...chats, statusGlyph({ status: 'idle', unread: false, climayteActive: 1 }), ...outside]) expect(glyphDotClass(g)).not.toContain('accent')
    // A CliMayte task's mark is gray; an HSwarm job's dot pulses as a working chat's gray dot does, only blue.
    expect(runPulse('gray')).not.toContain('accent')
    expect(glyphDotClass(SWARM_RUNNING).replace('bg-accent-text', 'bg-[var(--status-working)]')).toBe(glyphDotClass(statusGlyph({ status: 'working', unread: false })))
  })

  it('formats elapsed time short', () => {
    expect(elapsedLabel(1000, 13_000)).toBe('12s')
    expect(elapsedLabel(0, 4 * 60_000 + 5000)).toBe('4m')
    expect(elapsedLabel(0, 65 * 60_000)).toBe('1h 5m')
    expect(elapsedLabel(null)).toBe('')
  })

  it('says how long ago in its largest whole unit, minutes to years', () => {
    const now = Date.UTC(2026, 9, 14)
    const ago = (ms: number) => timeAgo(now - ms, now)
    const MIN = 60_000
    const DAY = 1440 * MIN
    expect([
      ago(59_000),
      ago(MIN),
      ago(59 * MIN),
      ago(60 * MIN),
      ago(23 * 60 * MIN),
      ago(DAY),
      ago(6 * DAY),
      ago(7 * DAY),
      ago(29 * DAY),
      ago(31 * DAY),
      ago(364 * DAY),
      ago(365 * DAY),
      ago(800 * DAY)
    ]).toEqual([
      'just now',
      '1 minute ago',
      '59 minutes ago',
      '1 hour ago',
      '23 hours ago',
      '1 day ago',
      '6 days ago',
      '1 week ago',
      '4 weeks ago',
      '1 month ago',
      '11 months ago',
      '1 year ago',
      '2 years ago'
    ])
    // a clock a little behind the stamp is "just now", never a negative age
    expect(timeAgo(now + 5000, now)).toBe('just now')
  })
})

describe('row menu', () => {
  const show = (entries: RowMenuEntry[]) =>
    entries.map((e) => (e === 'separator' ? '-' : 'items' in e ? `${e.label} >` : `${e.label}${e.shortcut ? ` ${e.shortcut}` : ''}${e.disabled ? ' (off)' : ''}`))
  const sub = (entries: RowMenuEntry[], label: string) => {
    const found = entries.find((e): e is Extract<RowMenuEntry, { items: unknown }> => e !== 'separator' && 'items' in e && e.label === label)!
    return found.items.map((e) => (e === 'separator' ? '-' : `${e.label}${e.checked ? ' *' : ''}${e.disabled ? ' (off)' : ''}`))
  }
  const ext = (over: Partial<ExternalSession> = {}): ExternalSession => ({
    id: 'sess-1',
    title: 'Outside',
    cwd: 'C:/work/alpha',
    source: 'desktop',
    instance: null,
    status: 'idle',
    activity: null,
    lastActivityAt: 1,
    model: null,
    accountId: null,
    canResume: true,
    fromPc: null,
    pinned: false,
    archived: false,
    unread: false,
    group: null,
    ...over
  })

  it('offers Pin service on a Desk chat: Claude ticked, Codex and ChatGPT by what is signed in, the pinned one naming its account', () => {
    const services: ChatServiceInfo[] = [
      { kind: 'claude', label: 'Claude', ready: true, accounts: 1 },
      { kind: 'codex', label: 'Codex', ready: true, accounts: 1 },
      { kind: 'chatgpt', label: 'ChatGPT', ready: false, why: 'No Free ChatGPT login is signed in', accounts: 0 }
    ]
    const pinItems = (entries: RowMenuEntry[]) => (entries.find((e) => e !== 'separator' && 'items' in e && e.label === 'Pin service') as { items: RowMenuItem[] }).items
    const menu = rowMenu(chatRow(chat('a', { sessionId: 's1' })), [], null, null, services)
    expect(show(menu)).toContain('Pin service >')
    expect(pinItems(menu).map((i) => [i.label, i.checked, i.disabled])).toEqual([
      ['Claude', true, false],
      ['Codex', false, false],
      ['ChatGPT', false, true]
    ])
    expect(pinItems(menu)[2].title).toBe('No Free ChatGPT login is signed in')

    const pinned = chat('a', { sessionId: 's1', service: 'codex', serviceThreads: { codex: { accountId: 'codex-1', label: '#196 example', threadId: 't1' } } })
    expect(pinItems(rowMenu(chatRow(pinned), [], null, null, services)).find((i) => i.checked)).toMatchObject({ label: 'Codex', hint: '#196 example' })
    expect(pinItems(rowMenu(chatRow(pinned), [], null, null, null)).map((i) => i.disabled)).toEqual([false, true, true])

    expect(show(rowMenu(externalRow(ext()), [], null, null, services))).not.toContain('Pin service >')
  })

  it("keeps a chat on another PC's Codex there: Codex on while that PC is connected, whatever this machine's accounts, and nothing else", () => {
    // This machine has no Codex account of its own; the other PC's relay is open (pcs) or not.
    const services = (pcs?: string[]): ChatServiceInfo[] => [
      { kind: 'claude', label: 'Claude', ready: true, accounts: 1 },
      { kind: 'codex', label: 'Codex', ready: false, why: pcs ? 'No Codex account is signed in.' : 'AgentHydra is not answering, so Desk cannot see the Codex accounts.', accounts: 0, ...(pcs ? { pcs } : {}) },
      { kind: 'chatgpt', label: 'ChatGPT', ready: true, accounts: 1 }
    ]
    const hub = chat('h', { sessionId: 't1', service: 'codex', serviceThreads: { codex: { accountId: 'hub:other-pc', label: 'OTHER-PC', threadId: 't1' } } })
    const pin = (c: ChatSummary, s: ChatServiceInfo[] | null) => {
      const menu = rowMenu(chatRow(c), [], null, null, s)
      const found = menu.find((e): e is Extract<RowMenuEntry, { items: unknown }> => e !== 'separator' && 'items' in e && e.label === 'Pin service')!
      return (found.items as RowMenuItem[]).map((i) => [`${i.label}${i.checked ? ' *' : ''}${i.disabled ? ' (off)' : ''}`, i.title ?? null])
    }
    const only = "OTHER-PC's chat goes on only on that PC's Codex: its folder is there."
    expect(pin(hub, services(['hub:other-pc']))).toEqual([
      ['Claude (off)', only],
      ['Codex *', null],
      ['ChatGPT (off)', only]
    ])
    expect(pin(hub, services([]))[1]).toEqual(['Codex * (off)', 'OTHER-PC is not connected to the Codex hub now (it is off, or its pusher is not running).'])
    expect(pin(hub, services())[1]).toEqual(['Codex * (off)', 'AgentHydra is not answering, so Desk cannot see the Codex accounts.'])
    expect(pin(hub, null).map(([label]) => label)).toEqual(['Claude (off)', 'Codex * (off)', 'ChatGPT (off)'])
    // Pinned off Codex before, it can go back to that PC's Codex.
    expect(pin({ ...hub, service: null }, services(['hub:other-pc']))[1]).toEqual(['Codex', null])
    // A chat on this machine's Codex goes by this machine's accounts.
    const own = chat('o', { sessionId: 't2', service: 'codex', serviceThreads: { codex: { accountId: 'codex-1', label: '#196 example', threadId: 't2' } } })
    expect(pin(own, services(['hub:other-pc']))).toEqual([
      ['Claude', null],
      ['Codex * (off)', 'No Codex account is signed in.'],
      ['ChatGPT', null]
    ])
  })

  it('is the real menu for an idle chat under a line naming it: Open in, Pin, Mark as unread, Rename, Fork, Pin service, Move to group, Archive, Delete', () => {
    expect(show(rowMenu(chatRow(chat('a', { sessionId: 's1' }))))).toEqual([
      's1',
      '-',
      'Open in >',
      '-',
      'Pin P',
      'Mark as unread U',
      'Rename R',
      'Add note… N',
      'Fork F',
      'Pin service >',
      '-',
      'Move to group >',
      '-',
      'Archive A',
      'Delete D'
    ])
    expect(sub(rowMenu(chatRow(chat('a', { sessionId: 's1' }))), 'Open in')).toEqual(['File Explorer', 'Copy resume command', 'Copy session ID'])
    // a chat with a note offers to edit it
    expect(show(rowMenu(chatRow(chat('a', { sessionId: 's1', note: 'Ask about the release' }))))).toContain('Edit note… N')
    // one that has done something says when under its first line
    const acted = rowMenu(chatRow(chat('a', { sessionId: 's1', lastActionAt: 1234 })))
    expect(show(acted).slice(0, 3)).toEqual(['s1', 'Last action', '-'])
    expect(acted[1]).toMatchObject({ action: 'lastAction', since: 1234 })
  })

  it('follows the state: Stop above Pin while working, Unpin, Mark as read, Unarchive', () => {
    expect(show(rowMenu(chatRow(chat('a', { sessionId: 's1', status: 'working', pinned: true, unread: true, archived: true }))))).toEqual([
      's1',
      '-',
      'Open in >',
      '-',
      'Stop',
      'Unpin P',
      'Mark as read U',
      'Rename R',
      'Add note… N',
      'Fork F',
      'Pin service >',
      '-',
      'Move to group >',
      '-',
      'Unarchive A',
      'Delete D'
    ])
  })

  it('a chat with no session yet cannot be forked or copied; a fork not started yet can be forked again', () => {
    const fresh = rowMenu(chatRow(chat('a')))
    expect(show(fresh)).toContain('Fork F (off)')
    expect(sub(fresh, 'Open in')).toEqual(['File Explorer', 'Copy resume command (off)', 'Copy session ID (off)'])
    expect(show(rowMenu(chatRow(chat('f', { forkedFrom: 's1' }))))).toContain('Fork F')
  })

  it('an outside session has the same menu without Delete, with Move to account and Duplicate to account, and Archive says why', () => {
    const entries = rowMenu(externalRow(ext()))
    expect(show(entries)).toEqual(['sess-1', 'Last action', '-', 'Open in >', '-', 'Pin P', 'Mark as unread U', 'Rename R', 'Add note… N', 'Fork F', 'Duplicate to account >', '-', 'Move to group >', 'Move to account >', '-', 'Archive A'])
    expect(entries[1]).toMatchObject({ since: 1 }) // the session's lastActivityAt
    const archive = entries.find((e) => e !== 'separator' && !('items' in e) && e.action === 'archive') as RowMenuItem
    expect(archive.title).toMatch(/never deleted here/)
    expect(sub(entries, 'Open in')).toEqual(['File Explorer', 'Copy resume command', 'Copy session ID'])
    // a Codex session has no claude --resume and no fork
    const codex = rowMenu(externalRow(ext({ source: 'codex', cwd: null })))
    expect(show(codex)).toContain('Fork F (off)')
    expect(show(codex)).toContain('Duplicate to account >')
    expect(sub(codex, 'Open in')).toEqual(['File Explorer (off)', 'Copy resume command (off)', 'Copy session ID'])
  })

  it('the first line is the id as the session header shows it and the account it runs on; it copies the whole id', () => {
    const accounts: AccountChoice[] = [{ ref: 'desktop:C:/p/72', num: 72, name: 'example', running: true }]
    const first = (entries: RowMenuEntry[]) => entries[0] as RowMenuItem
    const outside = first(rowMenu(externalRow(ext({ id: '13e61bee-0000-4000-8000-000000000000', instance: '#72' })), [], accounts))
    expect(outside).toMatchObject({ action: 'copyId', label: '13e61bee', value: '13e61bee-0000-4000-8000-000000000000', hint: '#72 example' })
    // AgentHydra's list not read yet: the number alone; an instance named by its folder: that name
    expect(first(rowMenu(externalRow(ext({ instance: '#72' })))).hint).toBe('#72')
    expect(first(rowMenu(externalRow(ext({ instance: 'Claude-Work' })))).hint).toBe('Claude-Work')
    expect(first(rowMenu(externalRow(ext()))).hint).toBeUndefined()
    // a chat of our own: its session id, else its own id before it has one; its account as the window names it
    expect(first(rowMenu(chatRow(chat('a', { sessionId: 's1' }))))).toMatchObject({ value: 's1', hint: '#1' })
    expect(first(rowMenu(chatRow(chat('a')))).value).toBe('a')
  })

  it('Move to account lists the desktop accounts, running ones first, the current one ticked and off; only a session of another app on this PC has it', () => {
    const accounts: AccountChoice[] = [
      { ref: 'desktop:C:/p/9', num: 9, name: 'nine', running: false },
      { ref: 'desktop:C:/p/72', num: 72, name: 'example', running: true },
      { ref: 'desktop:C:/p/3', num: 3, name: 'three', running: true }
    ]
    const entries = rowMenu(externalRow(ext({ instance: '#72' })), [], accounts)
    expect(sub(entries, 'Move to account')).toEqual(['Unassigned', '-', '#3 three', '#72 example * (off)', '-', '#9 nine'])
    const closed = (entries.find((e) => e !== 'separator' && 'items' in e && e.label === 'Move to account') as Extract<RowMenuEntry, { items: unknown }>).items.at(-1) as RowMenuItem
    expect(closed).toMatchObject({ action: 'moveToAccount', value: 'desktop:C:/p/9', hint: 'closed' })
    expect(sub(rowMenu(externalRow(ext())), 'Move to account')).toEqual(['Unassigned', '-', 'Reading accounts… (off)'])
    const has = (entries: RowMenuEntry[]) => show(entries).includes('Move to account >')
    expect(has(rowMenu(externalRow(ext({ source: 'cli' }))))).toBe(true)
    expect(has(rowMenu(externalRow(ext({ fromPc: 'OTHER-PC' }))))).toBe(false)
    expect(has(rowMenu(externalRow(ext({ source: 'codex', fromPc: 'OTHER-PC' }))))).toBe(false)
    expect(has(rowMenu(chatRow(chat('a', { sessionId: 's1' }))))).toBe(false)
  })

  it('a Codex chat moves only to the Codex accounts, the one its account name says ticked and off', () => {
    const desktop: AccountChoice[] = [{ ref: 'desktop:C:/p/3', num: 3, name: 'three', running: true }]
    const codex: AccountChoice[] = [
      { ref: 'codex:b', num: 196, name: 'spare', running: false, tag: 'second' },
      { ref: 'codex:a', num: 61, name: 'Example Owner', running: true, tag: 'work' }
    ]
    // AgentHydra's list names a Codex chat's account by the instance's own name, which `tag` matches
    const entries = rowMenu(externalRow(ext({ source: 'codex', instance: 'work' })), [], desktop, codex)
    expect(sub(entries, 'Move to account')).toEqual(['Unassigned', '-', '#61 Example Owner * (off)', '-', '#196 spare'])
    expect((entries[0] as RowMenuItem).hint).toBe('#61 Example Owner')
    expect(sub(rowMenu(externalRow(ext({ source: 'codex' })), [], desktop, []), 'Move to account')).toEqual(['Unassigned', '-', 'No Codex accounts (off)'])
    // A Codex copy goes to another Codex account: the one the chat is on is off, Unassigned or not.
    expect(sub(entries, 'Duplicate to account')).toEqual(['#61 Example Owner (off)', '-', '#196 spare'])
    const parked = rowMenu(externalRow(ext({ source: 'codex', instance: 'work', unassigned: true })), [], desktop, codex)
    expect(sub(parked, 'Move to account')).toEqual(['Unassigned * (off)', '-', '#61 Example Owner', '-', '#196 spare'])
    expect(sub(parked, 'Duplicate to account')).toEqual(['#61 Example Owner (off)', '-', '#196 spare'])
  })

  it('a desktop chat AgentHydra names by its account’s own name is on that account: ticked to move, current to duplicate', () => {
    // AgentHydra's list gives a named desktop instance's chats its name ("work"), not "#61"; on 2026-10-13 such a row
    // was on no account (nothing ticked, and Unassign named no account to archive it on).
    ahInstances.value = [
      { num: 61, name: 'work', dir: 'C:/p/61', isRunning: true, account: null },
      { num: 9, name: 'nine', dir: 'C:/p/9', isRunning: false, account: null }
    ]
    try {
      const entries = rowMenu(externalRow(ext({ instance: 'work' })), [], accountChoices.value)
      expect((entries[0] as RowMenuItem).hint).toBe('#61 work')
      expect(sub(entries, 'Move to account')).toEqual(['Unassigned', '-', '#61 work * (off)', '-', '#9 nine'])
      const items = (entries.find((e) => e !== 'separator' && 'items' in e && e.label === 'Duplicate to account') as Extract<RowMenuEntry, { items: unknown }>).items
      expect(items[0]).toMatchObject({ label: '#61 work', hint: 'current' })
    } finally {
      ahInstances.value = null
    }
  })

  it('an Unassigned chat is on no account: its first line says so, Move to account ticks Unassigned and no account', () => {
    const accounts: AccountChoice[] = [
      { ref: 'desktop:C:/p/72', num: 72, name: 'example', running: true },
      { ref: 'desktop:C:/p/3', num: 3, name: 'three', running: true }
    ]
    const entries = rowMenu(externalRow(ext({ instance: '#72', unassigned: true })), [], accounts)
    expect((entries[0] as RowMenuItem).hint).toBe('Unassigned')
    expect(sub(entries, 'Move to account')).toEqual(['Unassigned * (off)', '-', '#3 three', '#72 example'])
    const items = (entries.find((e) => e !== 'separator' && 'items' in e && e.label === 'Duplicate to account') as Extract<RowMenuEntry, { items: unknown }>).items
    expect(items.map((e) => (e === 'separator' ? '-' : e.hint ?? ''))).toEqual(['', ''])
  })

  it('Duplicate to account lists every desktop account, the one it is on included and marked current', () => {
    const accounts: AccountChoice[] = [
      { ref: 'desktop:C:/p/9', num: 9, name: 'nine', running: false },
      { ref: 'desktop:C:/p/72', num: 72, name: 'example', running: true }
    ]
    const entries = rowMenu(externalRow(ext({ instance: '#72' })), [], accounts)
    const items = (entries.find((e) => e !== 'separator' && 'items' in e && e.label === 'Duplicate to account') as Extract<RowMenuEntry, { items: unknown }>).items
    expect(items.map((e) => (e === 'separator' ? '-' : `${e.label} [${e.hint ?? ''}]${e.disabled ? ' (off)' : ''}`))).toEqual(['#72 example [current]', '-', '#9 nine [closed]'])
    expect(items[0]).toMatchObject({ action: 'duplicateToAccount', value: 'desktop:C:/p/72' })
  })

  it('Move to group lists every group with a check on the current one, then New group and Remove from group', () => {
    const groups = ['alpha', 'Beta', 'Launch']
    expect(sub(rowMenu(chatRow(chat('a')), groups), 'Move to group')).toEqual(['alpha *', 'Beta', 'Launch', '-', 'New group…'])
    expect(sub(rowMenu(chatRow(chat('a', { group: 'launch' })), groups), 'Move to group')).toEqual(['alpha', 'Beta', 'Launch *', '-', 'New group…', 'Remove from group'])
    expect(sub(rowMenu(chatRow(chat('a'))), 'Move to group')).toEqual(['New group…'])
  })

  it('letter keys run their item while the menu is open; disabled and unknown keys run nothing', () => {
    const entries = rowMenu(chatRow(chat('a', { sessionId: 's1' })))
    const action = (key: string) => shortcutItem(entries, key)?.action ?? null
    expect(['p', 'U', 'r', 'n', 'f', 'a', 'd'].map(action)).toEqual(['pin', 'markUnread', 'rename', 'note', 'fork', 'archive', 'delete'])
    expect(action('x')).toBeNull()
    expect(action('Enter')).toBeNull()
    expect(shortcutItem(rowMenu(chatRow(chat('a'))), 'f')).toBeNull()
    expect(shortcutItem(rowMenu(chatRow(chat('a', { pinned: true, unread: true, archived: true }))), 'p')?.action).toBe('unpin')
    expect(shortcutItem(rowMenu(externalRow(ext())), 'd')).toBeNull()
  })

  it('maps an item to its patch; moving to the row own folder group is back to the folder', () => {
    const row = chatRow(chat('a'))
    const item = (action: RowMenuItem['action'], label = '') => ({ action, label })
    expect(rowPatch(item('pin'), row)).toEqual({ pinned: true })
    expect(rowPatch(item('unarchive'), row)).toEqual({ archived: false })
    expect(rowPatch(item('markUnread'), row)).toEqual({ unread: true })
    expect(rowPatch(item('markRead'), row)).toEqual({ unread: false })
    expect(rowPatch(item('moveTo', 'Launch'), row)).toEqual({ group: 'Launch' })
    expect(rowPatch(item('moveTo', 'ALPHA'), row)).toEqual({ group: null })
    expect(rowPatch(item('removeFromGroup'), row)).toEqual({ group: null })
    expect(rowPatch(item('delete'), row)).toBeNull()
    expect(resumeCommand('abc-123')).toBe('claude --resume abc-123')
  })
})

describe('row menu letter keys', () => {
  // A stand-in DOM: closest() walks up the parents, as the real one does for these two selectors.
  type Node = { role?: string; tag?: string; parent?: Node; closest(selector: string): Node | null }
  function node(over: { role?: string; tag?: string }, parent?: Node): Node {
    const n: Node = {
      ...over,
      parent,
      closest(selector) {
        for (let at: Node | undefined = n; at; at = at.parent) if (selector.includes('role') ? at.role === 'menu' : at.tag === 'input') return at
        return null
      }
    }
    return n
  }
  const entries = rowMenu(chatRow(chat('a', { sessionId: 's1' })))

  function press(key: string, target: Node, opts: { ctrlKey?: boolean } = {}) {
    const clicked: string[] = []
    const root = Object.assign(menu, { querySelector: (selector: string) => ({ click: () => clicked.push(selector) }) })
    let stopped = false
    const e = { key, ctrlKey: false, metaKey: false, altKey: false, ...opts, target, currentTarget: root, preventDefault() {}, stopPropagation: () => (stopped = true) }
    runShortcut(e as unknown as KeyboardEvent, entries)
    return { clicked, stopped }
  }
  const menu = node({ role: 'menu' })
  const item = node({}, menu)
  const subItem = node({}, node({ role: 'menu' }, menu))
  const field = node({ tag: 'input' }, menu)

  it('a letter typed in the menu runs its item', () => {
    expect(press('a', item)).toEqual({ clicked: ['[data-shortcut="A"]'], stopped: true })
    expect(press('P', menu).clicked).toEqual(['[data-shortcut="P"]'])
  })

  it('a letter typed in a submenu (Move to group, Account) or a text field is left to them', () => {
    expect(press('a', subItem)).toEqual({ clicked: [], stopped: false })
    expect(press('a', field)).toEqual({ clicked: [], stopped: false })
    expect(press('a', item, { ctrlKey: true }).clicked).toEqual([])
  })
})

describe('remembered filter, hidden chats, outside renames', () => {
  it('reads a stored filter back, anything unknown as Active', () => {
    expect(['active', 'archived', 'all'].map(parseFilter)).toEqual(['active', 'archived', 'all'])
    expect([null, undefined, '', 'Archived', 'toString', '"all"'].map(parseFilter)).toEqual(['active', 'active', 'active', 'active', 'active', 'active'])
  })

  it('a chat the filter or the search hides comes back with the list that shows it', () => {
    const fresh = chat('n', { updatedAt: 100, title: 'New one' })
    const chats = [chat('z', { archived: true }), fresh]
    const shown = revealChat(fresh, 'archived')
    expect(shown).toEqual({ query: '', filter: 'active' })
    expect(groupChats(chats, { query: 'shader', filter: 'archived' }).folders).toEqual([])
    expect(ids(groupChats(chats, shown).folders[0])).toEqual(['n'])
    expect(revealChat(fresh, 'all')).toEqual({ query: '', filter: 'all' })
    expect(revealChat(chat('z', { archived: true }), 'active')).toEqual({ query: '', filter: 'all' })
  })

  it('renaming an outside session: an emptied field is its own name again, an unchanged one sends nothing', () => {
    expect(externalRename('  Ops board ', 'Outside')).toBe('Ops board')
    expect(externalRename('Outside', 'Outside')).toBeUndefined()
    expect(externalRename('   ', 'Renamed here')).toBeNull()
  })
})

describe('footer account', () => {
  const accounts = [{ id: '68', label: '#68 eek someone@example.com (Max 20x)', plan: 'Max 20x' }]
  it('shows the short name and the plan family, never the email', () => {
    expect(accountFace('68', accounts)).toEqual({ initial: 'E', name: 'eek', plan: 'Max' })
  })
  it('falls back to Auto with the account count', () => {
    expect(accountFace('auto', accounts)).toEqual({ initial: 'A', name: 'Auto', plan: '1 accounts' })
  })
})

describe('sidebar order', () => {
  // The owner, 2026-10-04: sending into Connections shot it to the top; rows keep their place. Owner, 2026-10-09: folder
  // groups are never saved, they are listed A-Z by label whatever the order of their rows.
  it('a message sent later moves no row; a new folder joins in its A-Z place; a row drag reorders inside its group', () => {
    const before = [chat('a1', { cwd: 'C:/work/alpha', updatedAt: 30 }), chat('a2', { cwd: 'C:/work/alpha', updatedAt: 20 }), chat('c1', { cwd: 'C:/work/conn', updatedAt: 10 })]
    const first = groupChats(before, { order: { rows: [] } })
    let order = { rows: recordOrder([], first.folders.flatMap((f) => f.entries.map((e) => e.id)), 'top') }
    expect(first.folders.map((f) => f.label)).toEqual(['alpha', 'conn'])

    const sent = [chat('a1', { cwd: 'C:/work/alpha', updatedAt: 30 }), chat('a2', { cwd: 'C:/work/alpha', updatedAt: 99 }), chat('c1', { cwd: 'C:/work/conn', updatedAt: 100 })]
    const after = groupChats(sent, { order })
    expect(after.folders.map((f) => f.label)).toEqual(['alpha', 'conn'])
    expect(ids(after.folders[0])).toEqual(['a1', 'a2'])
    // without a saved order the folders are still A-Z, not by activity
    expect(groupChats(sent).folders.map((f) => f.label)).toEqual(['alpha', 'conn'])

    const added = groupChats([...sent, chat('n1', { cwd: 'C:/work/new', updatedAt: 1 })], { order })
    expect(added.folders.map((f) => f.label)).toEqual(['alpha', 'conn', 'new'])

    order = { ...order, rows: moveInOrder(order.rows, 'a2', 'a1') }
    const dragged = groupChats(sent, { order })
    expect(ids(dragged.folders[0])).toEqual(['a2', 'a1'])
    expect(dragged.folders.map((f) => f.label)).toEqual(['alpha', 'conn'])
  })

  it('folders sort A-Z by label, ignoring case, numbers in their own order (scratch-2 before scratch-10)', () => {
    const cases: [string[], string[]][] = [
      [['scratch-10', 'scratch-2', 'Connections', 'monkeyWerx'], ['Connections', 'monkeyWerx', 'scratch-2', 'scratch-10']],
      [['No folder', 'alpha', 'Beta'], ['alpha', 'Beta', 'No folder']]
    ]
    for (const [labels, sorted] of cases) {
      expect(sortFolders(labels.map((label) => ({ label }))).map((g) => g.label)).toEqual(sorted)
    }
  })

  // Owner, 2026-10-04: the desk list and the cloud list share one order, so one recording what it shows
  // must not push the rows only the other shows to the end (they drifted with every toggle).
  it('recording what a list shows never moves a saved key: the desk adds its new ones at the top, the cloud its own at the end', () => {
    const saved = ['desk-a', 'cloud-x', 'desk-b', 'cloud-y']
    expect(recordOrder(saved, ['desk-b', 'desk-a'], 'top')).toEqual(saved)
    expect(recordOrder(saved, ['desk-n', 'desk-b', 'desk-m'], 'top')).toEqual(['desk-n', 'desk-m', ...saved])
    expect(recordOrder(saved, ['cloud-y', 'cloud-z', 'cloud-z'], 'end')).toEqual([...saved, 'cloud-z'])
  })
})

describe('a chat that turns orange', () => {
  it('goes to the top of its group, the latest finish first; finishing again unread does not move it', () => {
    const working = (id: string) => chat(id, { status: 'working', unread: false })
    const done = (id: string) => chat(id, { status: 'idle', unread: true })
    const rows = ['a', 'b', 'c']
    const was = new Map([['a', false], ['b', false], ['c', false]])
    const entries = (list: ReturnType<typeof chat>[]) => groupChats(list).folders[0]!.entries

    const afterC = raiseNewlyOrange(rows, entries([working('a'), working('b'), done('c')]), was)
    expect(afterC).toEqual(['c', 'a', 'b'])
    was.set('c', true)
    const afterB = raiseNewlyOrange(afterC, entries([working('a'), done('b'), done('c')]), was)
    expect(afterB).toEqual(['b', 'c', 'a'])
    was.set('b', true)
    // nothing new turned orange: nothing moves
    expect(raiseNewlyOrange(afterB, entries([working('a'), done('b'), done('c')]), was)).toEqual(['b', 'c', 'a'])
  })
})

describe('a chat started from another chat nests under it', () => {
  function ext(id: string, over: Partial<ExternalSession> = {}): ExternalSession {
    return { id, title: `Ext ${id}`, cwd: 'C:/work/alpha', source: 'desktop', instance: null, status: 'idle', activity: null, lastActivityAt: 20, model: null, accountId: null, canResume: false, fromPc: null, pinned: false, archived: false, unread: false, group: null, ...over }
  }
  // Each shown row as "group row" (and "<- the row it sits under"), in the order the sidebar lists them.
  const layout = (g: SidebarGroups) => [g.pinned, ...g.folders, g.archived].flatMap((x) => (x ? x.entries.map((e) => `${x.key} ${entryKey(e)}${e.under ? ` <- ${e.under}` : ''}`) : []))
  const cases: [string, ExternalSession[], string[]][] = [
    [
      'a child is placed under its parent, even when newer',
      [ext('p', { lastActivityAt: 30 }), ext('c', { parentId: 'p', lastActivityAt: 40 }), ext('x', { lastActivityAt: 10 })],
      ['C:/work/alpha external:p', 'C:/work/alpha external:c <- external:p', 'C:/work/alpha external:x']
    ],
    [
      'a grandchild is one step in, under the top parent',
      [ext('p', { lastActivityAt: 30 }), ext('c', { parentId: 'p', lastActivityAt: 20 }), ext('g', { parentId: 'c', lastActivityAt: 10 })],
      ['C:/work/alpha external:p', 'C:/work/alpha external:c <- external:p', 'C:/work/alpha external:g <- external:p']
    ],
    [
      'a child whose parent is not shown is an ordinary row',
      [ext('c', { parentId: 'gone', lastActivityAt: 20 }), ext('x', { lastActivityAt: 10 })],
      ['C:/work/alpha external:c', 'C:/work/alpha external:x']
    ],
    [
      'a pinned child stays in Pinned, not under its parent',
      [ext('p', { lastActivityAt: 30 }), ext('c', { parentId: 'p', pinned: true })],
      ['pinned external:c', 'C:/work/alpha external:p']
    ],
    [
      'a child in another folder joins its parent\'s group',
      [ext('p', { lastActivityAt: 30 }), ext('c', { parentId: 'p', cwd: 'C:/work/beta', lastActivityAt: 20 })],
      ['C:/work/alpha external:p', 'C:/work/alpha external:c <- external:p']
    ]
  ]
  for (const [name, external, want] of cases) {
    it(name, () => expect(layout(groupChats([], { external }))).toEqual(want))
  }

  // A row's fold button (owner, 2026-10-10: "I need the ability to collapse subthreads of a subagent").
  const chain = [ext('p', { lastActivityAt: 30 }), ext('c', { parentId: 'p', lastActivityAt: 20 }), ext('g', { parentId: 'c', lastActivityAt: 15 }), ext('x', { lastActivityAt: 10 })]
  const folders = () => groupChats([], { external: chain }).folders
  const rows = (gs: ChatGroup[]) => gs.flatMap((g) => g.entries.map((e) => `${entryKey(e)}${e.under ? ` <- ${e.under}` : ''}`))
  it('a folded row counts the chats under it, grandchildren too, and they leave the list while the other rows stay', () => {
    expect(childrenByRow(folders()).get('external:p')?.map((e) => e.id)).toEqual(['c', 'g'])
    expect(rows(foldChildren(folders(), new Set(['external:p']), () => false))).toEqual(['external:p', 'external:x'])
  })
  it('the open chat stays in sight under its folded row', () => {
    expect(rows(foldChildren(folders(), new Set(['external:p']), (e) => e.id === 'g'))).toEqual(['external:p', 'external:g <- external:p', 'external:x'])
  })
})

describe('a Desk chat started from a manager chat nests under it, indented per depth', () => {
  const deskRows = (gs: SidebarGroups) => [gs.pinned, ...gs.folders, gs.archived].flatMap((x) => (x ? x.entries.map((e) => `${entryKey(e)}${e.under ? ` <- ${e.under}` : ''}`) : []))
  const tree = () =>
    groupChats(
      [chat('p', { updatedAt: 30 }), chat('c', { parentId: 'p', updatedAt: 20 }), chat('g', { parentId: 'c', updatedAt: 15 }), chat('x', { updatedAt: 10 })],
      { external: [] }
    )

  it('a child sits directly below its parent, and a grandchild one level deeper under the same top', () => {
    expect(deskRows(tree())).toEqual(['chat:p', 'chat:c <- chat:p', 'chat:g <- chat:p', 'chat:x'])
    const byId = new Map([...tree().folders].flatMap((g) => g.entries).map((e) => [e.id, e] as const))
    expect(byId.get('c')?.depth).toBe(1)
    expect(byId.get('g')?.depth).toBe(2)
    expect(byId.get('p')?.depth).toBeUndefined()
  })

  it('folding the parent hides its children and grandchildren, and the other chats stay', () => {
    expect(childrenByRow(tree().folders).get('chat:p')?.map((e) => e.id)).toEqual(['c', 'g'])
    expect(deskRows({ ...tree(), folders: foldChildren(tree().folders, new Set(['chat:p']), () => false) })).toEqual(['chat:p', 'chat:x'])
  })
})
