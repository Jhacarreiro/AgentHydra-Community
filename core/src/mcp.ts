// The core's six MCP tools (core/README.md, "Tasks"): a stdio server, run as `bun core/src/mcp.ts`, whose tools call the
// core's /api over HTTP. The JSON-RPC loop is the repo's shared engine (server/src/mcp-stdio.mjs), imported, not copied.
// Nothing here writes to stdout: that is the protocol channel.
import { runMcpStdio } from '../../server/src/mcp-stdio.mjs'

const BASE = (process.env.CORE_URL ?? 'http://127.0.0.1:7789/api').replace(/\/$/, '')

/** One request to the core. A non-2xx answer throws the core's own `error` text, which the engine returns as a tool error. */
async function core(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String(data.error)
        : `The core answered ${res.status}.`
    throw new Error(message)
  }
  return data
}

/** The task id from a tool's arguments, escaped for a path. */
function taskId(args: Record<string, unknown>): string {
  if (typeof args.id !== 'string' || !args.id) throw new Error('id must be a task id')
  return encodeURIComponent(args.id)
}

const idSchema = { type: 'string', description: 'The task id that run answered.' }

interface Tool {
  name: string
  description: string
  inputSchema: object
  run: (args: Record<string, unknown>) => Promise<unknown>
}

const tools: Tool[] = [
  {
    name: 'run',
    description:
      'Starts a task on the cheapest account with room that can do it, and answers its row (id, status) at once. Use it to hand off a prompt that runs in a folder: tools none for a plain answer, read, edit or all for file work.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the task should do.' },
        cwd: { type: 'string', description: 'An existing absolute folder the task runs in.' },
        tools: { type: 'string', enum: ['none', 'read', 'edit', 'all'] },
        title: { type: 'string', description: 'A short label for the task.' },
        kind: {
          type: 'string',
          description: 'What sort of task it is: code, review, docs and so on.',
        },
      },
      required: ['prompt', 'cwd', 'tools'],
    },
    run: (a) =>
      core('POST', '/tasks', {
        prompt: a.prompt,
        cwd: a.cwd,
        tools: a.tools,
        title: a.title,
        kind: a.kind,
      }),
  },
  {
    name: 'wait',
    description:
      'Waits for a task to settle, for up to the seconds given (1 to 50, default 45), and answers its row with the result or error. Use it after run instead of polling.',
    inputSchema: {
      type: 'object',
      properties: {
        id: idSchema,
        seconds: {
          type: 'number',
          minimum: 1,
          maximum: 50,
          description: 'How long to wait, 1 to 50.',
        },
      },
      required: ['id'],
    },
    run: (a) => {
      const seconds = a.seconds === undefined ? 45 : Number(a.seconds)
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 50)
        throw new Error('seconds must be 1 to 50')
      return core('GET', `/tasks/${taskId(a)}/wait?seconds=${seconds}`)
    },
  },
  {
    name: 'send',
    description:
      'Sends a follow-up message into a finished task, in the same thread on the same account, and answers its row once it is running again. Use it to continue or correct a task that is done or failed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: idSchema,
        text: { type: 'string', description: 'The follow-up message.' },
      },
      required: ['id', 'text'],
    },
    run: (a) => core('POST', `/tasks/${taskId(a)}/send`, { text: a.text }),
  },
  {
    name: 'cancel',
    description:
      'Cancels a queued or running task and answers its row. Use it when a task is no longer needed.',
    inputSchema: { type: 'object', properties: { id: idSchema }, required: ['id'] },
    run: (a) => core('POST', `/tasks/${taskId(a)}/cancel`),
  },
  {
    name: 'verdict',
    description:
      'Records whether a finished task passed, with an optional note. Use it on a task that is done or failed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: idSchema,
        pass: { type: 'boolean', description: 'True when the result is good enough.' },
        note: { type: 'string', description: 'Why it passed or failed, in a sentence.' },
      },
      required: ['id', 'pass'],
    },
    run: (a) => core('POST', `/tasks/${taskId(a)}/verdict`, { pass: a.pass, note: a.note }),
  },
  {
    name: 'usage',
    description:
      'Lists every account with its service, label and room left (percent of its tighter window). Use it to see which logins have room before you run a task.',
    inputSchema: { type: 'object', properties: {} },
    run: () => core('GET', '/usage'),
  },
]

await runMcpStdio({
  serverInfo: { name: 'agenthydra-core', version: '0.1.0' },
  tools,
})
