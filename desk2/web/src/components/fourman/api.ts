// The To-do pane's reads, through Desk 2's /ah/api to the one AgentHydra daemon (server/src/routes/fourman.ts).
import { FOURMAN_BASE, fourmanBoardPath, type FourmanBoard, type FourmanScope, type FourmanStatus } from '@shared/fourman'

async function call<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null
  if (!res.ok) throw new Error(typeof body?.error === 'string' && body.error ? body.error : `${res.status} ${res.statusText}`)
  if (!body) throw new Error(`${res.status} ${res.statusText}: not a JSON answer`)
  return body
}

export const fourmanStatus = (): Promise<FourmanStatus> => call(FOURMAN_BASE)

export const fourmanBoard = (scope: FourmanScope): Promise<FourmanBoard> => call(fourmanBoardPath(scope))
