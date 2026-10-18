// DESK_APPEND (SPEC "The engine"): the text every chat's claude_code system prompt gets appended.
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { connectorsForChat } from '../connectors/registry'
import { coreModeOn } from './hydra-core-mode'

const FIRST =
  "You are running inside Hydra Desk, the owner's own desktop for Claude Code."

const DELEGATE = [
  'Sub-agents here are CliMayte workers, not the Agent tool: when you would start a sub-agent or hand off a piece of work,',
  'send it through the agenthydra MCP with `climayte_run { tasks: [{ prompt, cwd, kind, check }] }`',
  '(or `climayte_manage` for five or more tasks in rounds). Each task must stand alone: its folder, its goal, what done means',
  'and the proof to report. You keep the orchestration: split, dispatch, check each result\'s proof, judge it with',
  '`climayte_verdict`, report. Do yourself only what is faster than writing the brief.',
].join(' ')

/** How to put a picture, GIF or video in the reply itself: the window plays it in place (normalize.ts rewriteLocalImages). */
export const MEDIA =
  'To show the person a picture, GIF, video or web page, put it in your reply as a markdown image of its absolute path, ![what it shows](C:/absolute/path.mp4): png, jpg, gif, webp, mp4, mov, webm or html (videos up to 200 MB) appear and play right in the chat, and an .html file renders as a live preview (an email as recipients will see it), so never only name the path of a screenshot, GIF, recording or page you made or found.'

/** Appended in every mode: the real browser, saved browsers and inline pictures and videos. */
export const BROWSER = [
  'You have a real browser through the browser MCP; use it whenever a live page answers better than memory (a live site, docs, checking a deploy, a UI you built).',
  "Its tools are called directly: find a saved browser first with browser_profile_find { for: '<site, url or identity>' }, then browser_navigate { url, profile }, browser_snapshot, browser_click, browser_type, browser_take_screenshot.",
  'The person sees each call as a Browser card and can click it to watch that browser live in the side pane, so say what you open and why.',
  'Saved browsers belong to this workspace (browser_profiles lists each with what it is signed into).',
  "For a login only the person has: browser_profile_login { profile: '<identity, e.g. stripe-acme>', url }, tell them a Chrome window opened to sign in (or they open it from the Browser pane); when they say done, browser_profile_login { profile, url, verify: true }, then browser_profile_note { profile, note: '<site, account (never a password), purpose>' }. Reuse that profile name afterwards.",
  MEDIA,
].join(' ')

const DASHBOARD =
  "This project has a dashboard the person opens in AgentHydra: a small website that is yours to design (any HTML, CSS, JS or data); build and keep it current with dashboard_write on the agenthydra MCP."

/** The full orchestrator text, used when delegateToCliMayte is on. */
export const DESK_APPEND = `${FIRST} ${DELEGATE} ${BROWSER} ${DASHBOARD}`

/** When delegateToCliMayte is off, DESK_APPEND is its first sentence and the browser paragraph. */
export const DESK_APPEND_NO_DELEGATE = `${FIRST} ${BROWSER} ${DASHBOARD}`

export function deskAppend(delegate: boolean): string {
  return delegate ? DESK_APPEND : DESK_APPEND_NO_DELEGATE
}

/** The chat's own Desk id and the Desk base URL it listens on: what its move line names. */
export interface DeskSelf {
  id: string
  base: string
}

/** How a chat moves or renames itself: the agenthydra MCP's desk_chat, which defaults to this chat. */
export function moveLine(self: DeskSelf): string {
  return `This is Desk chat ${self.id}. To move this chat to another folder (its sidebar group and workspace) or rename it, call the agenthydra MCP's desk_chat { cwd, title } (either or both; it acts on this chat); check the answer's cwd. Rename only when the chat has really changed what it works on. Never move it by cd, climayte_send or a Connections workspace, and never open another chat to work elsewhere. For any other AgentHydra job, hydra_find { query } searches every tool.`
}

/** What a chat in `cwd` gets beyond Claude Code's own prompt and tools, in-process or as a CliMayte worker: the one place that decides it. */
export function chatAddOns(
  cwd: string,
  delegate: boolean,
  self?: DeskSelf,
  manager?: string | null,
): { append: string; mcpServers: Record<string, McpServerConfig>; manager?: string; chatId?: string } {
  const { mcpServers, prompts } = connectorsForChat(cwd, self?.id)
  const move = self ? ` ${moveLine(self)}` : ''
  // Core mode keeps the connector servers attached but drops their prompt texts and the orchestration paragraphs.
  const core = coreModeOn()
  const base = core ? `${FIRST} ${MEDIA}` : deskAppend(delegate)
  // A sub-manager chat's manager rides along so a CliMayte launch pins it too (AGENTHYDRA_MANAGER), and the chat's own id
  // so its agenthydra server knows which Desk chat calls it (manager_open, desk_chat), as an in-process chat's does.
  return {
    append: base + move + (core ? '' : prompts.map((p) => `\n\n${p}`).join('')),
    mcpServers,
    ...(manager ? { manager } : {}),
    ...(self ? { chatId: self.id } : {}),
  }
}
