import { describe, expect, it } from 'bun:test'
import { todoEntryShown, todoPressed } from '@/components/fourman/logic'

describe('todoEntryShown', () => {
  it('hides every entry point while the board is unavailable', () => {
    expect(todoEntryShown(false, 'C:/Example/Project')).toBe(false)
  })

  it('hides an entry with no folder to show', () => {
    expect(todoEntryShown(true, null)).toBe(false)
    expect(todoEntryShown(true, undefined)).toBe(false)
    expect(todoEntryShown(true, '')).toBe(false)
  })

  it('shows an entry once the board is available and has a folder', () => {
    expect(todoEntryShown(true, 'C:/Example/Project')).toBe(true)
  })
})

describe('todoPressed', () => {
  it('is pressed only for the folder the pane is showing', () => {
    expect(todoPressed('C:/Example/Project', 'C:/Example/Project')).toBe(true)
    expect(todoPressed('C:/Example/Other', 'C:/Example/Project')).toBe(false)
  })

  it('is not pressed when nothing is showing or there is no folder', () => {
    expect(todoPressed(null, 'C:/Example/Project')).toBe(false)
    expect(todoPressed('C:/Example/Project', null)).toBe(false)
  })
})
