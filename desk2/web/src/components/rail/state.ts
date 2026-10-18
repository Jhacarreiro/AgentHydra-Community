// The session rail's state, one per window: open or shut (the title bar's Session details button, on the key the session
// header's fold used, so a header folded away is a rail shut away), its width, and which of its cards are folded. An outside
// session's facts are its session header's, drawn into the rail's cards (RAIL_TARGETS) while `railTargets` says they are there.
import { ref, watch } from 'vue'
import { headerOpen } from '@/components/session-header/state'
import { RAIL_DEFAULT } from '@/components/shell/logic'

const storage = typeof localStorage === 'undefined' ? null : localStorage
const WIDTH_KEY = 'hydra-desk.rail.width'
const FOLDED_KEY = 'hydra-desk.rail.folded'

export const railOpen = headerOpen

export const railWidth = ref(Number(storage?.getItem(WIDTH_KEY)) || RAIL_DEFAULT)
export const saveRailWidth = (): void => storage?.setItem(WIDTH_KEY, String(railWidth.value))

function readFolded(): string[] {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(FOLDED_KEY) ?? '[]')
    return Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
export const foldedCards = ref(new Set(readFolded()))
watch(foldedCards, (v) => storage?.setItem(FOLDED_KEY, JSON.stringify([...v])))
export function toggleCard(id: string): void {
  const next = new Set(foldedCards.value)
  if (!next.delete(id)) next.add(id)
  foldedCards.value = next
}

/** Where an outside session's header draws into the rail: the Environment card's actions and facts, and the Context card's facts. */
export const RAIL_TARGETS = { actions: 'rail-session-actions', environment: 'rail-session-environment', context: 'rail-session-context' } as const
/** The rail is on screen with an outside session's cards, so RAIL_TARGETS are in the page. */
export const railTargets = ref(false)
