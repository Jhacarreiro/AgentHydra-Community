// A Codex thread's items as Desk transcript items, so a chat pinned to Codex reads like any other: its replies,
// its reasoning summary, and each command, file change, MCP call and web search as the tool row the window
// already draws for Claude's (Bash or PowerShell, Edit, Write, mcp__server__tool, WebSearch). Shapes are the
// app-server's v2 protocol (`codex app-server generate-ts`), only the fields read here.

import { MAX_TOOL_RESULT_CHARS, type TodoEntry, type TranscriptItem } from '@shared/protocol'

type ToolItem = Extract<TranscriptItem, { kind: 'tool_use' }>
export type CodexStatus = 'inProgress' | 'completed' | 'failed' | 'declined'

export type CodexItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary?: string[]; content?: string[] }
  | { type: 'commandExecution'; id: string; command: string; status: CodexStatus; aggregatedOutput?: string | null; exitCode?: number | null }
  | { type: 'fileChange'; id: string; status: CodexStatus; changes: { path: string; kind: { type: string; move_path?: string | null }; diff: string }[] }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: string; arguments?: unknown; result?: { content?: unknown[] } | null; error?: { message?: string } | null }
  | { type: 'webSearch'; id: string; query?: string }
  | { type: 'imageView'; id: string; path: string }
  | { type: 'plan'; id: string; text: string }
  | { type: 'contextCompaction'; id: string }
  | { type: 'userMessage' | 'hookPrompt' | 'functionCallOutput' | 'dynamicToolCall' | 'collabAgentToolCall' | 'subAgentActivity' | 'sleep' | 'imageGeneration' | 'enteredReviewMode' | 'exitedReviewMode'; id: string }

/** When an item started and ended, and the chat's clock now. */
export interface ItemTimes {
  now: number
  startedAt?: number
  endedAt?: number
}

const cut = (s: string): { text: string; truncated?: boolean } =>
  s.length <= MAX_TOOL_RESULT_CHARS ? { text: s } : { text: s.slice(s.length - MAX_TOOL_RESULT_CHARS), truncated: true }

function toolStatus(s: string): ToolItem['status'] {
  if (s === 'inProgress') return 'running'
  if (s === 'declined') return 'denied'
  return s === 'failed' ? 'error' : 'done'
}

/**
 * The command a person typed, out of the shell Codex wraps it in (`"…\\pwsh.exe" -Command 'git status'`,
 * `/bin/bash -lc 'ls'`), and the tool row it is: PowerShell for a PowerShell, else Bash.
 */
export function shownCommand(command: string): { name: 'Bash' | 'PowerShell'; command: string } {
  const m = /^\s*(?:"([^"]+)"|(\S+))\s+(?:-(?:NoLogo|NoProfile|NonInteractive)\s+)*(?:-Command|-c|-lc|\/c)\s+([\s\S]+)$/i.exec(command)
  if (!m) return { name: 'Bash', command }
  const shell = (m[1] ?? m[2] ?? '').toLowerCase()
  const ps = /(?:pwsh|powershell)(?:\.exe)?$/.test(shell)
  let body = m[3]!.trim()
  if (body.length > 1 && body.startsWith("'") && body.endsWith("'")) body = ps ? body.slice(1, -1).replaceAll("''", "'") : body.slice(1, -1).replaceAll("'\\''", "'")
  else if (body.length > 1 && body.startsWith('"') && body.endsWith('"')) body = body.slice(1, -1).replaceAll('\\"', '"')
  return { name: ps ? 'PowerShell' : 'Bash', command: body }
}

/** A unified diff as the text before and after, hunk by hunk (an Edit row draws the two). Text with no diff marks is new content. */
export function editFromDiff(diff: string): { before: string; after: string } {
  const lines = diff.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  if (!lines.some((l) => l.startsWith('@@') || l.startsWith('+') || l.startsWith('-'))) return { before: '', after: diff }
  const before: string[] = []
  const after: string[] = []
  let hunks = 0
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (hunks++ > 0) {
        before.push('…')
        after.push('…')
      }
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('\\')) continue
    if (line.startsWith('+')) after.push(line.slice(1))
    else if (line.startsWith('-')) before.push(line.slice(1))
    else {
      const same = line.startsWith(' ') ? line.slice(1) : line
      before.push(same)
      after.push(same)
    }
  }
  return { before: before.join('\n'), after: after.join('\n') }
}

/** An MCP result's text parts, a picture as "[image]". */
function mcpText(result: { content?: unknown[] } | null | undefined): string {
  return (result?.content ?? [])
    .map((c) => {
      const part = c as { type?: string; text?: string }
      if (part.type === 'text' && typeof part.text === 'string') return part.text
      return part.type === 'image' ? '[image]' : JSON.stringify(c)
    })
    .join('\n')
}

