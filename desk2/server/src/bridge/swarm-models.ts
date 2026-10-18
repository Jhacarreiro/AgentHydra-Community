// Each HSwarm job's models, read from its folder's results.jsonl (one row per task, as HSwarm appends them): the Background
// tasks panel and the rail's Delegation card show per model how many tasks ran, how many ok and failed, and the tokens they
// moved (owner, 2026-10-15). The list gives a job's totals; the per-model split is in the file. A finished job's file never
// changes, so each is read once; a running one is read again at most on the poller's cadence (SWARM_FRESH_MS).
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SwarmJob, SwarmJobModel } from '@shared/protocol'
import { SWARM_FRESH_MS } from './swarm'

/** How many jobs' models are kept; the oldest read goes first. */
const CACHE_MAX = 200

/** A row's model as the panel names it: `rank:deepseek-v4-flash:baseten` is `deepseek-v4-flash`. */
export function shortModel(model: string): string {
  const bare = model.replace(/^rank:/, '')
  const cut = bare.lastIndexOf(':')
  return cut > 0 ? bare.slice(0, cut) : bare
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The tokens a task moved, as HSwarm's job summary counts them: input (cached or not) plus output. */
const tokensOf = (usage: unknown): number => {
  if (!usage || typeof usage !== 'object') return 0
  const u = usage as Record<string, unknown>
  return count(u.in_hit) + count(u.in_miss) + count(u.out)
}

interface TaskRow {
  id: string
  model: string
  status: string
  tokens: number
}

/** One results.jsonl line as a task row, or null when it is blank, not JSON, or not a task (no string id). */
function rowOf(line: string): TaskRow | null {
  if (!line.trim()) return null
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return null
  }
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  if (typeof r.id !== 'string') return null
  return {
    id: r.id,
    model: typeof r.model === 'string' && r.model ? shortModel(r.model) : 'unknown',
    status: typeof r.status === 'string' ? r.status : '',
    tokens: tokensOf(r.usage),
  }
}

/** A job's models from its results.jsonl lines: one task per id (the last row wins, as HSwarm reads its own file), summed
 *  by model, the most tasks first. `ok` counts status ok; `failed` counts error, timeout and loop; cancelled counts in tasks only. */
export async function modelsOfLines(lines: AsyncIterable<string> | Iterable<string>): Promise<SwarmJobModel[]> {
  const byTask = new Map<string, TaskRow>()
  for await (const line of lines) {
    const row = rowOf(line)
    if (row) byTask.set(row.id, row)
  }
  const byModel = new Map<string, SwarmJobModel>()
  for (const r of byTask.values()) {
    const m = byModel.get(r.model) ?? { model: r.model, tasks: 0, ok: 0, failed: 0, tokens: 0 }
    m.tasks++
    if (r.status === 'ok') m.ok++
    else if (r.status === 'error' || r.status === 'timeout' || r.status === 'loop') m.failed++
    m.tokens += r.tokens
    byModel.set(r.model, m)
  }
  return [...byModel.values()].sort((a, b) => b.tasks - a.tasks || a.model.localeCompare(b.model))
}

/** The models of the job folder's results.jsonl; null when the file is not there or cannot be read. A bad line is skipped. */
async function readModels(dir: string): Promise<SwarmJobModel[] | null> {
  const file = join(dir, 'results.jsonl')
  try {
    await stat(file)
  } catch {
    return null
  }
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  input.on('error', () => lines.close())
  try {
    return await modelsOfLines(lines)
  } catch {
    return null
  } finally {
    lines.close()
    input.destroy()
  }
}

interface CacheEntry {
  at: number
  finished: boolean
  value: SwarmJobModel[] | null | undefined
  models: Promise<SwarmJobModel[] | null>
}
const cache = new Map<string, CacheEntry>()

/** A job's models, from its folder. A finished job with its file read is never read again; anything else is read again once
 *  SWARM_FRESH_MS has passed. Concurrent asks share one read. */
export function jobModels(job: Pick<SwarmJob, 'id' | 'active'>, dir: string): Promise<SwarmJobModel[] | null> {
  const now = Date.now()
  const hit = cache.get(job.id)
  if (hit && (now - hit.at < SWARM_FRESH_MS || (hit.finished && hit.value))) return hit.models
  const entry: CacheEntry = { at: now, finished: !job.active, value: undefined, models: Promise.resolve(null) }
  entry.models = readModels(dir).then((v) => {
    entry.value = v
    return v
  })
  cache.delete(job.id)
  cache.set(job.id, entry)
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
  return entry.models
}

/** The jobs with their models: each of this PC's jobs whose folder is known (`dirs`, job id to folder) gets its models; a
 *  remote job, or one with no folder, keeps null. */
export async function attachJobModels(jobs: SwarmJob[], dirs: ReadonlyMap<string, string>): Promise<SwarmJob[]> {
  return Promise.all(
    jobs.map(async (j) => {
      const dir = j.pc === null ? dirs.get(j.id) : undefined
      return dir ? { ...j, models: await jobModels(j, dir) } : j
    }),
  )
}
