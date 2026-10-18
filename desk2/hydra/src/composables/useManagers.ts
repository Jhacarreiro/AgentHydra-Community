// The managers' state, read from Desk's server: GET /api/babysitter, GET /api/diagnostics/orchestrator (the
// orchestrator's plan) and GET /api/routines. One poll at the CliMayte node's cadence (WARM_MS), and only while
// the Managers node or one of its pages is on screen (`shown`). A 404 means this window runs without Desk, where
// these routes do not answer: `available` is false and nothing errors.
import type { RoutinesRequest, RoutinesStatus } from '@desk/shared/routines'
import type { BabysitterStatus } from '@desk/shared/babysitter'
import type { OrchestratorPlan } from '@desk/shared/orchestrator'
import { onBeforeUnmount, reactive, shallowRef, watch } from 'vue'
import { API_BASE } from '@/lib/api'
import { WARM_MS } from '@/lib/warm-data'

export function useManagers(shown: { readonly value: boolean }) {
  const babysitter = shallowRef<BabysitterStatus | null>(null)
  const orchestrator = shallowRef<OrchestratorPlan | null>(null)
  const routines = shallowRef<RoutinesStatus | null>(null)
  // null until the first read; false when Desk's routes do not answer (the window runs without Desk).
  const available = shallowRef<boolean | null>(null)
  const error = shallowRef<string | null>(null)
  // The routine whose action is in flight, so its button waits for the answer.
  const busy = shallowRef<string | null>(null)
  let timer: number | undefined

  // Null when the route is not there (404): this window runs without Desk.
  async function read<T>(path: string): Promise<T | null> {
    const res = await fetch(API_BASE + path)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return (await res.json()) as T
  }

  async function refresh(): Promise<void> {
    try {
      const [b, o, r] = await Promise.all([
        read<BabysitterStatus>('/api/babysitter'),
        read<OrchestratorPlan>('/api/diagnostics/orchestrator'),
        read<RoutinesStatus>('/api/routines'),
      ])
      available.value = b !== null && r !== null
      babysitter.value = b
      orchestrator.value = o
      routines.value = r
      error.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  // One action on one routine (POST /api/routines); the answer is the whole status again.
  async function act(body: RoutinesRequest, id: string): Promise<void> {
    busy.value = id
    try {
      const res = await fetch(`${API_BASE}/api/routines`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const answer = await res.json().catch(() => null)
      if (!res.ok) throw new Error((answer as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`)
      routines.value = answer as RoutinesStatus
    } finally {
      busy.value = null
    }
  }

  function stop() {
    if (timer !== undefined) window.clearInterval(timer)
    timer = undefined
  }
  watch(
    () => shown.value,
    (on) => {
      stop()
      if (!on) return
      void refresh()
      timer = window.setInterval(() => {
        if (document.visibilityState !== 'hidden') void refresh()
      }, WARM_MS)
    },
    { immediate: true },
  )
  onBeforeUnmount(stop)

  return reactive({ babysitter, orchestrator, routines, available, error, busy, refresh, act })
}

export type Managers = ReturnType<typeof useManagers>
