import { describe, it, expect } from 'bun:test'
import { readOnlyChild } from '@/components/shell/readonly-child'

const parent = { id: 'p1', title: 'Launch plan' }

describe('readOnlyChild', () => {
  it('answers null for an ordinary chat', () => {
    expect(readOnlyChild({ title: 'Notes', parentId: null }, [parent])).toBeNull()
    expect(readOnlyChild({ title: 'Notes' }, [parent])).toBeNull()
  })

  it('counts an empty-string parentId as ordinary', () => {
    expect(readOnlyChild({ title: 'Notes', parentId: '' }, [parent])).toBeNull()
  })

  it('answers the parent id, its title and the draft for a child', () => {
    expect(readOnlyChild({ title: 'Fix login', parentId: 'p1' }, [parent])).toEqual({
      parentId: 'p1',
      parentTitle: 'Launch plan',
      draft: 'About "Fix login": '
    })
  })

  it('falls back to the generic words when the parent is not in the list', () => {
    expect(readOnlyChild({ title: 'Fix login', parentId: 'gone' }, [parent])).toEqual({
      parentId: 'gone',
      parentTitle: 'the parent chat',
      draft: 'About "Fix login": '
    })
  })
})
