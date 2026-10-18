import { callerAndChat } from './hydra-core/caller'
import { loadCatalog } from './hydra-core/catalog'
import { movers, readFeedback } from './hydra-core/feedback'
import { statsOf } from './hydra-core/log'
import { coreDir } from './hydra-core/paths'
import { OUTCOMES, reportRun } from './hydra-core/report-row'
import { trackSummary } from './hydra-core/track'
import { answer, findTool, scope } from './hydra-core/tree'
import { defaultDaemon, use } from './hydra-core/use'
import { api, type HydraTool, S, str } from './mcp-client'

/** The chat a call names, or the Desk chat this server runs in. */
const rawChat = (a: Record<string, unknown>): string =>
  str(a.chat).trim() || process.env.HYDRA_DESK_CHAT_ID?.trim() || ''

function chatOf(a: Record<string, unknown>): string {
  const chat = rawChat(a)
  if (!chat) throw new Error('no chat: pass chat, or run inside a Desk chat (HYDRA_DESK_CHAT_ID)')
  return chat
}

const stringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : undefined

const MODES = ['become', 'consult', 'hire', 'load']

export const CORE_TOOLS: HydraTool[] = [
  {
    name: 'core_scope',
    listed: true,
    description:
      'MUTATES: start a scope run for this chat. Returns the first question (q1) and the folder knowledge. On a first message, q1 also asks difficulty 1-5 (`no 1` = go with nothing loaded; 2 or more goes straight to the lead).',
    inputSchema: S({ chat: { type: 'string' } }),
    run: async (a: Record<string, unknown>) => scope(coreDir(), chatOf(a)),
  },
  {
    name: 'core_answer',
    listed: true,
    description:
      'MUTATES: answer the current scope question. Pass the answer text and picks (numbers or ids). Returns the next question or the verdict.',
    inputSchema: S(
      {
        chat: { type: 'string' },
        answer: { type: 'string' },
        picks: { type: 'array', items: { type: 'string' } },
      },
      ['answer'],
    ),
    run: async (a: Record<string, unknown>) =>
      answer(coreDir(), chatOf(a), { answer: str(a.answer), picks: stringList(a.picks) }),
  },
  {
    name: 'core_find',
    listed: true,
    description:
      'Find catalog entries (people, tools, workers, knowledge, skills) for a need. Five per page; more=true for the next page. Person matches show tier and family.',
    inputSchema: S(
      {
        need: { type: 'string' },
        kind: { type: 'string', enum: ['person', 'instrument', 'worker', 'knowledge', 'skill'] },
        more: { type: 'boolean' },
        chat: { type: 'string' },
      },
      ['need'],
    ),
    run: async (a: Record<string, unknown>) =>
      findTool(coreDir(), {
        need: str(a.need),
        kind: str(a.kind).trim() || undefined,
        more: a.more === true,
        chat: str(a.chat).trim() || undefined,
      }),
  },
  {
    name: 'core_use',
    listed: true,
    description:
      'MUTATES: use a catalog entry: become (take the lead), consult (ask it a question), hire (give it a job), or load (read its text). From a Desk chat, consult and hire open one seat per persona in this chat (a sub-chat, reused), only for the calling chat: consult answers within 30 seconds, or says it is working; call consult again with no question to read the latest answer (it never starts a new one). From a chat with no Desk row, consult runs one worker per question and the same no-question call reads it back. Hire returns the seat at once. A seat or a worker started for one job is refused.',
    inputSchema: S(
      {
        chat: { type: 'string' },
        id: { type: 'string' },
        mode: { type: 'string', enum: MODES },
        question: { type: 'string' },
        job: { type: 'string' },
        cwd: {
          type: 'string',
          description: "The folder a new seat or consult works in. Default: this chat's folder.",
        },
      },
      ['id', 'mode'],
    ),
    run: async (a: Record<string, unknown>) => {
      const mode = str(a.mode)
      // Consult and hire: the caller's role, and its own chat as the key (a Prime opens seats only for itself).
      const bound =
        mode === 'consult' || mode === 'hire' ? await callerAndChat(a, rawChat(a)) : null
      return use(
        coreDir(),
        {
          chat: bound ? bound.chat.key : chatOf(a),
          id: str(a.id).trim(),
          mode: mode as 'become' | 'consult' | 'hire' | 'load',
          question: str(a.question).trim() || undefined,
          job: str(a.job).trim() || undefined,
          cwd: str(a.cwd).trim() || undefined,
          ...(bound
            ? {
                caller: bound.caller.role,
                who: bound.caller,
                desk: bound.chat.desk,
                aliases: bound.chat.aliases,
                why: bound.caller.why ?? undefined,
              }
            : {}),
        },
        defaultDaemon(api),
      )
    },
  },
  {
    name: 'core_report',
    listed: true,
    description:
      'MUTATES: report how the run went (done, partial or failed), with a note and any entries that were overruled. Optional score (1-5) rates the help and missing names what was lacking.',
    inputSchema: S(
      {
        chat: { type: 'string' },
        outcome: { type: 'string', enum: [...OUTCOMES] },
        note: { type: 'string' },
        overruled: { type: 'array', items: { type: 'string' } },
        score: { type: 'integer', minimum: 1, maximum: 5 },
        missing: { type: 'string' },
      },
      ['outcome', 'note'],
    ),
    run: async (a: Record<string, unknown>) =>
      reportRun(coreDir(), {
        chat: chatOf(a),
        outcome: str(a.outcome),
        note: str(a.note),
        overruled: stringList(a.overruled),
        score: typeof a.score === 'number' ? a.score : undefined,
        missing: typeof a.missing === 'string' ? a.missing : undefined,
      }),
  },
  {
    name: 'core_track',
    listed: false,
    description:
      'Hydra Core usage ledger summary: compliance, picks, reports, scores and handoffs. Rebuilt when older than 10 minutes.',
    inputSchema: S({}),
    run: async () => trackSummary(coreDir()),
  },
  {
    name: 'core_stats',
    listed: false,
    description:
      'Hydra Core log stats over the last `days` (default 31): misses per entry (and the `none` rejections), overruled counts, reports and the report rate, per-question asked and defaulted counts, pushback by chat, finds, and `learned`: the entries the last feedback fold moves most, up and down.',
    inputSchema: S({ days: { type: 'integer', minimum: 1 } }),
    run: async (a: Record<string, unknown>) => {
      const days = typeof a.days === 'number' && a.days >= 1 ? a.days : 31
      const dir = coreDir()
      return {
        ...statsOf(dir, new Date(Date.now() - days * 24 * 60 * 60 * 1000)),
        learned: movers(readFeedback(dir), loadCatalog(dir).entries),
      }
    },
  },
]
