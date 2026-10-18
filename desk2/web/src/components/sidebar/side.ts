import { ref } from 'vue'

// Which window edge the sidebar sits on. The sidebar is dragged by its grip to the other half of the window (Sidebar.vue);
// the chosen side is the one state every layout reads (DeskFrame mirrors the grid, the chrome bar and the resize handle).
export type SidebarSide = 'left' | 'right'
/** Where the side is kept (DeskFrame's storage, like the width). */
export const SIDEBAR_SIDE_KEY = 'hydra-desk.sidebar.side'

/** A saved side read back: 'right' when saved as right, otherwise 'left'. */
export function savedSidebarSide(raw: string | null | undefined): SidebarSide {
  return raw === 'right' ? 'right' : 'left'
}

/** The half of the window a pointer at clientX lands in; the exact middle counts as the right half. */
export function dropSide(clientX: number, windowWidth: number): SidebarSide {
  return clientX < windowWidth / 2 ? 'left' : 'right'
}

const storage = typeof localStorage === 'undefined' ? null : localStorage

export const sidebarSide = ref<SidebarSide>(savedSidebarSide(storage?.getItem(SIDEBAR_SIDE_KEY)))

export function setSidebarSide(side: SidebarSide): void {
  sidebarSide.value = side
  storage?.setItem(SIDEBAR_SIDE_KEY, side)
}
