// What a routine's run did, in plain words (owner, 2026-10-13: "every time they finish, to have a, like, AI description of
// what they did. Especially for things like the Archangel, where each of its runs are a unique variant"). A routine whose
// file says `describe: true` has each run that printed something read by one Haiku 5.5 turn, no tools, on a signed-in
// account with room (the orchestrator judge's rule, plugins/70-orchestrator.ts), and the answer is kept with the run.
// Haiku: a two-sentence summary of a run's output is the narrow work it is built for, and the owner's pin is Haiku 5.5
// (2026-10-07: never Haiku 4.5). Nothing here reads a routine's file or memory: plugins/73-routines.ts hands it the output.

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AccountInfo } from '@shared/protocol'
import type { RoutineOutcome } from '@shared/routines'
import { DEFAULT_ACCOUNT } from '../bridge/accounts'
import { pickHealthy } from '../engine/chat-manager'
import { pinHaikuModel } from '../engine/haiku-pin'
import { sdkQuery } from '../host/sdk'

/** Haiku 5.5 by id, never the `haiku` alias (engine/chat-title.ts says why). */
export const DESCRIBE_MODEL = 'claude-haiku-5-5'
/** The newest output a description reads: a run's end says what it did. */
export const DESCRIBE_INPUT_CHARS = 12_000
/** A description is kept to this. */
export const DESCRIBE_MAX_CHARS = 600
const DESCRIBE_TIMEOUT_MS = 90_000
const ACCOUNT_TRIES = 3
const LOGIN_REFUSED = /authenticat|oauth|log ?in|sign(?:ed)? ?in|credential/i

/** One run to describe. */
export interface DescribeRequest {
  /** The routine's name. */
  name: string
  /** A command's output, or a prompt run's last answer. */
  what: 'command' | 'prompt'
  outcome: RoutineOutcome
  exitCode: number | null
  minutes: number
  output: string
}

/** Writes a run's description; throws with why there is none. */
export type Describer = (req: DescribeRequest) => Promise<string>

const INSTRUCTIONS =
  "You describe what one run of a scheduled job did, for its owner, who reads it in a list of runs. Write two or three short plain sentences: what it found, changed, fixed, sent or skipped, with the names and numbers the output gives. Say 'nothing' plainly when it did nothing, and why. No preamble, no heading, no markdown, no advice, nothing the output does not say."

/** The question one description asks: the run's facts, then its output's end. */
export function describePrompt(req: DescribeRequest): string {
  const output = req.output.length > DESCRIBE_INPUT_CHARS ? `...${req.output.slice(-DESCRIBE_INPUT_CHARS)}` : req.output
  const source = req.what === 'prompt' ? "The AI chat's final answer" : 'Its output (the end of it)'
  const exit = req.exitCode === null ? '' : `, exit ${req.exitCode}`
  return `The routine "${req.name}" ran for ${req.minutes} min and ended ${req.outcome}${exit}.\n\n${source}:\n${output}`
}

/** The model's answer as a description: one paragraph, no markdown marks, at most DESCRIBE_MAX_CHARS; null when empty. */
export function cleanDescription(raw: string): string | null {
  const text = raw
    .replace(/[*#`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(description|summary)\s*:\s*/i, '')
  if (!text) return null
  return text.length > DESCRIBE_MAX_CHARS ? `${text.slice(0, DESCRIBE_MAX_CHARS - 1).trimEnd()}…` : text
}

/** One Haiku turn on the account in `configDir` (null: the default ~/.claude login). Throws with why it gave no answer. */
async function askOnce(prompt: string, cwd: string, configDir: string | null, binary: string | null): Promise<string> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), DESCRIBE_TIMEOUT_MS)
  const env: Record<string, string | undefined> = { ...process.env }
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  else delete env.CLAUDE_CONFIG_DIR
  const options: Options = {
    model: DESCRIBE_MODEL,
    effort: 'low',
    systemPrompt: INSTRUCTIONS,
    cwd,
    env: pinHaikuModel(env),
    tools: [],
    allowedTools: [],
    canUseTool: async () => ({ behavior: 'deny', message: 'A run description uses no tools.' }),
    mcpServers: {},
    settingSources: [],
    maxTurns: 1,
    permissionMode: 'default',
    persistSession: false,
    abortController: abort,
    ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
  }
  let text: string | null = null
  let error = 'the model gave no answer'
  try {
    for await (const m of sdkQuery({ prompt, options }) as AsyncIterable<SDKMessage>) {
      if (m.type !== 'result') continue
      // A signed-out account answers 'success' with is_error and the error as its result: no description.
      if (m.subtype === 'success' && !m.is_error) text = m.result
      else error = m.subtype === 'success' ? String(m.result ?? '').slice(0, 200) || 'the model answered with an error' : m.subtype
    }
  } catch (err) {
    error = abort.signal.aborted ? `no answer within ${DESCRIBE_TIMEOUT_MS / 1000} s` : err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timer)
  }
  const clean = text === null ? null : cleanDescription(text)
  if (clean === null) throw new Error(text === null ? error : 'the answer was empty')
  return clean
}

/**
 * The real describer: an account nobody is using first, the least used first, then a busy one, and the next when a login is
 * refused; the default login last (its token expires). With accounts listed and none with room, no description is asked.
 */
export function sdkDescriber(cwd: string, accounts: () => Promise<AccountInfo[]>, binary: () => string | null = () => null): Describer {
  return async (req) => {
    const prompt = describePrompt(req)
    const listed = await accounts().catch(() => [] as AccountInfo[])
    const managed = listed.filter((a) => a.id !== DEFAULT_ACCOUNT.id)
    const idle = managed.filter((a) => !a.inUse)
    const tried: string[] = []
    let last = 'no account was tried'
    for (let n = 0; n < ACCOUNT_TRIES; n++) {
      const account = pickHealthy(idle, tried) ?? pickHealthy(listed, tried)
      if (!account && managed.length) throw new Error(tried.length ? last : 'no account has room to describe it')
      if (account) tried.push(account.id)
      try {
        return await askOnce(prompt, cwd, account?.configDir ?? null, binary())
      } catch (err) {
        last = err instanceof Error ? err.message : String(err)
        if (!account || !LOGIN_REFUSED.test(last)) throw new Error(last)
      }
    }
    throw new Error(last)
  }
}
