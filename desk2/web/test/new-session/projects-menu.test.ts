import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addProjectFolder, type ProjectMenuApi, projectActions, runProjectAction } from '../../src/components/shell/projects'

function recorder(): { api: ProjectMenuApi; calls: string[] } {
  const calls: string[] = []
  const api: ProjectMenuApi = {
    pin: async (path) => void calls.push(`pin ${path}`),
    unpin: async (path) => void calls.push(`unpin ${path}`),
    reveal: async (path) => void calls.push(`reveal ${path}`),
    newChat: (path) => void calls.push(`newChat ${path}`),
    dashboard: (path) => void calls.push(`dashboard ${path}`),
    copy: async (path) => void calls.push(`copy ${path}`),
    hide: async (path) => void calls.push(`hide ${path}`),
    unhide: async (path) => void calls.push(`unhide ${path}`),
  }
  return { api, calls }
}

describe('project tile menu', () => {
  test('lists the actions in order: Pin to top first, Open dashboard after New chat here', () => {
    expect(projectActions(false).map((a) => a.label)).toEqual(['Pin to top', 'Open file location', 'New chat here', 'Open dashboard', 'Copy path', 'Hide from Projects'])
  })

  test('a pinned project offers Unpin where Pin to top was; a hidden one offers no pin', () => {
    expect(projectActions(false, true)[0]).toEqual({ action: 'unpin', label: 'Unpin' })
    expect(projectActions(true).map((a) => a.action)).not.toContain('pin')
    expect(projectActions(true, true).map((a) => a.action)).not.toContain('unpin')
  })

  test('each action runs its own call with the tile path', async () => {
    const { api, calls } = recorder()
    for (const { action } of projectActions(false)) await runProjectAction(action, 'C:/Users/me/Desktop/Project/app', api)
    await runProjectAction('unpin', 'C:/Users/me/Desktop/Project/app', api)
    expect(calls).toEqual([
      'pin C:/Users/me/Desktop/Project/app',
      'reveal C:/Users/me/Desktop/Project/app',
      'newChat C:/Users/me/Desktop/Project/app',
      'dashboard C:/Users/me/Desktop/Project/app',
      'copy C:/Users/me/Desktop/Project/app',
      'hide C:/Users/me/Desktop/Project/app',
      'unpin C:/Users/me/Desktop/Project/app',
    ])
  })
})

describe('the New screen project state', () => {
  test('the action error sits outside the loading / empty / grid chain, so a failed action keeps the grid', () => {
    const template = readFileSync(join(import.meta.dir, '../../src/components/shell/NewSessionScreen.vue'), 'utf8')
    const lines = template.split('\n')
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle))
    const alert = at('v-if="actionProblem"')
    const problem = at('v-if="problem && !answer"')
    expect(alert).toBeGreaterThan(-1)
    expect(problem).toBeGreaterThan(alert)
    expect(lines[problem + 1]).toContain('v-else-if="!answer && loading"')
    expect(lines.slice(alert, problem).some((l) => l.includes('v-else'))).toBe(false)
  })
})

describe('adding a folder from the New screen', () => {
  test('a picked folder is added under the chosen kind', async () => {
    const changes: unknown[][] = []
    const added = await addProjectFolder('roots', {
      pickFolder: async () => 'C:/Users/me/Desktop/Project',
      changeProjectChoice: async (kind, path, on) => void changes.push([kind, path, on]),
    })
    expect(added).toBe('C:/Users/me/Desktop/Project')
    expect(changes).toEqual([['roots', 'C:/Users/me/Desktop/Project', true]])
  })

  test('a cancelled picker changes nothing', async () => {
    const changes: unknown[][] = []
    const added = await addProjectFolder('folders', {
      pickFolder: async () => null,
      changeProjectChoice: async (kind, path, on) => void changes.push([kind, path, on]),
    })
    expect(added).toBeNull()
    expect(changes).toEqual([])
  })
})
