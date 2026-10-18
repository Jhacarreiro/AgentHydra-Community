// The session rail's row shapes, as Claude Desktop's rail draws them (owner, 2026-10-14: "the items don't look anything like
// the design I gave you"): a gray 16px icon and the fact in the body text, 26px a row. Shared by the rail's cards and by the
// outside session's facts its session header draws into them.
export const RAIL_ROW = 'flex h-6.5 min-w-0 items-center gap-2 rounded-(--radius-6) px-1.5'
export const RAIL_ROW_BTN = `${RAIL_ROW} w-full cursor-default text-start outline-none transition-colors duration-60 hover:bg-fill-hover focus-visible:shadow-(--focus-ring)`
export const RAIL_ICON = 'size-4 shrink-0 text-text-2'
/** A connector's letter, in its small square. */
export const RAIL_TILE =
  'flex size-4.5 shrink-0 items-center justify-center rounded-(--radius-5) border border-(--border) bg-(--fill-secondary) text-2xs font-medium leading-none text-text-2'
/** A small icon button at a row's or a card's right end. */
export const RAIL_ICON_BTN =
  'flex size-6 shrink-0 cursor-default items-center justify-center rounded-(--radius-6) text-text-muted outline-none transition-colors duration-60 hover:bg-fill-hover hover:text-text focus-visible:shadow-(--focus-ring) disabled:opacity-40 disabled:hover:bg-transparent'
