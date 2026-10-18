import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jobModels, shortModel } from '../../src/bridge/swarm-models'

// A job folder's results.jsonl as HSwarm appends it, made up: one row per task, one line cut short (a write still in
// progress), and task t2 run again (its later row is the one HSwarm reads).
const row = (id: string, model: string, status: string, usage: Record<string, number>) => JSON.stringify({ id, model, status, usage })
const FIXTURE = [
  row('t1', 'rank:deepseek-v4-flash:baseten', 'ok', { in_hit: 1200, in_miss: 300, out: 150, reasoning: 40 }),
  '{"id":"t2","model":"rank:deepseek-v4-flash:baseten","status":"ok", "usage":{"in_mi',
  row('t3', 'rank:deepseek-v4-flash:baseten', 'timeout', { in_hit: 0, in_miss: 900, out: 0, reasoning: 0 }),
  row('t4', 'rank:qwen-3-coder:fireworks', 'error', { in_miss: 400, out: 20 }),
  row('t5', 'rank:qwen-3-coder:fireworks', 'cancelled', {}),
  row('t2', 'rank:deepseek-v4-flash:baseten', 'ok', { in_hit: 500, in_miss: 100, out: 80 }),
  '',
].join('\n')

test("a job's results.jsonl folds into its models: prefix and provider cut, a bad line skipped, a re-run task counted once, a missing file null", async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-swarm-models-'))
  try {
    const jobDir = join(home, 'job-1')
    mkdirSync(jobDir)
    writeFileSync(join(jobDir, 'results.jsonl'), FIXTURE)

    expect(await jobModels({ id: 'job-1', active: false }, jobDir)).toEqual([
      { model: 'deepseek-v4-flash', tasks: 3, ok: 2, failed: 1, tokens: 1650 + 680 + 900 },
      { model: 'qwen-3-coder', tasks: 2, ok: 0, failed: 1, tokens: 420 },
    ])
    expect(await jobModels({ id: 'job-2', active: false }, join(home, 'no-such-job'))).toBeNull()
    expect(shortModel('plain-model')).toBe('plain-model')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
