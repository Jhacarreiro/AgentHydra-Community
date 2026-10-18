// The managers' pure helpers (HSwarm's Managers node): the state dots, and which of the work a routine started
// it is. A routine's work is found by its id: a CliMayte worker whose group begins `routine-<id>-`, an HSwarm
// job whose label begins `<id>`.

import type { RoutineOutcome, RoutineState } from '@desk/shared/routines'

/** The dot a node or a row shows, as the tree draws it (HSwarmView's DOT_CLASS). */
export type ManagerDot = 'ok' | 'warn' | 'off' | 'run' | 'bad'

/** A routine's state as its dot: running pulses, due and waiting are amber, paused, off and ended are grey, broken is red. */
export function routineDot(state: RoutineState): ManagerDot {
  if (state === 'running') return 'run'
  if (state === 'due' || state === 'waiting') return 'warn'
  if (state === 'idle') return 'ok'
  if (state === 'paused' || state === 'off' || state === 'ended') return 'off'
  return 'bad'
}

/** A manager's dot: a read that failed is red, switched off is grey, on is green. Undefined before the first read. */
export function managerDot(on: boolean | undefined, failed: boolean): ManagerDot | undefined {
  if (failed) return 'bad'
  if (on === undefined) return undefined
  return on ? 'ok' : 'off'
}

/** Whether a CliMayte worker in this group is a routine's work: the group starts `routine-<id>-`. */
export function workerOfRoutine(group: string, id: string): boolean {
  return group.startsWith(`routine-${id}-`)
}

/** Whether an HSwarm job with this label is a routine's work: the label starts with the routine's id. */
export function jobOfRoutine(label: string | null | undefined, id: string): boolean {
  return (label ?? '').startsWith(id)
}

/** A run that can be started now: a routine that is idle or due (not paused, ended, off, broken or already running). */
export function canRunRoutine(state: RoutineState, busy: boolean): boolean {
  return !busy && (state === 'idle' || state === 'due')
}

/** The dot classes the managers' state dots use (the tree's DOT_CLASS, for the rows and tiles). */
export const MANAGER_DOT_CLASS: Record<ManagerDot, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  off: 'bg-muted-foreground/50',
  run: 'bg-primary animate-pulse',
  bad: 'bg-destructive',
}

/** The outcome's tone class: a failure is red, a busy look is muted. */
export function outcomeTone(outcome: RoutineOutcome): string {
  if (outcome === 'ok') return 'text-success'
  if (outcome === 'busy') return 'text-muted-foreground'
  return 'text-destructive'
}
