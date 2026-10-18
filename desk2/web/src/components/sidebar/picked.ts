// Rows picked together in the desk list (owner, 2026-10-14: "click on one and then I hold Shift or Control ...
// multi-select so I can right-click and transfer or do potentially more relevant actions with the right-click menu").
// A row is its entry key (`chat:<id>`, `external:<id>`); `order` is the rows that can be picked, top to bottom as drawn.

export interface Picks {
  keys: ReadonlySet<string>
  /** The row a Shift-click ranges from: the last row clicked without Shift. */
  anchor: string | null
}

export const NO_PICKS: Picks = { keys: new Set(), anchor: null }

/**
 * What a click on `key` does to the picks, as Explorer's list does it: Ctrl (Cmd) adds or takes away one row, the open
 * row joining the picks on the first one; Shift picks every row from the anchor (else the open row) down or up to this
 * one, and Ctrl+Shift adds that run to the picks. null: a plain click, or one on a row that cannot be picked, which
 * opens the row as before (the caller clears the picks and makes the row the anchor).
 */
export function pickClick(picks: Picks, key: string, mods: { shift: boolean; toggle: boolean }, order: readonly string[], open: string | null): Picks | null {
  if ((!mods.shift && !mods.toggle) || !order.includes(key)) return null
  const openKey = open && order.includes(open) ? open : null
  if (mods.shift) {
    const from = picks.anchor && order.includes(picks.anchor) ? picks.anchor : (openKey ?? key)
    const [a, b] = [order.indexOf(from), order.indexOf(key)].sort((x, y) => x - y)
    const run = order.slice(a, b + 1)
    return { keys: new Set(mods.toggle ? [...picks.keys, ...run] : run), anchor: from }
  }
  const next = new Set(picks.keys.size || !openKey ? picks.keys : [openKey])
  if (!next.delete(key)) next.add(key)
  return { keys: next, anchor: key }
}

/** The picks without the rows no longer drawn (a filter, a search, an archive or a move took them out of the list). */
export function prunePicks(picks: Picks, order: readonly string[]): Picks {
  const shown = new Set(order)
  const keys = [...picks.keys].filter((k) => shown.has(k))
  const anchor = picks.anchor && shown.has(picks.anchor) ? picks.anchor : null
  return keys.length === picks.keys.size && anchor === picks.anchor ? picks : { keys: new Set(keys), anchor }
}
