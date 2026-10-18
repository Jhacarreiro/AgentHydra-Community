// The project group header's right-click menu: stats for a folder, the auto-categorize of a scratch folder's chats and
// their placements (projects/menu.ts). 20-engine.ts builds the ProjectMenu from the chat manager and puts it in
// ctx.deps.projectMenu; without it (a test server with no engine) these routes are not registered.

import type { Context } from 'hono'
import type { Hono } from 'hono'
import type { ServerContext } from '../context'
import { groupName, type ProjectMenu } from '../projects/menu'
import type { PlacementMove } from '@shared/protocol'

async function answer(c: Context, run: () => Promise<unknown> | unknown): Promise<Response> {
  try {
    return c.json((await run()) as object)
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400)
  }
}

/** The moves a placements request names: each a desk or outside chat id, and a group (1 to 60 characters) or null. */
function movesOf(body: unknown): PlacementMove[] {
  const list = (body as { moves?: unknown } | null)?.moves
  if (!Array.isArray(list)) throw new Error('moves must be a list')
  return list.map((m) => {
    const row = m as { kind?: unknown; id?: unknown; group?: unknown }
    if (row.kind !== 'desk' && row.kind !== 'outside') throw new Error('kind must be desk or outside')
    if (typeof row.id !== 'string' || !row.id) throw new Error('id must be a chat id')
    if (row.group === null) return { kind: row.kind, id: row.id, group: null }
    const group = groupName(row.group)
    if (!group) throw new Error('group must be 1 to 60 characters, or null to put the chat back in its folder')
    return { kind: row.kind, id: row.id, group }
  })
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const menu = ctx.deps.projectMenu as ProjectMenu | undefined
  if (!menu) return
  app.get('/api/projects/stats', (c) =>
    answer(c, () => {
      const folder = c.req.query('folder')?.trim()
      if (!folder) throw new Error('folder is required')
      return menu.stats(folder)
    }),
  )
  app.post('/api/projects/categorize', (c) =>
    answer(c, async () => {
      const body = (await c.req.json().catch(() => null)) as { folder?: unknown } | null
      if (typeof body?.folder !== 'string' || !body.folder.trim()) throw new Error('folder is required')
      const folder = body.folder.trim()
      return { folder, items: await menu.propose(folder) }
    }),
  )
  app.post('/api/projects/placements', (c) =>
    answer(c, async () => menu.place(movesOf(await c.req.json().catch(() => null)))),
  )
}
