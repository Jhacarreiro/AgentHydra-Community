// Renders a PDF's first page to a JPEG data url `height` px high (drawn at twice that, so it stays sharp on a
// retina screen). pdfjs and its worker load on the first render only, so they stay out of the initial chunk.
type PdfJs = typeof import('pdfjs-dist')

let pdfjs: Promise<PdfJs> | null = null

function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default
    return lib
  })
  return pdfjs
}

export async function renderPdfFirstPage(source: string | Blob, height: number): Promise<string> {
  const lib = await loadPdfJs()
  const task = lib.getDocument(typeof source === 'string' ? { url: source } : { data: new Uint8Array(await source.arrayBuffer()) })
  try {
    const doc = await task.promise
    const page = await doc.getPage(1)
    const flat = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: (height * 2) / flat.height })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('no 2d canvas')
    await page.render({ canvas, canvasContext: context, viewport }).promise
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    await task.destroy()
  }
}
