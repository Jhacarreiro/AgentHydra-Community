// The managers Desk shows on a chat: the folder AGENTHYDRA_MANAGERS_DIR (default ~/.agenthydra/managers) holds
// one folder per manager with a persona.json, and sessions/<claude session id>.json names the manager a session is on.

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { managerStats } from './manager-stats'

export const MANAGER_SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/

export const AVATAR_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
export type AvatarExt = keyof typeof AVATAR_TYPES

export type ManagerAvatar = { path: string; ext: AvatarExt; contentType: string; photo: number }

export type CurrentManager = { slug: string; name: string; title: string | null; oneLiner: string | null; photo: number | null; statsLine: string | null }

export function managersDir(): string {
  return process.env.AGENTHYDRA_MANAGERS_DIR?.trim() || join(homedir(), '.agenthydra', 'managers')
}

function readObject(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function personaOf(slug: string): Record<string, unknown> | null {
  return MANAGER_SLUG.test(slug) ? readObject(join(managersDir(), slug, 'persona.json')) : null
}

export function managerName(slug: string): string | null {
  return text(personaOf(slug)?.name)
}

/** The newest avatar.png, .jpg, .webp or .gif in the manager's folder; photo is its mtime in whole ms. */
export function managerAvatar(slug: string): ManagerAvatar | null {
  if (!MANAGER_SLUG.test(slug)) return null
  const dir = join(managersDir(), slug)
  let newest: ManagerAvatar | null = null
  for (const ext of Object.keys(AVATAR_TYPES) as AvatarExt[]) {
    const path = join(dir, `avatar.${ext}`)
    const st = statSync(path, { throwIfNoEntry: false })
    if (!st?.isFile()) continue
    const photo = Math.floor(st.mtimeMs)
    if (!newest || photo > newest.photo) newest = { path, ext, contentType: AVATAR_TYPES[ext], photo }
  }
  return newest
}

function sessionManager(sessionId: string): string | null {
  if (!/^[\w-]+$/.test(sessionId)) return null
  return text(readObject(join(managersDir(), 'sessions', `${sessionId}.json`))?.manager)
}

/** How long a manager's label is reused before its folder is read again: a persona or photo changed by hand shows
 *  within this, and forgetManager (a photo saved in Desk) drops it at once. Every chat on a manager shares one read. */
const LABEL_MS = 5000
const labels = new Map<string, { at: number; label: Omit<CurrentManager, 'slug'> | null }>()

function labelOf(slug: string): Omit<CurrentManager, 'slug'> | null {
  const key = join(managersDir(), slug)
  const hit = labels.get(key)
  const now = Date.now()
  if (hit && now - hit.at < LABEL_MS) return hit.label
  const persona = personaOf(slug)
  const name = text(persona?.name)
  const label = name
    ? { name, title: text(persona?.title), oneLiner: text(persona?.oneLiner), photo: managerAvatar(slug)?.photo ?? null, statsLine: managerStats(slug)?.line ?? null }
    : null
  labels.set(key, { at: now, label })
  return label
}

/** The manager's folder changed: its next label is read from the disk. */
export function forgetManager(slug: string): void {
  labels.delete(join(managersDir(), slug))
}

export function currentManager(
  pin: string | null | undefined,
  sessionId: string | null | undefined,
): CurrentManager | null {
  const slug = pin || (sessionId ? sessionManager(sessionId) : null)
  if (!slug) return null
  const label = labelOf(slug)
  return label ? { slug, ...label } : null
}
