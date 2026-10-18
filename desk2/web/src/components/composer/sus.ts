import { SUS_LEVELS, type SusLevel, type SusPick } from '@shared/protocol'
import { modelTriggerLabel } from './logic'

/** The turns a setting needs before 'sus' routes to it; below that 'sus' runs on the normal model (server SUS_MIN_TURNS). */
export const SUS_LEARNING_TURNS = 20

export const SUS_LABEL: Record<SusLevel, string> = { fine: 'Fine', sus: 'Sus', bad: 'Bad' }

/** What each level does, on hover (owner, 2026-10-15: "when I hover over those, they explain what each one does"). */
export const SUS_TIP: Record<SusLevel, string> = {
  fine: 'Fine: the chat runs on the model you pick beside this.',
  sus: `Sus: the chat runs on whichever model and effort has pushed back least on your work (refusals, "are you sure", lectures). Until one has ${SUS_LEARNING_TURNS} counted turns, it uses the model you picked.`,
  bad: "Bad: Codex answers the chat's next turns instead of Claude.",
}

/** The level an arrow key moves a radio group to, or null for any other key. */
export function nextSusLevel(current: SusLevel, key: string): SusLevel | null {
  const i = SUS_LEVELS.indexOf(current)
  if (key === 'ArrowRight' || key === 'ArrowDown') return SUS_LEVELS[(i + 1) % SUS_LEVELS.length]
  if (key === 'ArrowLeft' || key === 'ArrowUp') return SUS_LEVELS[(i + SUS_LEVELS.length - 1) % SUS_LEVELS.length]
  return null
}

export interface SusStatus {
  text: string
  tone: 'muted' | 'sus' | 'bad'
  tip: string | null
}

/** The quiet chip beside the sus switch: what the chat's next turn runs on. */
export function susStatus(
  level: SusLevel,
  modelText: string,
  pick: SusPick | null | undefined,
  models: { value: string; label: string }[],
  pinnedWord: string | null,
): SusStatus {
  if (level === 'bad') return { text: 'Routing to Codex', tone: 'bad', tip: null }
  if (pinnedWord) return { text: pinnedWord, tone: 'muted', tip: null }
  if (level === 'fine') return { text: modelText, tone: 'muted', tip: null }
  if (!pick) {
    return {
      text: 'Sus · learning',
      tone: 'sus',
      tip: `Uses the normal model until a setting has ${SUS_LEARNING_TURNS} counted turns.`,
    }
  }
  return {
    text: `${modelTriggerLabel(pick.model, models)} · ${Math.round(pick.pushbackRate * 100)}% pushback`,
    tone: 'sus',
    tip: `Runs on the setting that pushes back least, over ${pick.turns} counted turns.`,
  }
}
