// The new core (core/, core/README.md) behind Desk's window. With Settings > New core on (DeskSettings.coreEngine), a
// new chat, made or imported, is the core's. Every route of a core chat goes on to the core, as does /api/tasks; the
// core's chat and item events reach every window; its chats join the chat list and each hello; and their sessions are
// left out of the outside list. Chats made before stay on Desk's own engine, and with the setting off new chats start
// there again (owner, 2026-10-14: "switch it over behind the toggle with the old engine kept for rollback").
// Before 20-engine, so these run ahead of the engine's own chat routes. The core is started on demand, hidden and
// outside Desk's tree (host/launch.ts startDetached), and never stopped from here.

import { resolve } from 'node:path'
import type { Context, Hono, Next } from 'hono'
import type { ChatSummary, ServerEvent } from '@shared/protocol'
import { bridge } from '../bridge'
import type { ServerContext } from '../context'
import { startDetached } from '../host/launch'

const MAIN = resolve(import.meta.dir, '../../../../core/src/main.ts')
/** What the core says about its own chats; nothing else it sends is the window's. */
const RELAYED = new Set<string>(['chat.upsert', 'chat.removed', 'item.upsert', 'item.removed'])
const NOT_PASSED_ON = ['origin', 'referer', 'cookie', 'host', 'connection', 'accept-encoding', 'content-length']
/** How long a first request waits for a core it had to start. */
const UP_WAIT_MS = 20_000
const NOT_YET = 'This chat runs on the new core, which does not do that yet.'

export default function plugin(app: Hono, ctx: ServerContext): void {
  const core = (ctx.deps.coreUrl as string | undefined) ?? `http://127.0.0.1:${process.env.CORE_PORT ?? 7789}`
  const launch =
    (ctx.deps.launchCore as (() => void) | undefined) ??
    (() => startDetached([process.execPath, MAIN], (why) => console.warn(`[core] the new core did not start: ${why}`)))
  const chats = new Map<string, ChatSummary>()
  const on = (): boolean => ctx.settings().coreEngine === true

  const up = async (): Promise<boolean> => {
    try {
      const res = await fetch(`${core}/api/health`, { signal: AbortSignal.timeout(2000) })
      return res.ok && ((await res.json()) as { name?: string }).name === 'agenthydra-core'
    } catch {
      return false
    }
  }
  let starting: Promise<boolean> | null = null
  /** True once the core answers, started first when it does not. */
  const ensure = (): Promise<boolean> => {
    starting ??= (async () => {
      if (await up()) return true
      launch()
      for (const until = Date.now() + UP_WAIT_MS; Date.now() < until; ) {
        await Bun.sleep(500)
        if (await up()) return true
      }
      return false
    })().finally(() => {
      starting = null
    })
    return starting
  }

  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch(`${core}/api/chats`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return
      chats.clear()
      for (const c of (await res.json()) as ChatSummary[]) chats.set(c.id, c)
    } catch {
      // floor-ok: a core that is not up has no chats to list; the socket's next open reads them
    }
  }

  // The core's events, relayed: a socket that drops is opened again, waiting longer each time up to a minute.
  let socket: WebSocket | null = null
  let stopped = false
  let wait = 1000
  const connect = (): void => {
    if (stopped) return
    const ws = new WebSocket(`${core.replace(/^http/, 'ws')}/ws`)
    socket = ws
    ws.onopen = () => {
      wait = 1000
      void refresh()
    }
    ws.onmessage = (m) => {
      let e: ServerEvent
      try {
        e = JSON.parse(String(m.data)) as ServerEvent
      } catch {
        return
      }
      if (!RELAYED.has(e.type)) return
      if (e.type === 'chat.upsert') chats.set(e.chat.id, e.chat)
      if (e.type === 'chat.removed') chats.delete(e.chatId)
      ctx.broadcast(e)
    }
    ws.onerror = () => {}
    ws.onclose = () => {
      if (socket === ws) socket = null
      if (stopped) return
      const t = setTimeout(connect, wait)
      ;(t as { unref?: () => void }).unref?.()
      wait = Math.min(wait * 2, 60_000)
    }
  }
  connect()
  if (on()) void ensure()
  ctx.onStop(() => {
    stopped = true
    socket?.close()
  })

  const coreChats = (): ChatSummary[] => [...chats.values()]
  ctx.extendHello((h) => (h.chats ? { ...h, chats: [...h.chats.filter((c) => !chats.has(c.id)), ...coreChats()] } : h))
  bridge().addExcludedSessionIds(() =>
    coreChats().flatMap((c) => [c.sessionId, c.serviceThreads?.codex?.threadId].filter((id): id is string => !!id)),
  )

  const forward = async (c: Context): Promise<Response> => {
    const away = c.json({ error: `The new core is not answering at ${core}` }, 503)
    if (!(await ensure())) return away
    const url = new URL(c.req.url)
    const headers = new Headers(c.req.raw.headers)
    for (const h of NOT_PASSED_ON) headers.delete(h)
    const withBody = c.req.method !== 'GET' && c.req.method !== 'HEAD'
    let res: Response
    try {
      res = await fetch(`${core}${url.pathname}${url.search}`, {
        method: c.req.method,
        headers,
        body: withBody ? await c.req.arrayBuffer() : undefined,
        signal: c.req.raw.signal,
      })
    } catch {
      return away
    }
    // fetch has already undone any compression, so the length and encoding it was sent with no longer hold.
    const out = new Headers(res.headers)
    out.delete('content-encoding')
    out.delete('content-length')
    if (res.status !== 404) return new Response(res.body, { status: res.status, headers: out })
    const text = await res.text()
    // The core's answer for a route it does not have; a 404 for a chat it does not know stays its own.
    return text.includes('"not found"') ? c.json({ error: NOT_YET }, 501) : new Response(text, { status: 404, headers: out })
  }

  /** The chat a made or imported core chat's answer holds, kept so its routes come here from now on. */
  const adopt = async (res: Response): Promise<Response> => {
    if (!res.ok) return res
    const text = await res.text()
    try {
      const chat = JSON.parse(text) as ChatSummary
      if (chat?.id) chats.set(chat.id, chat)
    } catch {
      // floor-ok: an answer that is not a chat is passed on as it came
    }
    return new Response(text, { status: res.status, headers: res.headers })
  }

  app.use('/api/chats', async (c, next) => {
    if (c.req.method === 'POST' && on()) return adopt(await forward(c))
    await next()
    const archived = c.req.query('archived')
    if (c.req.method !== 'GET' || !chats.size || archived === '1' || archived === 'true' || !c.res.ok) return
    const list = (await c.res.json()) as ChatSummary[]
    c.res = Response.json([...list.filter((x) => !chats.has(x.id)), ...coreChats()])
  })
  app.use('/api/chats/import', async (c, next) => (c.req.method === 'POST' && on() ? adopt(await forward(c)) : next()))
  const owned = async (c: Context, next: Next): Promise<Response | void> => {
    const id = c.req.param('id')
    if (!id || !chats.has(id)) return next()
    // The core has no slash commands: an empty menu, not an error, while typing in a core chat.
    if (c.req.method === 'GET' && new URL(c.req.url).pathname.endsWith('/commands')) return c.json([])
    return forward(c)
  }
  app.use('/api/chats/:id', owned)
  app.use('/api/chats/:id/*', owned)
  app.all('/api/tasks', (c) => forward(c))
  app.all('/api/tasks/*', (c) => forward(c))
}
