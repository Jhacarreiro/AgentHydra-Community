import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeLightbox, lightbox, openViewerAt, viewerItemFor, viewerKindOf, type ViewerPicture } from '../../src/components/transcript/lib/media'

const src = (rel: string) => readFileSync(join(import.meta.dir, '../../src/components', rel), 'utf8')

describe('viewer kinds', () => {
  test('maps media types to the viewer kind', () => {
    expect(viewerKindOf('image/png')).toBe('picture')
    expect(viewerKindOf('video/mp4')).toBe('video')
    expect(viewerKindOf('application/pdf')).toBe('pdf')
    expect(viewerKindOf('text/html')).toBe('html')
    expect(viewerKindOf('text/plain')).toBe('text')
    expect(viewerKindOf('application/json')).toBe('text')
    expect(viewerKindOf('application/octet-stream')).toBe('file')
    expect(viewerKindOf('application/zip', 'example.zip')).toBe('file')
  })

  test('a text file is recognised by its name when its media type is generic', () => {
    expect(viewerKindOf('application/octet-stream', 'notes.md')).toBe('text')
    expect(viewerKindOf('application/octet-stream', 'example.pdf')).toBe('file')
  })

  test('a PDF attachment on a URL is a pdf item that keeps its cache url for reveal', () => {
    const item = viewerItemFor({ name: 'example.pdf', mediaType: 'application/pdf', bytes: 10, url: '/api/media/abc' } as never)
    expect(item.kind).toBe('pdf')
    expect(item.src).toBe('/api/media/abc')
    expect(item.reveal).toEqual({ media: '/api/media/abc' })
  })

  test('a file with no reachable bytes falls back to a file card', () => {
    const item = viewerItemFor({ name: 'example.zip', mediaType: 'application/zip', bytes: 10 } as never)
    expect(item.kind).toBe('file')
    expect(item.src).toBe('')
  })
})

describe('viewer object URLs', () => {
  afterEach(() => closeLightbox())

  const item = (log: string[], name: string): ViewerPicture => ({ src: name, alt: name, kind: 'pdf', revoke: () => log.push(name) })

  test('closing the viewer releases every item it held', () => {
    const log: string[] = []
    openViewerAt([item(log, 'a'), item(log, 'b')], 0)
    closeLightbox()
    expect(log).toEqual(['a', 'b'])
    expect(lightbox.value).toBeNull()
  })

  test('opening another group releases the one it replaces', () => {
    const log: string[] = []
    openViewerAt([item(log, 'a')], 0)
    openViewerAt([item(log, 'b')], 0)
    expect(log).toEqual(['a'])
    closeLightbox()
    expect(log).toEqual(['a', 'b'])
  })
})

describe('top-right clearance', () => {
  test('the viewer top bar reserves the caption buttons', () => {
    expect(src('transcript/parts/Lightbox.vue')).toContain('var(--caption-w)')
  })

  test('the annotator toolbar reserves the caption buttons', () => {
    expect(src('transcript/parts/Annotator.vue')).toContain('var(--caption-w)')
  })
})
