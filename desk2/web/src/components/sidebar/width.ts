// The sidebar's width: dragged anywhere from SIDEBAR_MIN to SIDEBAR_MAX (owner, 2026-10-10: "This sidebar does not let
// me make it any narrower"), SIDEBAR_DEFAULT until dragged. The chrome bar over its top (ChromeBar.vue) needs
// CHROME_OPEN for its buttons (12 + 5 buttons of 28 + 6 gaps of 4 + 2 dividers + 12 of divider margins + 8 right
// padding = 198; the four view toggles sit in one More options menu since 2026-10-12): over a narrower sidebar it keeps
// that width and reaches over the title bar, which then starts after it (chromeOverhang), as it starts after the bar's
// CHROME_COLLAPSED while the sidebar is hidden.
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 420
export const SIDEBAR_DEFAULT = 294
export const CHROME_OPEN = 198
export const CHROME_COLLAPSED = 194
/** Where the dragged width is kept (DeskFrame); a parity scene sets it to draw a narrower sidebar. */
export const SIDEBAR_WIDTH_KEY = 'hydra-desk.sidebar.width'

export const clampSidebarWidth = (w: number): number => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)))

/** A saved width read back: one inside the range as it was saved, else the default. */
export function savedSidebarWidth(raw: string | null | undefined): number {
  const w = Number(raw)
  return raw && Number.isFinite(w) && w >= SIDEBAR_MIN && w <= SIDEBAR_MAX ? Math.round(w) : SIDEBAR_DEFAULT
}

/** How far the chrome bar reaches past an open sidebar this wide: 0 once the sidebar holds it. */
export const chromeOverhang = (sidebarWidth: number): number => Math.max(0, CHROME_OPEN - sidebarWidth)
