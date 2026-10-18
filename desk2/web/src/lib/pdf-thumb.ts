// A PDF's first-page thumbnail, rendered once per file and height, then kept: a failed or slow render is
// remembered as null, so a card that scrolls back into view shows the file chip again without re-rendering.

export const PDF_THUMB_DEADLINE_MS = 10_000

const cache = new Map<string, Promise<string | null>>()

export function pdfFirstPageThumb(key: string, height: number, produce: () => Promise<string>): Promise<string | null> {
  const id = `${key}@${height}`
  const hit = cache.get(id)
  if (hit) return hit
  const thumb = withDeadline(Promise.resolve().then(produce), PDF_THUMB_DEADLINE_MS).catch(() => null)
  cache.set(id, thumb)
  return thumb
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('pdf thumbnail timed out')), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}
