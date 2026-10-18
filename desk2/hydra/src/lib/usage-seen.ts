// The daemon reads every account's usage at its set interval only while someone looks at AgentHydra, and slows down an
// hour after the last look (server/src/usage-refresh.ts; owner, 2026-10-14: "if I haven't loaded the instances tab or
// ... the Agent Hydra UI after a certain period of time, it should ... significantly lower the rate of polling"). While
// this page is on screen (in Desk: its pane slid in, lib/desk-embed.ts) it says so every few minutes, and at once when
// it is seen again after a beat fell while hidden.
import { reportUsageSeen } from './api'
import { visibleInterval } from './visible-poll'

/** Well inside the daemon's hour, so a page on screen never reads as idle. */
const EVERY_MS = 5 * 60_000

export function reportLooks(): () => void {
  // A look that fails to land costs nothing but a slower sweep until the next one.
  const say = () => void reportUsageSeen().catch(() => {}) // floor-ok: best effort, the next beat says it again
  if (!document.hidden) say()
  return visibleInterval(say, EVERY_MS)
}
