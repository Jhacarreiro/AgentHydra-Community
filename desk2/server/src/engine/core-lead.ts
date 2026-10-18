// The persona a chat's row shows (its manager face, sidebar/manager-face.ts), Hydra Core's included (A2-F7, A4-F7):
// a pinned manager first; else, for a seat, the persona its Prime's seats.json opened it for (whatever lead the hook
// later moved it to); else the chat's Hydra Core lead, a hydra.md `## Lead` line (the chat became someone) before
// the lead its placement.json keeps; else the manager the old router's session file names. Everything is read from <core dir>/chats/<Desk chat id>/, the key the
// hook and the launches use. A persona who is a manager shows as that manager; any other gets its catalog name and
// the photo found for it (personaPhoto), or none, when its row draws the initial.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ChatSummary } from '@shared/protocol'
import { type CatalogEntry, loadCatalog } from '../../../../server/src/hydra-core/catalog'
import { leadName, parseHydra } from '../../../../server/src/hydra-core/hydra-md'
import { coreDir } from './hydra-core-mode'
import { AVATAR_TYPES, type AvatarExt, currentManager, type ManagerAvatar, MANAGER_SLUG, managerAvatar, managerName } from './managers'

export type ChatFace = NonNullable<ChatSummary['manager']>

/** How long a read is reused: a lead picked mid-turn shows by the turn's end, when the row is sent again. */
const READ_MS = 5000
const cache = new Map<string, { at: number; value: unknown }>()

function cached<T>(key: string, read: () => T): T {
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < READ_MS) return hit.value as T
  const value = read()
  cache.set(key, { at: now, value })
  return value
}

