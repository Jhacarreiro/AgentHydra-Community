// A manager card's stats line, read from the analytics pass's summary.json in the managers folder.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANAGER_SLUG, managersDir } from './managers'

export type ManagerStats = {
  turns: number
  responseRate: number | null
  judgeAvg: number | null
  corrections: number
  line: string
}

const STATS_MS = 5000
let cache: { at: number; path: string; managers: Record<string, unknown> | null } | null = null

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readManagers(path: string): Record<string, unknown> | null {
  try {
    const summary: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isObject(summary) && isObject(summary.managers) ? summary.managers : null
  } catch {
    return null
  }
}

function managers(): Record<string, unknown> | null {
  const path = join(managersDir(), 'analytics', 'summary.json')
  const now = Date.now()
  if (cache && cache.path === path && now - cache.at < STATS_MS) return cache.managers
  const found = readManagers(path)
  cache = { at: now, path, managers: found }
  return found
}

export function managerStats(slug: string): ManagerStats | null {
  if (!MANAGER_SLUG.test(slug)) return null
  const row = managers()?.[slug]
  if (!isObject(row)) return null
  const turns = num(row.turns) ?? 0
  const rate = num(row.responseRate)
  const judgeAvg = num(row.judgeAvg)
  const owner = isObject(row.owner) ? row.owner : {}
  const corrections = num(owner.correction) ?? 0
  const stored = typeof row.line === 'string' && row.line.trim() ? row.line : null
  const line =
    stored ??
    [
      `${turns} turns`,
      rate === null ? null : `${Math.round(rate * 100)}% answered`,
      judgeAvg === null ? null : `judge ${judgeAvg}`,
    ]
      .filter((part): part is string => part !== null)
      .join(' · ')
  return { turns, responseRate: rate, judgeAvg, corrections, line }
}

export function forgetManagerStats(): void {
  cache = null
}