function tool(id: string, name: string, input: Record<string, unknown>, status: ToolItem['status'], t: ItemTimes, result?: { text: string; isError: boolean; truncated?: boolean }): ToolItem {
  const item: ToolItem = { kind: 'tool_use', id, ts: t.startedAt ?? t.now, name, input, status, startedAt: t.startedAt ?? t.now }
  if (status !== 'running') item.endedAt = t.endedAt ?? t.now
  if (result) item.result = result
  return item
}

/** The Desk items one Codex item is (none for the person's own message, which Desk wrote when it was sent). */
export function codexItems(item: CodexItem, t: ItemTimes): TranscriptItem[] {
  const ts = t.startedAt ?? t.now
  switch (item.type) {
    case 'agentMessage':
      return item.text.trim() ? [{ kind: 'assistant_text', id: item.id, ts, text: item.text }] : []
    case 'reasoning': {
      const text = [...(item.summary ?? []), ...(item.summary?.length ? [] : (item.content ?? []))].join('\n\n').trim()
      return text ? [{ kind: 'thinking', id: item.id, ts, text }] : []
    }
    case 'plan':
      return item.text.trim() ? [{ kind: 'assistant_text', id: item.id, ts, text: item.text }] : []
    case 'commandExecution': {
      const shown = shownCommand(item.command)
      const status = toolStatus(item.status)
      const out = item.aggregatedOutput ?? ''
      const failed = status === 'error' || (typeof item.exitCode === 'number' && item.exitCode !== 0)
      const result = status === 'running' ? undefined : { ...cut(item.exitCode && item.exitCode !== 0 ? `${out}${out ? '\n' : ''}Exit code ${item.exitCode}` : out), isError: failed }
      return [tool(item.id, shown.name, { command: shown.command }, failed && status === 'done' ? 'error' : status, t, result)]
    }
    case 'fileChange': {
      const status = toolStatus(item.status)
      return item.changes.map((c, i) => {
        const id = item.changes.length === 1 ? item.id : `${item.id}:${i}`
        const result = status === 'running' ? undefined : { text: status === 'done' ? 'Done.' : status === 'denied' ? 'Declined.' : 'The change did not apply.', isError: status === 'error' }
        if (c.kind.type === 'add') return tool(id, 'Write', { file_path: c.path, content: editFromDiff(c.diff).after }, status, t, result)
        if (c.kind.type === 'delete') return tool(id, 'Delete', { file_path: c.path }, status, t, result)
        const { before, after } = editFromDiff(c.diff)
        return tool(id, 'Edit', { file_path: c.kind.move_path ?? c.path, old_string: before, new_string: after }, status, t, result)
      })
    }
    case 'mcpToolCall': {
      const status = item.status === 'inProgress' ? 'running' : item.status === 'failed' || item.error ? 'error' : 'done'
      const input = item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments) ? (item.arguments as Record<string, unknown>) : {}
      const text = item.error?.message ?? mcpText(item.result)
      return [tool(item.id, `mcp__${item.server}__${item.tool}`, input, status, t, status === 'running' ? undefined : { ...cut(text), isError: status === 'error' })]
    }
    case 'webSearch':
      return [tool(item.id, 'WebSearch', { query: item.query ?? '' }, 'done', t, { text: '', isError: false })]
    case 'imageView':
      return [tool(item.id, 'Read', { file_path: item.path }, 'done', t, { text: '[image]', isError: false })]
    case 'contextCompaction':
      return [{ kind: 'system', id: item.id, ts, level: 'info', text: 'Codex compacted the conversation to make room.' }]
    default:
      return []
  }
}

/** What a running item is doing, short, for the chat's activity ("Bash: git status", "Edit: src/a.ts"). */
export function activityOf(item: CodexItem): string | null {
  switch (item.type) {
    case 'agentMessage':
      return 'Writing'
    case 'reasoning':
      return 'Thinking'
    case 'commandExecution': {
      const shown = shownCommand(item.command)
      return `${shown.name}: ${shown.command.split('\n')[0]!.slice(0, 80)}`
    }
    case 'fileChange':
      return `Edit: ${item.changes[0]?.path.split(/[\\/]/).pop() ?? 'files'}`
    case 'mcpToolCall':
      return `${item.server}: ${item.tool}`
    case 'webSearch':
      return 'Searching the web'
    default:
      return null
  }
}

/** A turn's plan (turn/plan/updated) as the chat's checklist. */
export function planTodos(plan: { step: string; status: string }[]): TodoEntry[] {
  return plan.map((p) => ({ content: p.step, status: p.status === 'completed' ? 'completed' : p.status === 'inProgress' ? 'in_progress' : 'pending' }))
}