/** Drops every cached read: the next face is read from the disk. */
export function forgetCoreFaces(): void {
  cache.clear()
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function readJson(path: string): unknown {
  const text = readText(path)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function people(): Map<string, CatalogEntry> {
  const dir = coreDir()
  return cached(`catalog:${dir}`, () => {
    const out = new Map<string, CatalogEntry>()
    for (const e of loadCatalog(dir).entries.values()) if (e.kind === 'person') out.set(e.id, e)
    return out
  })
}

/** The chat's lead: its catalog id, or `lead:<name>` for a hydra.md lead the catalog does not hold; null for none. */
function leadOf(chat: string): string | null {
  const dir = coreDir()
  return cached(`lead:${dir}:${chat}`, () => {
    const root = join(dir, 'chats', chat)
    const md = readText(join(root, 'hydra.md'))
    const doc = md === null ? null : parseHydra(md)
    if (doc?.lead) {
      // As pack.ts finds a hydra.md lead's entry: by the file its line names, else by its name.
      const name = leadName(doc)
      const path = /Full text: (.+)$/.exec(doc.lead)?.[1]?.trim() ?? ''
      const all = [...people().values()]
      const e = all.find((p) => p.load.type === 'file' && p.load.path === path) ?? all.find((p) => p.name === name)
      return e ? e.id : `lead:${name}`
    }
    const placed = readJson(join(root, 'placement.json')) as { lead?: unknown } | null
    return typeof placed?.lead === 'string' && placed.lead ? placed.lead : null
  })
}

/** Every seat chat Hydra Core opened, by its Desk chat id: the persona it sits as. */
function seatPersonas(): Map<string, string> {
  const dir = coreDir()
  return cached(`seats:${dir}`, () => {
    const out = new Map<string, string>()
    let chats: string[] = []
    try {
      chats = readdirSync(join(dir, 'chats'))
    } catch {
      return out
    }
    for (const chat of chats) {
      const seats = readJson(join(dir, 'chats', chat, 'seats.json'))
      if (!seats || typeof seats !== 'object') continue
      for (const [id, seat] of Object.entries(seats as Record<string, unknown>)) {
        const at = (seat as { chat?: unknown } | null)?.chat
        if (typeof at === 'string') out.set(at, id)
      }
    }
    return out
  })
}

function slugOf(id: string): string {
  const raw = id.startsWith('person:') ? id.slice('person:'.length) : id.replace(/^lead:/, '')
  const slug = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return MANAGER_SLUG.test(slug) ? slug : 'lead'
}

function newestAvatar(dir: string, name: string): ManagerAvatar | null {
  let newest: ManagerAvatar | null = null
  for (const ext of Object.keys(AVATAR_TYPES) as AvatarExt[]) {
    const path = join(dir, `${name}.${ext}`)
    const st = statSync(path, { throwIfNoEntry: false })
    if (!st?.isFile()) continue
    const photo = Math.floor(st.mtimeMs)
    if (!newest || photo > newest.photo) newest = { path, ext, contentType: AVATAR_TYPES[ext], photo }
  }
  return newest
}

/** The portraits folders: AGENTHYDRA_PORTRAITS_DIRS, then each `portraits` folder beside a folder that holds a persona's file. */
function portraitDirs(): string[] {
  const dir = coreDir()
  return cached(`portraits:${dir}:${process.env.AGENTHYDRA_PORTRAITS_DIRS ?? ''}`, () => {
    const set = (process.env.AGENTHYDRA_PORTRAITS_DIRS ?? '').split(/[;\n]/).map((d) => d.trim()).filter(Boolean)
    for (const e of people().values()) if (e.load.type === 'file') set.push(join(dirname(dirname(e.load.path)), 'portraits'))
    return [...new Set(set)].filter((d) => statSync(d, { throwIfNoEntry: false })?.isDirectory())
  })
}

/**
 * A persona's photo: its manager folder's avatar; else an avatar.* or portrait.* beside its persona file; else, in a
 * portraits folder, the file named for it (`<slug>.*`, or `mind-<slug>.*` as a Minds seat's is). Null when none exists.
 */
export function personaPhoto(slug: string): ManagerAvatar | null {
  if (!MANAGER_SLUG.test(slug)) return null
  const own = managerAvatar(slug)
  if (own) return own
  const e = people().get(`person:${slug}`)
  if (e?.load.type === 'file') {
    const beside = dirname(e.load.path)
    const found = newestAvatar(beside, 'avatar') ?? newestAvatar(beside, 'portrait')
    if (found) return found
  }
  for (const dir of portraitDirs()) {
    const found = newestAvatar(dir, slug) ?? newestAvatar(dir, `mind-${slug}`) ?? (e?.load.type === 'file' ? newestAvatar(dir, basename(dirname(e.load.path))) : null)
    if (found) return found
  }
  return null
}

/** The face of a catalog persona (or a `lead:<name>`), drawn as `role`. */
function personaFace(id: string, role: 'lead' | 'seat'): ChatFace {
  const slug = slugOf(id)
  if (id.startsWith('person:') && managerName(slug)) {
    const m = currentManager(slug, null)
    if (m) return { ...m, role }
  }
  const e = people().get(id)
  const name = e?.name ?? (id.startsWith('lead:') ? id.slice('lead:'.length) : slug)
  return { slug, name, title: e?.title ?? null, oneLiner: e?.when ?? null, photo: personaPhoto(slug)?.photo ?? null, role, persona: true }
}

/** The face a chat's row shows, or null for none (see the top of this file). */
export function chatFace(chat: Pick<ChatSummary, 'id'> & Partial<Pick<ChatSummary, 'managerSlug' | 'sessionId' | 'parentId'>>): ChatFace | null {
  const pinned = chat.managerSlug ? currentManager(chat.managerSlug, null) : null
  if (pinned) return pinned
  if (KEY.test(chat.id)) {
    // A seat is its persona for good: a lead the hook moved it to (hydra.md, placement.json) never shows in its place (C4-F7).
    const seat = chat.parentId ? seatPersonas().get(chat.id) : undefined
    if (seat) return personaFace(seat, 'seat')
    const lead = leadOf(chat.id)
    if (lead) return personaFace(lead, 'lead')
  }
  return chat.sessionId ? currentManager(null, chat.sessionId) : null
}
