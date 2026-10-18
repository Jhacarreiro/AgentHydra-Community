import { describe, expect, it } from 'bun:test'
import type { ProjectEntry } from '@shared/protocol'
import {
  canMoveChat,
  folderMove,
  moveNote,
  pickerRows,
  stepIndex,
  workspaceLabel,
  workspaceOf
} from '../../src/components/shell/workspace-picker'

const project = (over: Partial<ProjectEntry> & Pick<ProjectEntry, 'name' | 'path'>): ProjectEntry => ({
  group: null,
  icon: null,
  sources: ['chats'],
  hidden: false,
  pinned: false,
  git: null,
  lastCommitAt: null,
  lastChatAt: null,
  openChats: 0,
  ...over
})

const alpha = project({ name: 'Alpha', path: 'C:/Users/me/Work/Alpha', openChats: 2 })
const beta = project({ name: 'Beta Tools', path: 'C:\\Users\\me\\Work\\Beta' })
const hiddenOne = project({ name: 'Old Thing', path: 'C:/Users/me/Work/Old', hidden: true })
const projects = [alpha, beta, hiddenOne]

describe('workspaceOf', () => {
  it('finds the project a chat in its folder works in', () => {
    expect(workspaceOf('C:/Users/me/Work/Alpha', projects)?.name).toBe('Alpha')
  })

  it('rolls a chat in a folder inside a checkout up to that checkout, case and slashes aside', () => {
    expect(workspaceOf('c:\\users\\me\\work\\alpha\\src\\deep', projects)?.name).toBe('Alpha')
  })

  it('picks the deepest project when several hold the folder', () => {
    const nested = project({ name: 'Alpha Inner', path: 'C:/Users/me/Work/Alpha/inner' })
    expect(workspaceOf('C:/Users/me/Work/Alpha/inner/x', [alpha, nested])?.name).toBe('Alpha Inner')
  })

  it('ignores hidden projects', () => {
    expect(workspaceOf('C:/Users/me/Work/Old', projects)).toBeNull()
  })

  it('labels a folder with no project by its own last name', () => {
    expect(workspaceLabel('C:/Users/me/Scratch/notes', projects)).toBe('notes')
    expect(workspaceLabel('C:/Users/me/Work/Beta', projects)).toBe('Beta Tools')
  })
})

describe('pickerRows', () => {
  it('keeps the order it is given and drops hidden projects', () => {
    expect(pickerRows(projects, '', null).map((r) => r.project.name)).toEqual(['Alpha', 'Beta Tools'])
  })

  it('filters by name or path, in any case', () => {
    expect(pickerRows(projects, 'TOOLS', null).map((r) => r.project.name)).toEqual(['Beta Tools'])
    expect(pickerRows(projects, 'work/alpha', null).map((r) => r.project.name)).toEqual(['Alpha'])
    expect(pickerRows(projects, '   ', null)).toHaveLength(2)
    expect(pickerRows(projects, 'nothing here', null)).toEqual([])
  })

  it('marks the current project through case-insensitive, slash-blind path matching', () => {
    const current = workspaceOf('c:\\USERS\\me\\work\\alpha', projects)
    const rows = pickerRows(projects, '', current)
    expect(rows.map((r) => r.current)).toEqual([true, false])
  })

  it('marks nothing when the chat has no project', () => {
    expect(pickerRows(projects, '', null).some((r) => r.current)).toBe(false)
  })
})

describe('stepIndex', () => {
  it('moves down and up, wrapping at both ends', () => {
    expect(stepIndex(0, 1, 3)).toBe(1)
    expect(stepIndex(2, 1, 3)).toBe(0)
    expect(stepIndex(0, -1, 3)).toBe(2)
  })

  it('starts from the first or last row when nothing is highlighted', () => {
    expect(stepIndex(-1, 1, 3)).toBe(0)
    expect(stepIndex(-1, -1, 3)).toBe(2)
  })

  it('has nothing to highlight in an empty list', () => {
    expect(stepIndex(0, 1, 0)).toBe(-1)
  })
})

describe('folderMove', () => {
  it('sends only the new folder as the chat patch', () => {
    expect(folderMove('C:/Users/me/Work/Beta')).toEqual({ cwd: 'C:/Users/me/Work/Beta' })
  })
})

describe('canMoveChat and moveNote', () => {
  it('moves only Desk chats, never an outside session', () => {
    expect(canMoveChat('6f0c2a7e-1d3b-4e8a-9c4f-2b7d5e1a0f00')).toBe(true)
    expect(canMoveChat('ext:6f0c2a7e-1d3b-4e8a-9c4f-2b7d5e1a0f00')).toBe(false)
  })

  it('says the change waits for the next message only while a turn runs', () => {
    expect(moveNote('working')).toBe('Applies from the next message')
    expect(moveNote('needs_you')).toBe('Applies from the next message')
    expect(moveNote('idle')).toBeNull()
  })
})
