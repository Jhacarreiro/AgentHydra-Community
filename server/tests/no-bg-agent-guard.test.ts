import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { NO_BG_AGENT_SCRIPT, workerHooks } from '../src/climayte-signal'

const run = (input: string) =>
  spawnSync('node', ['-e', NO_BG_AGENT_SCRIPT], { input, encoding: 'utf8' })

describe('background sub-agent guard', () => {
  test('denies run_in_background true with exit 2 and the reason', () => {
    for (const tool_name of ['Agent', 'Task']) {
      const r = run(JSON.stringify({ tool_name, tool_input: { run_in_background: true } }))
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('climayte_run')
      expect(r.stderr).toContain('foreground')
    }
  })
  test('allows false, absent, other tools and unreadable input', () => {
    expect(run(JSON.stringify({ tool_input: { run_in_background: false } })).status).toBe(0)
    expect(run(JSON.stringify({ tool_input: { prompt: 'x' } })).status).toBe(0)
    expect(run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })).status).toBe(0)
    expect(run('not json').status).toBe(0)
  })
  test('workerHooks carries it on Agent|Task for a chat and a worker, node with no python', () => {
    for (const stopUrl of [null, 'http://127.0.0.1:1/stop']) {
      const g = workerHooks({
        signalFile: 'C:/x/s',
        claims: null,
        agentGuard: true,
        stopUrl,
      }).PreToolUse?.find((x) => x.matcher === 'Agent|Task')
      expect(g?.hooks[0]).toMatchObject({
        type: 'command',
        command: 'node',
        args: ['-e', NO_BG_AGENT_SCRIPT],
      })
    }
    expect(workerHooks({ signalFile: 'C:/x/s', claims: null }).PreToolUse).toBeUndefined()
  })
})
