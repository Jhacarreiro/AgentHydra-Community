import { describe, expect, it } from 'bun:test'
import { NO_PICKS, pickClick, prunePicks, type Picks } from '@/components/sidebar/picked'
import { bulkMenu, type AccountChoice, type RowMenuEntry, type RowState } from '@/components/sidebar/logic'

// Rows picked together in the desk list (Ctrl or Shift and a click) and the one menu they share.

const order = ['chat:a', 'chat:b', 'external:c', 'chat:d', 'external:e']
const keys = (p: Picks | null) => (p ? [...p.keys].sort() : null)
const ctrl = { shift: false, toggle: true }
const shift = { shift: true, toggle: false }

describe('picking rows', () => {
  it('a plain click, or any click on a row that cannot be picked, opens the row instead', () => {
    expect(pickClick(NO_PICKS, 'chat:b', { shift: false, toggle: false }, order, 'chat:a')).toBeNull()
    expect(pickClick(NO_PICKS, 'external:added', ctrl, order, 'chat:a')).toBeNull()
    expect(pickClick(NO_PICKS, 'external:added', shift, order, 'chat:a')).toBeNull()
  })

  it('Ctrl picks the open row and the clicked one, then adds or takes away one row at a time', () => {
    const two = pickClick(NO_PICKS, 'chat:d', ctrl, order, 'chat:a')
    expect(keys(two)).toEqual(['chat:a', 'chat:d'])
    const three = pickClick(two!, 'external:c', ctrl, order, 'chat:a')
    expect(keys(three)).toEqual(['chat:a', 'chat:d', 'external:c'])
    expect(keys(pickClick(three!, 'chat:a', ctrl, order, 'chat:a'))).toEqual(['chat:d', 'external:c'])
    // with nothing open, or the open row not in the list, the first Ctrl-click picks that row alone
    expect(keys(pickClick(NO_PICKS, 'chat:b', ctrl, order, null))).toEqual(['chat:b'])
    expect(keys(pickClick(NO_PICKS, 'chat:b', ctrl, order, 'chat:gone'))).toEqual(['chat:b'])
  })

  it('Shift picks the run from the last row clicked to this one, up or down, and Ctrl+Shift adds the run', () => {
    const anchored: Picks = { keys: new Set(), anchor: 'chat:b' }
    expect(keys(pickClick(anchored, 'chat:d', shift, order, 'chat:a'))).toEqual(['chat:b', 'chat:d', 'external:c'])
    expect(keys(pickClick(anchored, 'chat:a', shift, order, null))).toEqual(['chat:a', 'chat:b'])
    // a second Shift-click ranges from the same anchor, replacing the first run
    const first = pickClick(anchored, 'external:e', shift, order, null)!
    expect(keys(pickClick(first, 'external:c', shift, order, null))).toEqual(['chat:b', 'external:c'])
    // no anchor: from the open row; neither: the row alone
    expect(keys(pickClick(NO_PICKS, 'external:c', shift, order, 'chat:a'))).toEqual(['chat:a', 'chat:b', 'external:c'])
    expect(keys(pickClick(NO_PICKS, 'external:c', shift, order, null))).toEqual(['external:c'])
    const both = pickClick({ keys: new Set(['external:e']), anchor: 'chat:a' }, 'chat:b', { shift: true, toggle: true }, order, null)
    expect(keys(both)).toEqual(['chat:a', 'chat:b', 'external:e'])
  })

  it('rows no longer drawn leave the picks, and so does an anchor that went', () => {
    const p: Picks = { keys: new Set(['chat:a', 'external:c']), anchor: 'external:c' }
    expect(prunePicks(p, order)).toBe(p)
    const pruned = prunePicks(p, ['chat:a', 'chat:b'])
    expect(keys(pruned)).toEqual(['chat:a'])
    expect(pruned.anchor).toBeNull()
  })
})

