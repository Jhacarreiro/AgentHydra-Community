import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ImageRef } from '@shared/protocol'
import { renderMarkdown } from '../../src/components/transcript/lib/markdown'
import { htmlSrc, imageSrc, videoSrc } from '../../src/components/transcript/lib/media'

const HASH = 'a'.repeat(64)
const html: ImageRef = { mediaType: 'text/html', url: `/api/media/${HASH}.html?v=2`, bytes: 120, name: 'preview.html' }
const png: ImageRef = { mediaType: 'image/png', url: `/api/media/${HASH}.png`, bytes: 120 }
const mp4: ImageRef = { mediaType: 'video/mp4', url: `/api/media/${HASH}.mp4`, bytes: 120 }

describe('html previews in the transcript', () => {
  test('a text/html ref is an html preview, never a picture or a video', () => {
    expect(htmlSrc(html)).toBe(html.url!)
    expect(htmlSrc(png)).toBeNull()
    expect(htmlSrc(mp4)).toBeNull()
    expect(imageSrc(html)).toBeNull()
    expect(videoSrc(html)).toBeNull()
  })

  test('a markdown image of a cached html file renders a sandboxed iframe, not an img', () => {
    const out = renderMarkdown(`![campaign](${html.url})`)
    expect(out).toContain(`<iframe class="html-preview-frame" src="${html.url}" sandbox=""`)
    expect(out).toMatch(/<iframe[^>]* sandbox=""/)
    expect(out).not.toContain('<img')
    expect(out).not.toContain('allow-scripts')
    expect(out).not.toContain('allow-same-origin')
  })

  test('pictures and videos in markdown stay img and video', () => {
    const pic = renderMarkdown(`![dot](${png.url})`)
    expect(pic).toContain('<img')
    expect(pic).not.toContain('<iframe')
    expect(renderMarkdown(`![clip](${mp4.url})`)).toContain('<video')
  })

  test('the tile renders an html ref as the same sandboxed card markdown draws, not an img', () => {
    const src = readFileSync(new URL('../../src/components/transcript/parts/HtmlPreview.vue', import.meta.url), 'utf8')
    expect(src).toContain('htmlPreviewMarkup(')
    expect(src).not.toContain('<iframe')
    expect(src).not.toMatch(/allow-(scripts|same-origin)/)
    const tiles = readFileSync(new URL('../../src/components/transcript/parts/ImageTiles.vue', import.meta.url), 'utf8')
    expect(tiles).toContain('HtmlPreview')
  })
})
