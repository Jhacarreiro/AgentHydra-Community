// Pictures and files in the transcript: where an ImageRef loads from, what its file card says, the
// one lightbox every picture opens in, the html preview's buttons. Pure apart from the shared lightbox ref and those buttons.
import { ref } from 'vue'
import type { ImageRef } from '@shared/protocol'

import { stepIndex } from './viewer'

export { isSendFileTool } from './tools'

/** The picture's address: the server's cache url, else the bytes the window itself sent; null for a video, a PDF or a file card only. */
export function imageSrc(img: ImageRef): string | null {
  if (img.url && img.url.startsWith('/api/media/') && !img.mediaType.startsWith('video/') && img.mediaType !== 'text/html' && img.mediaType !== 'application/pdf') return img.url
  if (img.dataBase64 && /^image\/(png|jpeg|gif|webp)$/.test(img.mediaType)) return `data:${img.mediaType};base64,${img.dataBase64}`
  return null
}

/** A video's address: the server's cache url of an mp4 or webm; null for anything else. */
export function videoSrc(img: ImageRef): string | null {
  return img.mediaType.startsWith('video/') && img.url?.startsWith('/api/media/') ? img.url : null
}

/** A PDF's address: the server's cache url of a PDF; null for anything else. */
export function pdfSrc(img: ImageRef): string | null {
  return img.mediaType === 'application/pdf' && img.url?.startsWith('/api/media/') ? img.url : null
}

/** An html preview's address: the server's cache url of a page a reply shows live; null for anything else. */
export function htmlSrc(img: ImageRef): string | null {
  return img.mediaType === 'text/html' && img.url?.startsWith('/api/media/') ? img.url : null
}

/** The type badge of a file card: the extension in capitals ("PNG"), else the media subtype. */
export function fileBadge(img: ImageRef): string {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(img.name ?? '')?.[1]
  if (ext) return ext.toUpperCase()
  const sub = img.mediaType.split('/')[1] ?? 'file'
  return (sub === 'jpeg' ? 'jpg' : sub.replace(/^svg\+xml$/, 'svg')).toUpperCase().slice(0, 5)
}

/** A file size as the real card writes it: "67.2KB", "1.4MB", "812B". */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** What the viewer shows an item as: a picture (the default), a video, a PDF, an html page, text, or only a file card. */
export type ViewerKind = 'picture' | 'video' | 'pdf' | 'html' | 'text' | 'file'

export interface ViewerPicture {
  src: string
  alt: string
  /** A picture attached in the box and not yet sent: its id there, so an annotated copy lands right after it. */
  attachId?: string
  kind?: ViewerKind
  mediaType?: string
  bytes?: number
  /** Where the file is, for "Show in folder": its path on disk, or its cache url. */
  reveal?: { path?: string; media?: string }
  /** Frees the object URL behind the item; run when the viewer closes or another group replaces this one. */
  revoke?: () => void
}

const TEXT_NAME = /\.(txt|md|markdown|json|csv|tsv|log|xml|ya?ml|js|jsx|ts|tsx|py|css|sh|ps1|ini|toml|sql)$/i

/** The viewer kind of a file, by its media type and, for text, its name. */
export function viewerKindOf(mediaType: string, name = ''): ViewerKind {
  if (mediaType.startsWith('image/')) return 'picture'
  if (mediaType.startsWith('video/')) return 'video'
  if (mediaType === 'application/pdf') return 'pdf'
  if (mediaType === 'text/html') return 'html'
  if (mediaType.startsWith('text/') || /\/(json|xml|csv|x-yaml|javascript|x-sh)$/.test(mediaType) || TEXT_NAME.test(name)) return 'text'
  return 'file'
}

/** An attachment as a viewer item; a kind whose bytes are not reachable falls back to a file card. */
export function viewerItemFor(img: ImageRef): ViewerPicture {
  const alt = img.name ?? ''
  const kind = viewerKindOf(img.mediaType, img.name)
  const url = img.url?.startsWith('/api/media/') ? img.url : null
  const src = kind === 'picture' ? imageSrc(img) : kind === 'file' ? null : url
  return {
    src: src ?? '',
    alt,
    kind: src ? kind : 'file',
    mediaType: img.mediaType,
    bytes: img.bytes,
    reveal: img.path ? { path: img.path } : url ? { media: url } : undefined,
  }
}

/** The viewer saved an annotated copy: the window event, whose detail is an Annotated. */
export const ANNOTATED_EVENT = 'hydra-desk:annotated'

/**
 * An annotated copy for the box. With `afterId` the box holding that attachment puts it right after it; without
 * (a picture already in the transcript) the box on screen attaches it. The box that takes it sets `taken`.
 */
export interface Annotated {
  dataUrl: string
  mediaType: string
  name: string
  afterId?: string
  taken?: boolean
}

/** The viewer's state while it is open: the pictures of one message and which one shows; null when closed. */
export const lightbox = ref<{ items: ViewerPicture[]; index: number } | null>(null)

/**
 * Open the viewer on `src`. `group` is the message's pictures in order (Left/Right step through them); without
 * it, or when `src` is not among them, the viewer holds just that one picture.
 */
export function openLightbox(src: string, alt = '', group?: ViewerPicture[]): void {
  const at = group ? group.findIndex((p) => p.src === src) : -1
  openViewerAt(at >= 0 ? group! : [{ src, alt }], Math.max(at, 0))
}

/** Open the viewer on the item at `index` of `items`, releasing the group it replaces. */
export function openViewerAt(items: ViewerPicture[], index: number): void {
  releaseItems(lightbox.value?.items)
  lightbox.value = { items, index }
}

export function closeLightbox(): void {
  const lb = lightbox.value
  lightbox.value = null
  releaseItems(lb?.items)
}

function releaseItems(items: ViewerPicture[] | undefined): void {
  for (const item of items ?? []) item.revoke?.()
}

/** Show the previous or next picture of the message; stops at both ends. */
export function stepLightbox(delta: number): void {
  const lb = lightbox.value
  if (lb) lightbox.value = { items: lb.items, index: stepIndex(lb.index, lb.items.length, delta) }
}

/**
 * Space on a focused picture tile opens the viewer (a click does too). The key is taken here, both on press
 * and release, so the button's own "click on Space release" cannot reopen a viewer that Space just closed.
 */
export function tileKey(e: { key: string; type: string; preventDefault(): void }, open: () => void): void {
  if (e.key !== ' ' && e.key !== 'Spacebar') return
  e.preventDefault()
  if (e.type === 'keydown') open()
}

/**
 * A click in an html preview's bar (lib/markdown.ts htmlPreviewMarkup): Desktop or Phone sets the frame's width, Expand
 * makes it taller and back. The card keeps the state as its own classes. True when the click was one of its buttons.
 */
export function htmlPreviewClick(target: Element): boolean {
  const card = target.closest('.html-preview')
  if (!card) return false
  const view = target.closest<HTMLElement>('[data-html-view]')
  if (view) {
    const phone = view.dataset.htmlView === 'phone'
    card.classList.toggle('is-phone', phone)
    for (const b of card.querySelectorAll<HTMLElement>('[data-html-view]')) b.setAttribute('aria-pressed', String(b.dataset.htmlView === (phone ? 'phone' : 'desktop')))
    return true
  }
  const expand = target.closest<HTMLElement>('[data-html-expand]')
  if (!expand) return false
  const big = card.classList.toggle('is-big')
  expand.setAttribute('aria-expanded', String(big))
  expand.setAttribute('aria-label', big ? 'Smaller' : 'Expand')
  expand.title = big ? 'Smaller' : 'Expand'
  return true
}
