// GET /api/media/<sha256>.<ext>: a picture or video from the content-addressed cache (server/src/media).
// Only cache entries by hash; any other id, a path-looking one included, is refused. A Range request gets
// that slice (206), so a video can seek and start before it has all arrived.

import type { Hono } from 'hono'
import type { ServerContext } from '../context'
import { mediaCache } from '../media/cache'

/** One `bytes=` range of a file of `size` bytes, inclusive; null = serve the whole file, 'unsatisfiable' = 416. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '')
  if (!m || (!m[1] && !m[2])) return null // absent, malformed or several ranges: the whole file
  if (!m[1]) {
    const suffix = Number(m[2])
    if (!suffix || !size) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}

/** An html preview runs no script and has no origin of the Desk's; remote pictures and styles in an email still load. */
const HTML_CSP = "sandbox; default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline' https:; font-src data: https:; media-src data: blob: https:"

/** The preview's thin scrollbar, the window's own (style.css), a grey thumb that reads on any page; its see-through track
 *  shows the card's dark stage around the frame (transcript.css). No script runs in the page and the window's styles
 *  never reach into its frame, so it travels in the page. */
const PREVIEW_SCROLLBAR =
  '<style>::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}::-webkit-scrollbar-thumb{background:rgba(128,128,128,.45);border-radius:4px}::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,.7)}</style>'

/** The page with the preview's scrollbar first among its styles, so a page that styles its own still wins. It goes after
 *  the doctype and anything allowed before one: in front of the doctype it would put the page in quirks mode. */
function withPreviewScrollbar(html: string): string {
  const at = /^\uFEFF?(?:\s|<!--[\s\S]*?-->|<\?[^>]*>)*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0
  return html.slice(0, at) + PREVIEW_SCROLLBAR + html.slice(at)
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const cache = mediaCache(ctx.home)
  app.get('/api/media/:id', async (c) => {
    const hit = cache?.lookup(c.req.param('id'))
    if (!hit) return c.json({ error: 'no such picture or video' }, 404)
    const file = Bun.file(hit.path)
    const html = hit.contentType.startsWith('text/html')
    const headers: Record<string, string> = {
      'content-type': hit.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': html ? HTML_CSP : "default-src 'none'",
    }
    // A page is served whole with its scrollbar, and asked again each time: what is added to it can change.
    if (html) return new Response(withPreviewScrollbar(await file.text()), { headers: { ...headers, 'cache-control': 'no-cache' } })
    headers['accept-ranges'] = 'bytes'
    const range = byteRange(c.req.header('range'), file.size)
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${file.size}` } })
    if (range) {
      const { start, end } = range
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${file.size}`, 'content-length': String(end - start + 1) },
      })
    }
    return new Response(file, { headers })
  })
}
