import {
  type ChatGptConversation,
  type ChatGptConversationSummary,
  CONVERSATION_ID,
  parseConversation,
  parseConversationList,
} from './chatgpt-conversation'

/** ChatGPT through the OpenCLI Browser Bridge on the Hub's host: its daemon drives a window of the operator's own
 * signed-in Chrome, and the Hub only ever sends it the fixed operations below. The page reads ChatGPT's own
 * endpoints with its own sign-in, so no token or cookie leaves the browser, and nothing read is stored here.
 * A message is sent only when a person asks for it from Desk (POST routes in routes/chatgpt-view.ts).
 */

export const BRIDGE_SESSION = 'hydra-chatgpt'
const ORIGIN = 'https://chatgpt.com'
export const MAX_SEND = 100_000

export class ChatGptBridgeError extends Error {
  constructor(
    readonly code:
      | 'CHATGPT_BRIDGE_UNAVAILABLE'
      | 'CHATGPT_SIGNED_OUT'
      | 'CHATGPT_NOT_FOUND'
      | 'CHATGPT_COMPOSER_UNAVAILABLE'
      | 'CHATGPT_NOT_OPEN',
    message: string,
  ) {
    super(message)
  }
}

type Reply = { ok?: boolean; data?: unknown; error?: unknown; page?: unknown }
export type BridgeFetch = (url: string, init: RequestInit) => Promise<Response>

