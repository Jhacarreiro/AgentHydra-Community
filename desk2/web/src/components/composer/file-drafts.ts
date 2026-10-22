// The files attached in a box and not yet sent, per draft slot (logic.ts draftSlot), kept in memory for the window: a
// box that is mounted again (an outside session's view is keyed by its session) finds what was attached there, and a
// send Undo takes back after its box is gone puts its files back here. Unlike pictures, they do not outlive a reload.

/** A file the composer attaches by path: uploaded on attach, sent as a `[File: source: …]` line. */
export interface PendingFile {
  id: string
  name: string
  bytes: number
  mediaType: string
  path?: string
  /** The file's bytes, kept to show it in the viewer and to draw a PDF's first page. */
  blob?: Blob
}

export const fileDrafts = new Map<string | null, PendingFile[]>()
