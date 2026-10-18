// The REST calls the panes and the accounts popover make. Components read them through
// usePaneApi(), so the gallery can provide fixture answers (provide(PANE_API, ...)) without a server.
import { inject, type InjectionKey } from 'vue'
import {
  type AccountInfo,
  type AccountRef,
  type DeskSettings,
  type GitStatus,
  type ModelChoice,
  OLDER_BEFORE_HEADER,
  OLDER_END_HEADER,
  type TranscriptIndex,
  type TranscriptItem
} from '@shared/protocol'
import type { BabysitterStatus } from '@shared/babysitter'
import type { InstanceManagerStatus } from '@shared/instance-manager'
import type { RoutineDetails, RoutinesRequest, RoutinesStatus } from '@shared/routines'
import type { OrchestratorModelStatus } from '@shared/orchestrator'
import type { FreeSettings } from '@shared/free-instances'

export interface PaneApi {
  gitStatus(cwd: string): Promise<GitStatus>
  gitDiff(cwd: string, path: string): Promise<string>
  models(): Promise<ModelChoice[]>
  health(): Promise<{ ok: boolean; version: string }>
  bridgeStatus(): Promise<{ up: boolean; url: string }>
  /** GET /api/babysitter: the chats a usage limit stopped and what the babysitter did (plugins/72-babysitter.ts). */
  babysitter(): Promise<BabysitterStatus>
  /** GET /api/instance-manager: the apps it watches and what it did when one went down (plugins/74-instance-manager.ts). */
  instanceManager(): Promise<InstanceManagerStatus>
  /** GET /api/routines: the routines the last look read, and the proposals waiting for the owner (plugins/73-routines.ts). */
  routines(): Promise<RoutinesStatus>
  /** POST /api/routines: one action (run, pause, resume, approve, discard, describe) or the switch; answers the whole status, or why not (409, 404, 403). */
  routinesAct(body: RoutinesRequest): Promise<RoutinesStatus>
  /** GET /api/routines/:id/details: its stats and one page of its full run history, newest first (before = the last page's nextBefore). */
  routineDetails(id: string, before?: number | null, limit?: number): Promise<RoutineDetails>
  /** GET /api/orchestrator/model: the model the orchestrator's judge asks, and what the SDK reported it resolves to. */
  orchestratorModel(): Promise<OrchestratorModelStatus>
  getSettings(): Promise<DeskSettings>
  putSettings(patch: Partial<DeskSettings>): Promise<DeskSettings>
  accounts(): Promise<AccountInfo[]>
  pickAccount(): Promise<AccountRef>
  /** An outside session's items; `olderBefore`, when not 0, is where in its file they begin: externalOlder answers the rest. */
  externalItems(sessionId: string, cwd?: string | null): Promise<{ items: TranscriptItem[]; olderBefore: number }>
  /** What an outside session's file holds before byte `before` (a long session's items are only its newest part). */
  externalOlder(sessionId: string, before: number, cwd?: string | null): Promise<TranscriptItem[]>
  /** The newest `limit` items before byte `before`; `above` is how many remain above them (pass it as `end` for the next page). */
  externalOlderPage?(sessionId: string, before: number, limit: number, end?: number, cwd?: string | null): Promise<{ items: TranscriptItem[]; above: number }>
  /** An outside session's index (every message sent, the to-do list, tasks, the total). */
  externalIndex?(sessionId: string, cwd?: string | null): Promise<TranscriptIndex>
  /** GET /api/diagnostics/<name>?<params>: every Diagnostics section reads its data through this; with `body`, a
   *  POST of it (the orchestrator's Arm). */
  diagnostics<T>(name: string, params?: Record<string, string | number | undefined>, body?: unknown): Promise<T>
  /** AgentHydra's own API through Desk's /ah/api proxy (its settings in this dialog, agenthydra.ts). */
  agentHydra<T>(path: string, init?: RequestInit): Promise<T>
  /** GET /api/free/settings: the Free table's keepalive (Settings > Instances > Free, instances.ts). */
  freeSettings(): Promise<FreeSettings>
  /** PATCH /api/free/settings with what changed; answers the saved settings. */
  patchFreeSettings(patch: Partial<FreeSettings>): Promise<FreeSettings>
}

async function json<T>(path: string, init?: RequestInit, base = '/api', seen?: (res: Response) => void): Promise<T> {
  const res = await fetch(base + path, init)
  seen?.(res)
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    const err = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : ''
    throw new Error(err || text || `${res.status} ${res.statusText}`)
  }
  return body as T
}

export const httpPaneApi: PaneApi = {
  gitStatus: (cwd) => json(`/git?cwd=${encodeURIComponent(cwd)}`),
  gitDiff: async (cwd, path) =>
    (await json<{ diff: string }>(`/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`)).diff,
  models: () => json('/models'),
  health: () => json('/health'),
  bridgeStatus: () => json('/bridge/status'),
  babysitter: () => json('/babysitter'),
  instanceManager: () => json('/instance-manager'),
  routines: () => json('/routines'),
  routineDetails: (id, before = null, limit = 50) =>
    json(`/routines/${encodeURIComponent(id)}/details?limit=${limit}${before === null ? '' : `&before=${before}`}`),
  // The window's mark: resume, approve, discard and the switch are the owner's, and the server knows the window by it.
  routinesAct: (body) =>
    json('/routines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Desk-Caller': 'window' },
      body: JSON.stringify(body)
    }),
  orchestratorModel: () => json('/orchestrator/model'),
  getSettings: () => json('/settings'),
  putSettings: (patch) =>
    json('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    }),
  accounts: () => json('/accounts'),
  pickAccount: () => json('/accounts/pick'),
  // The cwd names the session's project folder, so the server looks there first.
  externalItems: async (sessionId, cwd) => {
    let olderBefore = 0
    const items = await json<TranscriptItem[]>(
      `/external/sessions/${encodeURIComponent(sessionId)}/items${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`,
      undefined,
      '/api',
      (res) => (olderBefore = Number(res.headers.get(OLDER_BEFORE_HEADER)) || 0)
    )
    return { items, olderBefore }
  },
  externalOlder: (sessionId, before, cwd) =>
    json(`/external/sessions/${encodeURIComponent(sessionId)}/older?before=${before}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`),
  externalOlderPage: async (sessionId, before, limit, end, cwd) => {
    let above = 0
    const items = await json<TranscriptItem[]>(
      `/external/sessions/${encodeURIComponent(sessionId)}/older?before=${before}&limit=${limit}${end === undefined ? '' : `&end=${end}`}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`,
      undefined,
      '/api',
      (res) => (above = Number(res.headers.get(OLDER_END_HEADER)) || 0)
    )
    return { items, above }
  },
  externalIndex: (sessionId, cwd) => json(`/external/sessions/${encodeURIComponent(sessionId)}/index${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  diagnostics: (name, params = {}, body) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v))
    const init = body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    return json(`/diagnostics/${encodeURIComponent(name)}${q.size ? `?${q}` : ''}`, init)
  },
  agentHydra: (path, init) =>
    json(path, init?.body ? { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } } : init, '/ah/api'),
  freeSettings: () => json('/free/settings'),
  patchFreeSettings: (patch) =>
    json('/free/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
}

export const PANE_API: InjectionKey<PaneApi> = Symbol('paneApi')

export function usePaneApi(): PaneApi {
  return inject(PANE_API, httpPaneApi)
}