export function bridgeBase(raw = process.env.AGENTHYDRA_CHATGPT_BRIDGE_URL): URL {
  const url = new URL(raw?.trim() || 'http://127.0.0.1:19825')
  if (
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search
  )
    throw new Error('AGENTHYDRA_CHATGPT_BRIDGE_URL must be a plain http://host:port')
  return url
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The page's half of every read: ChatGPT's own session gives the bearer, which stays in the page.
const readPage = (path: string, extra = '') => `(async () => {
  const s = await (await fetch(${JSON.stringify(`${ORIGIN}/api/auth/session`)}, { credentials: "include" })).json().catch(() => null)
  if (!s || !s.accessToken) return JSON.stringify({ signedOut: true })
  const r = await fetch(${JSON.stringify(ORIGIN + path)}, { headers: { authorization: "Bearer " + s.accessToken } })
  if (!r.ok) return JSON.stringify({ status: r.status })
  const body = await r.json()
  ${extra}
  return JSON.stringify({ body })
})()`

// ChatGPT keeps a previous page's composer in the document, hidden, so every lookup takes the one on screen.
const VISIBLE =
  'const shown = (sel) => [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null)'
// ChatGPT's stop button: by its test id where it has one, else by its label (English and Portuguese).
const STOP_SELECTOR = `${VISIBLE}; const STOP = 'form button[data-testid="stop-button"], form button[aria-label^="Stop"], form button[aria-label^="Parar"], form button[aria-label^="Interromper"]'`

// Only the current branch, and only the fields parseConversation reads, cross back to the Hub.
const trimConversation = `
  const keep = {}
  let k = body.current_node
  while (k && body.mapping[k] && !keep[k] && Object.keys(keep).length < 5000) {
    const n = body.mapping[k], m = n.message
    keep[k] = { parent: n.parent || null, message: m && {
      id: m.id, author: { role: m.author && m.author.role }, status: m.status, end_turn: m.end_turn,
      recipient: m.recipient, create_time: m.create_time,
      content: m.content && { content_type: m.content.content_type,
        parts: Array.isArray(m.content.parts) ? m.content.parts.filter(p => typeof p === "string") : undefined },
      metadata: { is_visually_hidden_from_conversation: !!(m.metadata && m.metadata.is_visually_hidden_from_conversation),
        finish_details: m.metadata && m.metadata.finish_details ? { type: m.metadata.finish_details.type } : undefined } } }
    k = n.parent
  }
  ${STOP_SELECTOR}
  const busy = location.pathname === "/c/" + body.conversation_id && !!shown(STOP)
  body.mapping = keep
  body.busy = busy`

const COMPOSER = 'form .ProseMirror[contenteditable="true"], form #prompt-textarea'
const focusComposer = `(() => { ${VISIBLE}; const e = shown(${JSON.stringify(COMPOSER)}); if (!e) return "none"; e.focus(); document.execCommand("selectAll"); document.execCommand("delete"); return document.activeElement === e ? "ready" : "none" })()`
const composerLength = `(() => { ${VISIBLE}; const e = shown(${JSON.stringify(COMPOSER)}); return e ? e.innerText.trim().length : -1 })()`
const clickSend = `(() => { ${VISIBLE}; const b = shown('form button[data-testid="send-button"], form button[type="submit"]'); if (!b || b.disabled) return false; b.click(); return true })()`
const clickStop = `(() => { ${STOP_SELECTOR}; const b = shown(STOP); if (!b) return false; b.click(); return true })()`
const pathname = '(() => location.pathname)()'

export function createChatGptBridge(fetcher: BridgeFetch = fetch, base = () => bridgeBase()) {
  let queue: Promise<unknown> = Promise.resolve()
  /** One operation at a time: they share the one window. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }
  let seq = 0

  async function command(
    action: string,
    fields: Record<string, unknown>,
    timeout = 30,
  ): Promise<Reply> {
    let response: Response
    try {
      response = await fetcher(new URL('/command', base()).toString(), {
        method: 'POST',
        // The daemon refuses a request with an Origin (a web page); x-opencli marks a client of its own.
        headers: { 'content-type': 'application/json', 'x-opencli': '1' },
        body: JSON.stringify({
          id: `hydra-${Date.now().toString(36)}-${++seq}`,
          action,
          session: BRIDGE_SESSION,
          surface: 'browser',
          timeout,
          ...fields,
        }),
        signal: AbortSignal.timeout((timeout + 10) * 1000),
      })
    } catch {
      throw new ChatGptBridgeError(
        'CHATGPT_BRIDGE_UNAVAILABLE',
        'The browser bridge is not reachable',
      )
    }
    const reply = (await response.json().catch(() => null)) as Reply | null
    if (!response.ok || !reply || reply.ok !== true)
      throw new ChatGptBridgeError(
        'CHATGPT_BRIDGE_UNAVAILABLE',
        'The browser bridge refused the command',
      )
    return reply
  }

  async function page(): Promise<string> {
    const tabs = (await command('tabs', { op: 'list' })).data
    const list = Array.isArray(tabs) ? tabs : []
    const open = list.filter(
      (t) =>
        t &&
        typeof t.page === 'string' &&
        typeof t.url === 'string' &&
        t.url.startsWith(`${ORIGIN}/`),
    )
    const tab = open.find((t) => t.active) ?? open[0]
    if (tab) return tab.page
    const opened = await command('navigate', { url: `${ORIGIN}/` })
    if (typeof opened.page !== 'string')
      throw new ChatGptBridgeError('CHATGPT_BRIDGE_UNAVAILABLE', 'No ChatGPT window')
    return opened.page
  }

  const run = async (target: string, code: string, timeout = 30) =>
    (await command('exec', { page: target, code }, timeout)).data

  async function read(target: string, code: string): Promise<unknown> {
    const raw = await run(target, code)
    const result = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null
    if (!result)
      throw new ChatGptBridgeError('CHATGPT_BRIDGE_UNAVAILABLE', 'Unreadable answer from the page')
    if (result.signedOut)
      throw new ChatGptBridgeError(
        'CHATGPT_SIGNED_OUT',
        'ChatGPT is signed out in the bridge window',
      )
    if (result.status === 404)
      throw new ChatGptBridgeError('CHATGPT_NOT_FOUND', 'No such conversation')
    if (!('body' in result))
      throw new ChatGptBridgeError('CHATGPT_BRIDGE_UNAVAILABLE', 'ChatGPT refused the read')
    return result.body
  }

  async function until<T>(probe: () => Promise<T | null>, ms: number): Promise<T | null> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const value = await probe().catch(() => null)
      if (value !== null) return value
      await sleep(400)
    }
    return null
  }

  /** Puts the window on that conversation (or a new one) unless it is there already. */
  async function openIn(target: string, id: string | null): Promise<void> {
    const want = id ? `/c/${id}` : '/'
    if (id && (await run(target, pathname)) === want) return
    await command('navigate', { page: target, url: ORIGIN + want })
  }

  return {
    list: (limit = 50, offset = 0): Promise<ChatGptConversationSummary[]> =>
      serial(async () => {
        const n = Math.min(Math.max(Math.trunc(limit), 1), 100)
        const from = Math.max(Math.trunc(offset), 0)
        return parseConversationList(
          await read(
            await page(),
            readPage(`/backend-api/conversations?offset=${from}&limit=${n}&order=updated`),
          ),
        )
      }),

    read: (id: string): Promise<ChatGptConversation & { busy: boolean }> =>
      serial(async () => {
        if (!CONVERSATION_ID.test(id))
          throw new ChatGptBridgeError('CHATGPT_NOT_FOUND', 'No such conversation')
        const body = (await read(
          await page(),
          readPage(`/backend-api/conversation/${id}`, trimConversation),
        )) as Record<string, unknown>
        const conversation = parseConversation(body)
        const busy = body.busy === true
        return {
          ...conversation,
          busy,
          // ChatGPT's own Stop button on screen outranks what the saved conversation says.
          state:
            busy && conversation.state !== 'thinking' && conversation.state !== 'generating'
              ? 'generating'
              : conversation.state,
        }
      }),

    /** Types the message into ChatGPT's own composer and presses its send button, once. */
    send: (id: string | null, text: string): Promise<{ id: string | null }> =>
      serial(async () => {
        if (id !== null && !CONVERSATION_ID.test(id))
          throw new ChatGptBridgeError('CHATGPT_NOT_FOUND', 'No such conversation')
        const target = await page()
        await openIn(target, id)
        const ready = await until(
          async () => ((await run(target, focusComposer)) === 'ready' ? true : null),
          20_000,
        )
        if (!ready)
          throw new ChatGptBridgeError(
            'CHATGPT_COMPOSER_UNAVAILABLE',
            'ChatGPT has no composer to type in',
          )
        await command('insert-text', { page: target, text })
        const typed = await until(
          async () => (((await run(target, composerLength)) as number) > 0 ? true : null),
          5_000,
        )
        const sent =
          typed &&
          (await until(async () => ((await run(target, clickSend)) === true ? true : null), 10_000))
        if (!sent)
          throw new ChatGptBridgeError(
            'CHATGPT_COMPOSER_UNAVAILABLE',
            'ChatGPT did not take the message',
          )
        if (id) return { id }
        // A new conversation gets its id from ChatGPT once the first message is in.
        const made = await until(async () => {
          const path = await run(target, pathname)
          const found =
            typeof path === 'string' ? /^\/c\/([0-9a-f-]{36})$/i.exec(path)?.[1] : undefined
          return found && CONVERSATION_ID.test(found) ? found : null
        }, 30_000)
        return { id: made }
      }),

    stop: (id: string): Promise<boolean> =>
      serial(async () => {
        if (!CONVERSATION_ID.test(id))
          throw new ChatGptBridgeError('CHATGPT_NOT_FOUND', 'No such conversation')
        const target = await page()
        if ((await run(target, pathname)) !== `/c/${id}`)
          throw new ChatGptBridgeError(
            'CHATGPT_NOT_OPEN',
            'That conversation is not the one open in the bridge window',
          )
        return (await run(target, clickStop)) === true
      }),
  }
}

export type ChatGptBridge = ReturnType<typeof createChatGptBridge>
