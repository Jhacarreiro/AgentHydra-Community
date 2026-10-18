// The manager a chat is on, as its sidebar row draws it (owner, 2026-10-13): a small round avatar left of the title,
// the manager's photo when it has one (~/.agenthydra/managers/<slug>/avatar.*, served by GET /api/managers/:slug/avatar),
// else its initial on a muted tone of the slug's own. A click on it opens the manager's card (ManagerAvatar.vue), where
// "Change photo" replaces the photo for every row of that manager. With no manager it is the chat's Hydra Core lead or
// the persona a seat sits as (`role`); a persona who is no manager (`persona`) has its photo from GET
// /api/personas/:slug/avatar, which Desk does not change. Pure but for the one upload call, so the tests share it.

import { reactive } from 'vue'
import type { ChatSummary } from '@shared/protocol'

export type ChatManager = NonNullable<ChatSummary['manager']>

/** The hues an initial is drawn on: no blue or indigo (HSwarm's alone in the sidebar), no red or green (failed and done). */
const HUES = [50, 80, 195, 310, 350] as const

/** The picture types a photo may be, as the file picker's accept list; the server takes the same four. */
export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024

/** A photo's version as this window last uploaded it, by slug: every row of the manager shows it before the server's update lands. */
const uploaded = reactive(new Map<string, number>())

/** A stable non-negative hash of a slug (FNV-1a). */
function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

export interface ManagerFace {
  /** The photo's address with its version, or null for none. */
  src: string | null
  initial: string
  /** The initial's background and letter colours. */
  tone: { bg: string; fg: string }
  /** 'Manager: Ada, Head of Design' ('Lead: …', 'Seat: …' for Hydra Core's): the avatar's hover label and accessible name. */
  label: string
  /** Whether the card offers Change photo: a manager's photo is its folder's, a persona's is read from elsewhere. */
  canChangePhoto: boolean
}

const ROLE_WORD = { lead: 'Lead', seat: 'Seat' } as const

export function managerFace(manager: ChatManager): ManagerFace {
  // The newer of this window's upload and the server's photo: another window may have replaced it since.
  const local = uploaded.get(manager.slug)
  const version = local !== undefined && (manager.photo == null || local > manager.photo) ? local : (manager.photo ?? null)
  const hue = HUES[hash(manager.slug) % HUES.length]!
  const initial = (Array.from(manager.name.trim())[0] ?? '?').toUpperCase()
  const route = manager.persona ? 'personas' : 'managers'
  const word = manager.role ? ROLE_WORD[manager.role] : 'Manager'
  return {
    src: version === null ? null : `/api/${route}/${encodeURIComponent(manager.slug)}/avatar?v=${version}`,
    initial,
    tone: { bg: `oklch(0.36 0.07 ${hue})`, fg: `oklch(0.9 0.06 ${hue})` },
    label: manager.title ? `${word}: ${manager.name}, ${manager.title}` : `${word}: ${manager.name}`,
    canChangePhoto: !manager.persona,
  }
}

/** Why a picked file cannot be a manager's photo, in a sentence the card shows; null when it can. */
export function photoProblem(file: { type: string; size: number }): string | null {
  if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) return 'A manager photo must be a PNG, JPG, WebP or GIF.'
  if (file.size > PHOTO_MAX_BYTES) return 'That photo is over 2 MB.'
  if (!file.size) return 'That file is empty.'
  return null
}

/** Replaces the manager's photo with `file`; throws the server's refusal as the Error's message. */
export async function uploadPhoto(slug: string, file: File): Promise<void> {
  const problem = photoProblem(file)
  if (problem) throw new Error(problem)
  const res = await fetch(`/api/managers/${encodeURIComponent(slug)}/avatar`, { method: 'PUT', headers: { 'content-type': file.type }, body: file })
  const body = (await res.json().catch(() => null)) as { photo?: unknown; error?: unknown } | null
  if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `The photo was not saved (${res.status}).`)
  uploaded.set(slug, typeof body?.photo === 'number' ? body.photo : Date.now())
}
