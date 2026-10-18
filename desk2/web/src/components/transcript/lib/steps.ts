// Where the previous and next message the person sent sit, for the transcript's step arrows. Pure: no Vue, no DOM.

/**
 * The scroll offset that puts the user message at `top` (its top in scroll-content px) on the line `lineOffset` px
 * below the top of the view, clamped at 0.
 */
export function stepTarget(top: number, lineOffset: number): number {
  return Math.max(0, top - lineOffset)
}

/**
 * Which message a step lands on (its index in `tops`), or null when there is none that moves the view.
 * `tops` are the user messages' tops in scroll-content px, in order; `scrollTop` is where the view is now;
 * `lineOffset` is how far below the view's top a message lands (the header's inset plus a margin).
 * "up" is the nearest message whose landing spot is above the view (scroll back past the one it lands on, so a
 * second step goes to the one before it); "down" is the nearest whose landing spot is below it. A message that
 * already sits on its landing spot is not a step: landing on one never repeats it. The view follows the message by
 * its index while it glides there, so rows measured on the way move the landing spot with it.
 */
export function nextMessageStep(
  tops: readonly number[],
  scrollTop: number,
  dir: 'up' | 'down',
  lineOffset: number,
): number | null {
  if (dir === 'up') {
    for (let i = tops.length - 1; i >= 0; i--) {
      if (stepTarget(tops[i]!, lineOffset) < scrollTop - 1) return i
    }
    return null
  }
  for (let i = 0; i < tops.length; i++) {
    if (stepTarget(tops[i]!, lineOffset) > scrollTop + 1) return i
  }
  return null
}

/**
 * The sent messages over the whole transcript, in order: the ones above the loaded rows come from the index
 * (`userMessages`, position order) with their top estimated at `base + position * avgRow`; the loaded rows' own
 * ids and measured tops follow. A message the index lists that a loaded row already holds is not counted twice.
 */
export function sentOverIndex(
  loaded: { ids: readonly string[]; tops: readonly number[] },
  userMessages: readonly { id: string; position: number }[] | undefined,
  avgRow: number,
  base: number,
): { ids: string[]; tops: number[] } {
  const have = new Set(loaded.ids)
  const ids: string[] = []
  const tops: number[] = []
  for (const m of userMessages ?? []) {
    if (have.has(m.id)) continue
    ids.push(m.id)
    tops.push(base + m.position * avgRow)
  }
  // Only what sits above the first loaded message belongs in front of it; a gap-free list keeps the order.
  const keep = tops.length && loaded.tops.length ? tops.findIndex((t) => t >= loaded.tops[0]!) : -1
  if (keep >= 0) {
    ids.length = keep
    tops.length = keep
  }
  return { ids: [...ids, ...loaded.ids], tops: [...tops, ...loaded.tops] }
}
