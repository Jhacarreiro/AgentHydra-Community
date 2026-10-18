// The instance manager (shared/instance-manager.ts says what it is for). GET /api/instance-manager answers what its
// last look saw (?fresh=1 looks first); POST /api/instance-manager { enabled?, check? } turns it on or off (Settings'
// `instanceManager`, on by default) and/or looks now. It looks every INSTANCE_MANAGER_EVERY_MS, while off too (it then
// notices and says, and moves nothing), so a switch turned on finds its memory current. A look reads AgentHydra's
// apps and Desk's own list of outside sessions (instance-manager/io.ts), notices an app that went down with chats
// working in it, and takes each recovery one step (instance-manager/engine.ts). Its memory (what worked where, every
// recovery and where it stands) is <home>/instance-manager.json, so a restart neither forgets an app that went down
// nor moves a chat twice.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { INSTANCE_MANAGER_EVERY_MS, type InstanceManagerRequest } from '@shared/instance-manager'
import type { ExternalSession } from '@shared/protocol'
import type { ServerContext } from '../context'
import { AsyncFile } from '../async-file'
import { bridge } from '../bridge'
import { createInstanceManager, RECOVERIES_KEPT, type Saved } from '../instance-manager/engine'
import { daemonIO } from '../instance-manager/io'

/** The first look waits for the bridge's first read of AgentHydra. */
const FIRST_LOOK_MS = 30_000

/** <home>/instance-manager.json, or an empty memory when it is missing or damaged. An empty memory only means an app
 *  that went down while it was unreadable is not noticed: nothing is moved on a guess. */
function load(file: string): Saved {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>
    const memory = v.memory && typeof v.memory === 'object' && !Array.isArray(v.memory) ? v.memory : {}
    return { memory, recoveries: Array.isArray(v.recoveries) ? v.recoveries.slice(0, RECOVERIES_KEPT) : [] }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') console.error('[instance-manager] instance-manager.json did not load; starting with no memory:', err)
    return { memory: {}, recoveries: [] }
  }
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const file = join(ctx.home, 'instance-manager.json')
  const writer = new AsyncFile(file)
  const io = daemonIO({
    base: bridge().url,
    outside: async () => {
      try {
        const res = await app.request('/api/external/sessions')
        return res.ok ? ((await res.json()) as ExternalSession[]) : null
      } catch {
        return null
      }
    },
  })
  const manager = createInstanceManager(io, load(file))
  let nextCheckAt: number | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let looking: Promise<void> | null = null
  let stopping = false

  const enabled = (): boolean => ctx.settings().instanceManager && !stopping

  function schedule(now = Date.now()): void {
    clearTimeout(timer)
    timer = undefined
    nextCheckAt = null
    if (stopping) return
    nextCheckAt = now + INSTANCE_MANAGER_EVERY_MS
    timer = setTimeout(() => void look(), INSTANCE_MANAGER_EVERY_MS)
    // A look never keeps the process alive: Desk stopping stops it.
    ;(timer as { unref?: () => void }).unref?.()
  }

  /** One look; never two at once. */
  function look(): Promise<void> {
    looking ??= (async () => {
      try {
        await manager.look(enabled())
        writer.write(JSON.stringify(manager.saved()))
      } catch (err) {
        console.error('[instance-manager] look failed:', err)
      } finally {
        schedule()
      }
    })().finally(() => (looking = null))
    return looking
  }

  ctx.onStop(() => {
    stopping = true
    clearTimeout(timer)
    timer = undefined
    writer.flushSync()
  })

  nextCheckAt = Date.now() + FIRST_LOOK_MS
  timer = setTimeout(() => void look(), FIRST_LOOK_MS)
  ;(timer as { unref?: () => void }).unref?.()

  app.get('/api/instance-manager', async (c) => {
    if (c.req.query('fresh') === '1') await look()
    return c.json(manager.status(enabled(), nextCheckAt))
  })

  app.post('/api/instance-manager', async (c) => {
    const body = (await c.req.json().catch(() => null)) as InstanceManagerRequest | null
    if (!body || (body.enabled !== undefined && typeof body.enabled !== 'boolean') || (body.check !== undefined && typeof body.check !== 'boolean'))
      return c.json({ error: 'the body must be JSON: { "enabled"?: true | false, "check"?: true }' }, 400)
    if (body.enabled !== undefined && body.enabled !== ctx.settings().instanceManager) ctx.updateSettings({ instanceManager: body.enabled })
    if (body.check || body.enabled === true) await look()
    return c.json(manager.status(enabled(), nextCheckAt))
  })
}
