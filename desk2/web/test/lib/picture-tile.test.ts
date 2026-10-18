import { describe, expect, it } from 'bun:test'
import { ATTACHMENT_TILE, attachmentTile } from '../../src/lib/picture-tile'

describe('attachmentTile', () => {
  it('is a fixed 120px square for a wide strip, centred', () => {
    expect(attachmentTile(2400, 140)).toEqual({ size: 120, objectPosition: 'center' })
    expect(ATTACHMENT_TILE).toBe(120)
  })

  it('is a 120px square for a tall page, anchored at its top', () => {
    expect(attachmentTile(400, 3000)).toEqual({ size: 120, objectPosition: 'center top' })
  })

  it('is a 120px square for a photo, centred', () => {
    expect(attachmentTile(1600, 1000)).toEqual({ size: 120, objectPosition: 'center' })
  })

  it('is a 120px square centred for an unknown size', () => {
    for (const [w, h] of [[0, 0], [0, 800], [640, 0], [Number.NaN, 480]] as const) {
      expect(attachmentTile(w, h)).toEqual({ size: 120, objectPosition: 'center' })
    }
  })
})