describe('the menu of picked rows', () => {
  const row = (over: Partial<RowState> = {}): RowState => ({
    outside: true,
    stoppable: false,
    pinned: false,
    archived: false,
    unread: false,
    group: null,
    cwd: 'C:/work/alpha',
    sessionId: 's',
    claudeSession: true,
    forkable: true,
    id: 's',
    account: { num: 3, title: null },
    movable: 'desktop',
    ...over
  })
  const accounts: AccountChoice[] = [
    { ref: 'desktop:C:/p/3', num: 3, name: 'three', running: true },
    { ref: 'desktop:C:/p/9', num: 9, name: 'nine', running: true }
  ]
  const show = (entries: RowMenuEntry[]) =>
    entries.map((e) => (e === 'separator' ? '-' : 'items' in e ? `${e.label} >` : `${e.label}${e.disabled ? ' (off)' : ''}`))
  const sub = (entries: RowMenuEntry[], label: string) => {
    const found = entries.find((e): e is Extract<RowMenuEntry, { items: unknown }> => e !== 'separator' && 'items' in e && e.label === label)
    return found?.items.map((e) => (e === 'separator' ? '-' : `${e.label}${e.checked ? ' *' : ''}${e.disabled ? ' (off)' : ''}`)) ?? null
  }

  it('counts the rows and offers what makes sense for many: no Rename, Note, Fork or Open in', () => {
    expect(show(bulkMenu([row(), row({ id: 't', sessionId: 't' })], ['alpha'], accounts))).toEqual([
      '2 selected',
      '-',
      'Pin',
      'Mark as unread',
      'Copy session IDs',
      'Duplicate to account >',
      '-',
      'Move to group >',
      'Move to account >',
      '-',
      'Archive'
    ])
  })

  it('goes the way that changes a row: Pin while any is unpinned, Mark as read while any is unread, Archive while any is live', () => {
    const shown = show(bulkMenu([row({ pinned: true, unread: true, archived: true }), row({ pinned: false, unread: false, archived: true })]))
    expect(shown).toContain('Pin')
    expect(shown).toContain('Mark as read')
    expect(shown).toContain('Unarchive')
    const allPinned = show(bulkMenu([row({ pinned: true }), row({ pinned: true })]))
    expect(allPinned).toContain('Unpin')
    expect(allPinned).toContain('Mark as unread')
    expect(show(bulkMenu([row({ stoppable: true }), row()]))).toContain('Stop')
  })

  it('moves to an account only when every row goes to the same kind, ticking it only when all are on it', () => {
    expect(sub(bulkMenu([row(), row()], [], accounts), 'Move to account')).toEqual(['Unassigned', '-', '#3 three * (off)', '#9 nine'])
    expect(sub(bulkMenu([row(), row({ account: { num: 9, title: null } })], [], accounts), 'Move to account')).toEqual(['Unassigned', '-', '#3 three', '#9 nine'])
    expect(sub(bulkMenu([row({ unassigned: true }), row({ unassigned: true })], [], accounts), 'Move to account')).toEqual(['Unassigned * (off)', '-', '#3 three', '#9 nine'])
    // a Desk chat (no account move) or a Codex chat beside a Claude session: no Move to account, no Duplicate
    expect(sub(bulkMenu([row(), row({ movable: null, outside: false })], [], accounts), 'Move to account')).toBeNull()
    expect(sub(bulkMenu([row(), row({ movable: 'codex' })], [], accounts), 'Duplicate to account')).toBeNull()
  })

  it('ticks a group only when every row is in it, and deletes only when no row runs outside', () => {
    expect(sub(bulkMenu([row({ group: 'beta' }), row({ group: 'beta' })], ['alpha', 'beta']), 'Move to group')).toEqual(['alpha', 'beta *', '-', 'New group…', 'Remove from group'])
    expect(sub(bulkMenu([row({ group: 'beta' }), row()], ['alpha', 'beta']), 'Move to group')).toEqual(['alpha', 'beta', '-', 'New group…', 'Remove from group'])
    expect(show(bulkMenu([row({ outside: false, movable: null }), row({ outside: false, movable: null })]))).toContain('Delete')
    expect(show(bulkMenu([row({ outside: false, movable: null }), row()]))).not.toContain('Delete')
  })
})
