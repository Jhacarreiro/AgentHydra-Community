// A user's attachment is a fixed square, as Claude and Codex show them: the picture fills it, a tall page anchored at
// its top, anything else centred.

export const ATTACHMENT_TILE = 120

export interface AttachmentTile {
  size: number
  objectPosition: string
}

export function attachmentTile(naturalWidth: number, naturalHeight: number): AttachmentTile {
  const known = naturalWidth > 0 && naturalHeight > 0
  const tall = known && naturalHeight > naturalWidth
  return { size: ATTACHMENT_TILE, objectPosition: tall ? 'center top' : 'center' }
}
