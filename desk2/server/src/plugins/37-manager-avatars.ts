// GET and PUT /api/managers/<slug>/avatar: a manager's photo, shown on its chats' rows. PUT takes the raw bytes of a
// PNG, JPG, WebP or GIF, checked against its declared type and its first bytes; the new photo replaces the old ones.
// GET /api/personas/<slug>/avatar: the photo of a Hydra Core persona who is no manager (a lead or a seat), read from
// wherever its portrait lives (engine/core-lead.ts personaPhoto); Desk never writes it.

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, Hono } from 'hono'
import type { ServerContext } from '../context'
import { personaPhoto } from '../engine/core-lead'
import { AVATAR_TYPES, type AvatarExt, forgetManager, type ManagerAvatar, managerAvatar, managerName, managersDir, MANAGER_SLUG } from '../engine/managers'
import { sniff } from '../media/cache'
import { renameOver, writeFlushed } from '../write-flushed'

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

const NOT_A_PHOTO = 'A manager photo must be a PNG, JPG, WebP or GIF.'
const TOO_BIG = 'That photo is over 2 MB.'

function refusedSlug(c: Context, slug: string): Response | null {
  if (!MANAGER_SLUG.test(slug)) return c.json({ error: `Not a manager: ${slug}` }, 400)
  if (!managerName(slug)) return c.json({ error: `Not a manager: ${slug}` }, 404)
  return null
}

function photoResponse(avatar: ManagerAvatar): Response {
  return new Response(Bun.file(avatar.path), {
    headers: {
      'content-type': avatar.contentType,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'cache-control': 'no-cache',
    },
  })
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  app.get('/api/managers/:slug/avatar', (c) => {
    const slug = c.req.param('slug')
    const refused = refusedSlug(c, slug)
    if (refused) return refused
    const avatar = managerAvatar(slug)
    if (!avatar) return c.json({ error: `${managerName(slug)} has no photo.` }, 404)
    return photoResponse(avatar)
  })

  app.get('/api/personas/:slug/avatar', (c) => {
    const slug = c.req.param('slug')
    if (!MANAGER_SLUG.test(slug)) return c.json({ error: `Not a persona: ${slug}` }, 400)
    const avatar = personaPhoto(slug)
    return avatar ? photoResponse(avatar) : c.json({ error: `No photo for ${slug}.` }, 404)
  })

  app.put('/api/managers/:slug/avatar', async (c) => {
    const slug = c.req.param('slug')
    const refused = refusedSlug(c, slug)
    if (refused) return refused
    const type = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const ext = (Object.keys(AVATAR_TYPES) as AvatarExt[]).find((e) => AVATAR_TYPES[e] === type)
    if (!ext) return c.json({ error: NOT_A_PHOTO }, 415)
    if (Number(c.req.header('content-length') ?? 0) > MAX_AVATAR_BYTES) return c.json({ error: TOO_BIG }, 413)
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (!bytes.length) return c.json({ error: 'That photo is empty.' }, 400)
    if (bytes.length > MAX_AVATAR_BYTES) return c.json({ error: TOO_BIG }, 413)
    if (sniff(bytes) !== ext) return c.json({ error: NOT_A_PHOTO }, 415)

    const dir = join(managersDir(), slug)
    const file = join(dir, `avatar.${ext}`)
    const tmp = join(dir, `avatar.${ext}.${process.pid}.${Date.now()}.tmp`)
    try {
      writeFlushed(tmp, bytes)
      renameOver(tmp, file)
    } catch (err) {
      rmSync(tmp, { force: true })
      return c.json({ error: `Could not save the photo: ${err instanceof Error ? err.message : String(err)}` }, 500)
    }
    // An old photo another program holds open (Windows) stays behind; the newest is the one shown, so the save stands.
    for (const other of Object.keys(AVATAR_TYPES)) {
      if (other === ext) continue
      try {
        rmSync(join(dir, `avatar.${other}`), { force: true })
      } catch {}
    }

    const photo = managerAvatar(slug)!.photo
    forgetManager(slug)
    ;(ctx.deps.managerChanged as ((slug: string) => void) | undefined)?.(slug)
    return c.json({ ok: true, photo })
  })
}
