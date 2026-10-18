// The rail's Delegation card and its stats panel (owner, 2026-10-15: "how many HSwarm sessions we ran, how many CliMayte sessions,
// per model how many succeeded and failed, how many tokens were estimated"): one service's runs, tasks, outcomes, models and
// tokens for one chat. Pure, so the counts are tested. HSwarm's tokens and cost are its own measured figures, and its models
// come from each job's results.jsonl (the server reads it); a job whose file was not read counts under "Model not recorded".
// CliMayte's tokens are AgentHydra's per-worker count, an estimate.
import type { CliMayteWorker, SwarmJob } from '@shared/protocol'

export type DelegationService = 'hswarm' | 'climayte'

export interface ModelRow {
  model: string
  tasks: number
  succeeded: number
  failed: number
}

export interface ServiceStats {
  service: DelegationService
  label: string
  /** HSwarm: its jobs; CliMayte: its workers (a worker is one session). */
  runs: number
  tasks: number
  succeeded: number
  failed: number
  running: number
  models: ModelRow[]
  /** Tokens the service moved; null when none was recorded. Measured for HSwarm, an estimate for CliMayte (`tokensEst`). */
  tokens: number | null
  tokensEst: boolean
  /** Dollars HSwarm reports for its jobs; null for CliMayte and for a job HSwarm gave no cost. */
  costUsd: number | null
}

export const NO_MODEL = 'Model not recorded'

const byTasks = (a: ModelRow, b: ModelRow) => b.tasks - a.tasks || a.model.localeCompare(b.model)

/** The sum of the numbers given, or null when none of them is a number. */
const sumOrNull = (xs: readonly (number | null)[]): number | null => {
  let total: number | null = null
  for (const x of xs) if (x != null) total = (total ?? 0) + x
  return total
}

/** HSwarm's models: each job's per-model rows summed by model (its tasks, ok as succeeded, failed); a job whose file was
 *  not read adds its tasks to one "Model not recorded" row, the most tasks first. */
function hswarmModels(jobs: readonly SwarmJob[]): ModelRow[] {
  const byModel = new Map<string, ModelRow>()
  const unknown: ModelRow = { model: NO_MODEL, tasks: 0, succeeded: 0, failed: 0 }
  for (const j of jobs) {
    if (!j.models) {
      unknown.tasks += j.tasks.total
      unknown.succeeded += j.tasks.done
      unknown.failed += j.tasks.failed
      continue
    }
    for (const m of j.models) {
      const row = byModel.get(m.model) ?? { model: m.model, tasks: 0, succeeded: 0, failed: 0 }
      row.tasks += m.tasks
      row.succeeded += m.ok
      row.failed += m.failed
      byModel.set(m.model, row)
    }
  }
  const rows = [...byModel.values()]
  if (unknown.tasks) rows.push(unknown)
  return rows.sort(byTasks)
}

/** One service's stats for a chat, from the workers and jobs its session dispatched. Services with no runs are left out,
 *  so the card is hidden for a chat that delegated nothing. A worker or job listed twice counts once. */
export function delegationStats(workers: readonly CliMayteWorker[], jobs: readonly SwarmJob[]): ServiceStats[] {
  const uniqueWorkers = [...new Map(workers.map((w) => [w.id, w])).values()]
  const uniqueJobs = [...new Map(jobs.map((j) => [j.id, j])).values()]
  const out: ServiceStats[] = []

  if (uniqueJobs.length) {
    const failed = uniqueJobs.filter((j) => !j.active && (j.status === 'cancelled' || j.tasks.failed > 0)).length
    const running = uniqueJobs.filter((j) => j.active).length
    out.push({
      service: 'hswarm',
      label: 'HSwarm',
      runs: uniqueJobs.length,
      tasks: uniqueJobs.reduce((n, j) => n + j.tasks.total, 0),
      succeeded: uniqueJobs.length - failed - running,
      failed,
      running,
      models: hswarmModels(uniqueJobs),
      tokens: sumOrNull(uniqueJobs.map((j) => j.tokens)),
      tokensEst: false,
      costUsd: sumOrNull(uniqueJobs.map((j) => j.costUsd)),
    })
  }

  if (uniqueWorkers.length) {
    const models = new Map<string, ModelRow>()
    let succeeded = 0
    let failed = 0
    let running = 0
    for (const w of uniqueWorkers) {
      const model = w.model ?? NO_MODEL
      const row = models.get(model) ?? { model, tasks: 0, succeeded: 0, failed: 0 }
      row.tasks++
      if (w.active) running++
      else if (w.status === 'done') {
        succeeded++
        row.succeeded++
      } else {
        failed++
        row.failed++
      }
      models.set(model, row)
    }
    out.push({
      service: 'climayte',
      label: 'CliMayte',
      runs: uniqueWorkers.length,
      tasks: uniqueWorkers.length,
      succeeded,
      failed,
      running,
      models: [...models.values()].sort(byTasks),
      tokens: sumOrNull(uniqueWorkers.map((w) => w.tokens)),
      tokensEst: true,
      costUsd: null,
    })
  }

  return out
}
