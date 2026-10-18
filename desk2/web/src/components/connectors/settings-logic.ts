// What a Settings → Connectors row shows and offers, as pure functions of the connector's view.
import type { ConnectorView } from '@shared/connectors'

export const FAST_POLL_MS = 3000
export const SLOW_POLL_MS = 15000

export type Tone = 'ok' | 'busy' | 'bad' | 'idle'

export function stateLabel(v: ConnectorView): string {
  switch (v.state) {
    case 'running':
      return 'Running'
    case 'installed':
      return 'Installed, not running'
    case 'absent':
      return 'Not installed'
    case 'installing':
      return v.reason ? `Installing… ${v.reason}` : 'Installing…'
    case 'starting':
      return 'Starting…'
    case 'failed':
      return `Failed: ${v.reason ?? 'unknown'}`
  }
}

export function stateTone(v: ConnectorView): Tone {
  if (v.state === 'running') return 'ok'
  if (v.state === 'installing' || v.state === 'starting') return 'busy'
  if (v.state === 'failed') return 'bad'
  return 'idle'
}

export const isBusy = (v: ConnectorView): boolean => v.state === 'installing' || v.state === 'starting'

/** Which buttons the row shows. */
export function rowButtons(v: ConnectorView): { install: boolean; start: boolean; open: boolean } {
  return {
    install: v.installable && (v.state === 'absent' || v.state === 'failed'),
    start: v.state === 'installed',
    open: v.pane && v.state === 'running' && !!v.url
  }
}

/** What a third-party connector's row says while the person has not turned it on. */
export const THIRD_PARTY_OFF = 'Off until you turn it on: Desk does not download or start it, and chats get none of its tools.'

/**
 * A second line under the blurb: a third-party one that is off says what off means; otherwise why it is absent or
 * not answering, when the label alone does not say.
 */
export const note = (v: ConnectorView): string | null =>
  v.thirdParty && !v.enabled ? THIRD_PARTY_OFF : (v.state === 'absent' || v.state === 'installed') && v.reason ? v.reason : null

/**
 * The words beside the row's switch. Desk's own connector only hands chats its tools; a third-party one is off in
 * Desk altogether (no pane, no bar, no start) until its switch is on.
 */
export const switchLabel = (v: ConnectorView): { text: string; aria: string } =>
  v.thirdParty ? { text: 'Use it in Desk', aria: `Use ${v.name} in Desk` } : { text: 'Give chats its tools', aria: `Give chats ${v.name}'s tools` }

export const versionLabel = (v: ConnectorView): string | null => (v.version ? (v.version.startsWith('v') ? v.version : `v${v.version}`) : null)

/** Poll every 3 s while any connector installs or starts, else every 15 s. */
export const pollDelay = (views: ConnectorView[]): number => (views.some(isBusy) ? FAST_POLL_MS : SLOW_POLL_MS)
