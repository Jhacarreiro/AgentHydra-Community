import { describe, expect, test } from 'bun:test'
import type { TranscriptItem } from '@shared/protocol'
import { buildTranscriptIndex } from '@shared/transcript-index'
import { latestTodoList, panelLists } from '../../src/components/tasks/logic'

const task = (id: string, status: 'running' | 'completed'): TranscriptItem => ({ id, ts: 1, kind: 'task', taskId: id, description: `job ${id}`, status, taskKind: 'bash' })
const todos = (id: string): TranscriptItem => ({ id, ts: 1, kind: 'todos', todos: [{ content: 'step', status: 'completed', activeForm: 'stepping' }] }) as TranscriptItem
const user = (id: string): TranscriptItem => ({ id, ts: 1, kind: 'user', text: `say ${id}` }) as TranscriptItem

describe('facts above the loaded window', () => {
  const all = [task('old-run', 'running'), todos('t1'), user('u1'), task('old-done', 'completed'), user('u2'), user('u3')]
  const index = buildTranscriptIndex(all)
  const loaded = all.slice(4)
  const lists = () => panelLists({ workers: [], items: loaded, index, sessionId: 's1' })

  test('a task running above the window still shows in the list', () => {
    expect(lists().running.map((u) => u.id)).toEqual(['task:old-run'])
    expect(lists().finished.map((u) => u.id)).toEqual(['task:old-done'])
    expect(panelLists({ workers: [], items: loaded, sessionId: 's1' }).running).toEqual([])
  })

  test('the loaded copy of a task wins over the index', () => {
    const l = panelLists({ workers: [], items: [...loaded, task('old-run', 'completed')], index, sessionId: 's1' })
    expect(l.running).toEqual([])
    expect(l.finished.length).toBe(2)
  })

  test('the to-do list reads the index, or a built one, when the loaded rows have none', () => {
    expect(latestTodoList(loaded, index)?.length).toBe(1)
    expect(latestTodoList(loaded, null)).toBeNull()
    expect(latestTodoList(all, null)?.length).toBe(1)
    expect(index.lastUserText).toBe('say u3')
  })
})

describe('tool calls over the whole transcript', () => {
  const call = (id: string, name: string, status: 'done' | 'error' = 'done'): TranscriptItem => ({ id, ts: 1, kind: 'tool_use', name, input: {}, status, startedAt: 1 })
  test('each tool counts its calls and its failed ones, the most called first, then by name', () => {
    const items = [call('1', 'Read'), user('u1'), call('2', 'Bash', 'error'), call('3', 'mcp__hswarm__hswarm_run'), call('4', 'Bash'), call('5', 'Read'), call('6', 'Bash')]
    expect(buildTranscriptIndex(items).tools).toEqual([
      { name: 'Bash', calls: 3, errors: 1 },
      { name: 'Read', calls: 2, errors: 0 },
      { name: 'mcp__hswarm__hswarm_run', calls: 1, errors: 0 }
    ])
  })
})
