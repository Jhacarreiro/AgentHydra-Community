// What the RepoYeti pane and the Changes pane's switch decide from GET /api/connectors, kept apart from the page so it is testable.
import type { ConnectorView } from '@shared/connectors'

/** The RepoYeti entry of the answer, or null when the server did not list it (an older Desk 2 server). */
export const repoYetiOf = (list: readonly ConnectorView[] | null): ConnectorView | null => list?.find((c) => c.id === 'repoyeti') ?? null

export type ChangesTab = 'changes' | 'repoyeti'

/** The Changes pane's 'Changes | RepoYeti' switch shows while the RepoYeti connector is listed and on; disabled in Settings, the pane is plain Changes. */
export const showChangesSwitch = (c: ConnectorView | null): boolean => !!c && c.enabled

/** Which side of the Changes pane is shown: the remembered choice, but plain Changes when the switch is hidden. */
export const changesTabFor = (remembered: string | null | undefined, c: ConnectorView | null): ChangesTab =>
  remembered === 'repoyeti' && showChangesSwitch(c) ? 'repoyeti' : 'changes'

/** The remembered choice read back from storage text (anything unknown is Changes). */
export const parseChangesTab = (raw: string | null | undefined): ChangesTab => (raw === 'repoyeti' ? 'repoyeti' : 'changes')

export type RepoYetiView =
  | { kind: 'loading' }
  | { kind: 'frame'; url: string }
  | { kind: 'start' }
  | { kind: 'install' }
  | { kind: 'busy'; line: string }
  | { kind: 'failed'; reason: string }

export function repoYetiView(c: ConnectorView | null): RepoYetiView {
  if (!c) return { kind: 'loading' }
  switch (c.state) {
    case 'running':
      return c.url ? { kind: 'frame', url: c.url } : { kind: 'busy', line: 'Starting RepoYeti' }
    case 'installed':
      return { kind: 'start' }
    case 'absent':
      return { kind: 'install' }
    case 'installing':
      return { kind: 'busy', line: c.reason || 'Installing RepoYeti' }
    case 'starting':
      return { kind: 'busy', line: 'Starting RepoYeti' }
    case 'failed':
      return { kind: 'failed', reason: c.reason || 'RepoYeti did not start' }
  }
}

/** How long to wait before asking again: quickly while Desk is doing something, slowly otherwise. */
export const pollDelay = (c: ConnectorView | null): number => (c && (c.state === 'installing' || c.state === 'starting') ? 1000 : 5000)

/** The slow pace the fast poll falls back to, and how long the list may stay the same before it does. */
export const SLOW_LIST_POLL_MS = 5000
export const FAST_LIST_POLL_FOR_MS = 60_000
/** A fast poll (a connector installing or starting) that has seen the same answer for a minute is a connector that is stuck: ask at the slow pace. */
export const cappedDelay = (asked: number, unchangedForMs: number): number =>
  asked < SLOW_LIST_POLL_MS && unchangedForMs >= FAST_LIST_POLL_FOR_MS ? SLOW_LIST_POLL_MS : asked

/** Ask Desk to add `cwd` to RepoYeti only while the frame is up, and once per folder (`done` holds the ones asked). */
export const shouldRegister = (view: RepoYetiView, cwd: string | null | undefined, done: ReadonlySet<string>): boolean =>
  view.kind === 'frame' && !!cwd && !done.has(cwd)

/** The frame is reloaded when the folder was newly added, so the new repo shows in RepoYeti's list. */
export const reloadAfterRegister = (res: { added?: boolean } | null): boolean => res?.added === true
