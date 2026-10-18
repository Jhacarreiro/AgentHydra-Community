import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { ServerContext } from '../../src/context'
import { rewriteLocalImages } from '../../src/engine/normalize'
import { createMediaCache, MAX_HTML_BYTES, mediaCache } from '../../src/media/cache'
import plugin from '../../src/plugins/35-media'

const temps: string[] = []
const temp = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `desk-html-${tag}-`))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

const HTML = Buffer.from('<!doctype html><html><body><img src="https://example.com/logo.png"></body></html>')
const HTML_ID_RE = /^\/api\/media\/[0-9a-f]{64}\.html\?v=2$/

describe('html previews', () => {
  test('a local .html or .htm file is cached as text/html, served by its content, and capped', () => {
    const root = temp('cache')
    const dir = join(temp('cache-media'), 'media')
    const c = createMediaCache(dir)
    writeFileSync(join(root, 'preview.html'), HTML)
    writeFileSync(join(root, 'preview.htm'), HTML)
    writeFileSync(join(root, 'huge.html'), Buffer.alloc(MAX_HTML_BYTES + 1, 0x61))
    writeFileSync(join(root, 'binary.html'), Buffer.from([0x3c, 0x00, 0x68]))
    writeFileSync(join(root, 'notes.txt'), HTML)
    const a = c.preview(join(root, 'preview.html'))!
    expect(a).toMatchObject({ mediaType: 'text/html', bytes: HTML.length })
    expect(a.url).toMatch(HTML_ID_RE)
    expect(c.preview(join(root, 'preview.htm'))!.url).toBe(a.url!)
    expect(c.preview(join(root, 'huge.html'))).toBeNull()
    expect(c.preview(join(root, 'binary.html'))).toBeNull()
    expect(c.preview(join(root, 'notes.txt'))).toBeNull()
  })

  test('a markdown image of a local html file in a reply becomes its cached url', () => {
    const root = temp('reply')
    const file = join(root, 'preview.html')
    writeFileSync(file, HTML)
    const media = createMediaCache(join(temp('reply-media'), 'media'))
    const out = rewriteLocalImages(`![campaign](${file.replaceAll('\\', '/')})`, new Set(), media)
    expect(out).toMatch(/^!\[campaign\]\(\/api\/media\/[0-9a-f]{64}\.html\?v=2\)$/)
  })

  test('GET serves html as text/html with a sandbox CSP that still lets remote images load', async () => {
    const home = temp('route')
    const app = new Hono()
    plugin(app, { home } as ServerContext)
    const root = temp('route-file')
    writeFileSync(join(root, 'preview.html'), HTML)
    const url = mediaCache(home)!.preview(join(root, 'preview.html'))!.url!
    const res = await app.request(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toMatch(/(^|;)\s*sandbox\s*(;|$)/)
    expect(csp).not.toContain('allow-scripts')
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).toMatch(/img-src[^;]*https:/)
    expect(new TextDecoder().decode(await res.arrayBuffer())).toContain('https://example.com/logo.png')
  })

  test('GET puts the preview scrollbar after the doctype (never before it: quirks mode) and is asked again each time', async () => {
    const home = temp('scroll')
    const app = new Hono()
    plugin(app, { home } as ServerContext)
    const root = temp('scroll-file')
    const pages = [
      ['<!doctype html><html><body>a</body></html>', '<!doctype html><style>'],
      ['<!-- sent by example.test -->\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"><html><body>b</body></html>', '<!-- sent by example.test -->\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"><style>'],
      ['<table><tr><td>c</td></tr></table>', '<style>'],
    ] as const
    for (const [i, [page, start]] of pages.entries()) {
      writeFileSync(join(root, `p${i}.html`), page)
      const res = await app.request(mediaCache(home)!.preview(join(root, `p${i}.html`))!.url!)
      const body = await res.text()
      expect(body.startsWith(start)).toBe(true)
      expect(body).toContain('::-webkit-scrollbar-thumb')
      expect(body.endsWith(page.slice(start.length - '<style>'.length))).toBe(true)
      expect(res.headers.get('cache-control')).toBe('no-cache')
    }
  })
})
