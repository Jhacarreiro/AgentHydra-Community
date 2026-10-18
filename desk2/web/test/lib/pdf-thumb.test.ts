import { describe, expect, it } from 'bun:test'
import { pdfFirstPageThumb } from '../../src/lib/pdf-thumb'

describe('pdfFirstPageThumb', () => {
  it('shows the rendered page', async () => {
    expect(await pdfFirstPageThumb('pdf-ok', 120, async () => 'data:image/jpeg;base64,AAAA')).toBe('data:image/jpeg;base64,AAAA')
  })

  it('falls back to null when the render fails (encrypted, broken)', async () => {
    expect(await pdfFirstPageThumb('pdf-broken', 120, async () => { throw new Error('PasswordException') })).toBeNull()
  })

  it('falls back to null when the render throws before it starts', async () => {
    expect(await pdfFirstPageThumb('pdf-throws', 120, () => { throw new Error('no worker') })).toBeNull()
  })

  it('renders each file once per height and keeps the result', async () => {
    let calls = 0
    const produce = async () => {
      calls++
      return `data:image/jpeg;base64,${calls}`
    }
    const first = await pdfFirstPageThumb('pdf-cached', 120, produce)
    const again = await pdfFirstPageThumb('pdf-cached', 120, produce)
    expect(again).toBe(first)
    expect(calls).toBe(1)
    await pdfFirstPageThumb('pdf-cached', 96, produce)
    expect(calls).toBe(2)
  })

  it('keeps a failed render as null instead of retrying on every mount', async () => {
    let calls = 0
    const produce = async () => {
      calls++
      throw new Error('broken')
    }
    expect(await pdfFirstPageThumb('pdf-failed-once', 120, produce)).toBeNull()
    expect(await pdfFirstPageThumb('pdf-failed-once', 120, produce)).toBeNull()
    expect(calls).toBe(1)
  })
})
