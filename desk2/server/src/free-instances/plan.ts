// What the window says when a Free account's plan changes what it can be promoted to (owner, 2026-10-09: "If they
// change to not free, I guess let me know ... and then I may go and promote them ... To cli/desktop"; 2026-10-14: only
// above Go).
import { type FreeInstance, promotionFor } from '@shared/free-instances'

const PROVIDER = { claude: 'Claude', chatgpt: 'ChatGPT' } as const
const PROMOTE = { codex: 'a Codex instance', cli: 'a CLI instance', desktop: 'a Desktop instance' } as const
const label = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1)

/** The notification for the account's last plan change; null when it has none. */
export function planNotice(i: FreeInstance): { title: string; body: string } | null {
  const change = i.planChange
  if (!change) return null
  const who = `${i.name} (${PROVIDER[i.provider]} Free #${i.num})`
  const promote = promotionFor(i.provider, change.to)
  if (promote) {
    return {
      title: `Free account is on ${label(change.to)}`,
      body: `${who} ${change.from ? 'moved to' : 'reports'} the ${label(change.to)} plan. It can run as ${PROMOTE[promote]}: Promote in its menu.`,
    }
  }
  return { title: `Free account is back on ${label(change.to)}`, body: `${who} left the ${label(change.from ?? 'paid')} plan for ${label(change.to)}.` }
}
