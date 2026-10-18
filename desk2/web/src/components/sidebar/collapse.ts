// Collapse mode: the window folds to the right edge of the screen, showing only the sidebar's chats. The host does the
// moving (launcher/host, `window` action collapse/expand); this module says when the page asks for it.
import type { CollapseMode } from '@shared/protocol'

export type { CollapseMode }
export type CollapseAction = 'collapse' | 'expand' | 'wait' | 'nothing'

export const COLLAPSE_MODES: readonly CollapseMode[] = ['off', 'button', 'auto']

export const COLLAPSE_MODE_LABELS: Record<CollapseMode, { label: string; sentence: string }> = {
  off: { label: 'Off', sentence: 'Shrink AgentHydra to just your chats, on the right edge of the screen.' },
  button: {
    label: 'Button',
    sentence: 'A button beside search shrinks AgentHydra to just your chats, on the right edge of the screen.'
  },
  auto: {
    label: 'Automatic',
    sentence: 'Switch to another app and AgentHydra shrinks to just your chats, on the right edge of the screen.'
  }
}

/** A focus change while the mode is automatic: collapse when AgentHydra leaves the front, expand when it comes back.
 *  `busy` is a pointer or drag still in progress: nothing moves until it is released (the caller asks again then). */
export function focusAction(s: { mode: CollapseMode; collapsed: boolean; focused: boolean; busy: boolean }): CollapseAction {
  if (s.mode !== 'auto') return 'nothing'
  if (!s.focused) return s.collapsed ? 'nothing' : s.busy ? 'wait' : 'collapse'
  if (!s.collapsed) return 'nothing'
  return s.busy ? 'wait' : 'expand'
}

/** A chat was opened while the window is folded: that click means the window comes back. */
export function chatAction(s: { mode: CollapseMode; collapsed: boolean }): CollapseAction {
  return s.mode !== 'off' && s.collapsed ? 'expand' : 'nothing'
}

/** The mode was changed: turning it off while folded brings the window back. */
export function modeAction(s: { mode: CollapseMode; collapsed: boolean }): CollapseAction {
  return s.mode === 'off' && s.collapsed ? 'expand' : 'nothing'
}
