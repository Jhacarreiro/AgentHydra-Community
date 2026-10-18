// Hydra Desk protocol: the one contract between the server (server/) and the window (web/).
// Both sides import this file. Change it only together with SPEC.md, and update both sides in the
// same commit. Plain types only: no runtime code, no imports.

// Chats run by Hydra Desk itself (one Claude Agent SDK session each)

/** What a chat is doing right now. This is the whole point of the app: it must always be true. */
export type ChatStatus =
  | 'starting' // the runtime is spawning, before the SDK's system/init arrives
  | 'working' // a turn is running
  | 'needs_you' // waiting on a permission, a question or a plan approval
  | 'idle' // the last turn finished; ready for the next message
  | 'stopped' // the user interrupted the last turn
  | 'error' // the last turn failed; see ChatSummary.lastError
  | 'limited' // the account hit a usage limit; see ChatSummary.limitResetsAt
  | 'closed' // no live runtime (app restarted, or closed after idling); sending a message resumes it

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
/** Off, a button that folds the window to the screen's edge, or folding by itself while the window is out of focus. */
export type CollapseMode = 'off' | 'button' | 'auto'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Which Claude login a chat runs under. configDir null = the machine's default ~/.claude login. */
export interface AccountRef {
  id: string // 'default' or the AgentHydra CLI instance id
  label: string // e.g. '#68 eek (Max 20x)'
  configDir: string | null
  number?: number // AgentHydra's permanent instance number
}

/** A service a chat's own turns can run on (the row menu's Pin service). Claude, through the chat's account, is every chat's own. */
export type ChatServiceKind = 'claude' | 'codex' | 'chatgpt'
/** A service a chat can be pinned to instead of Claude. */
export type SusLevel = 'fine' | 'sus' | 'bad'
export const SUS_LEVELS: readonly SusLevel[] = ['fine', 'sus', 'bad']
export interface SusPick {
  model: string
  effort: Effort | null
  pushbackRate: number
  turns: number
}
export type PinnedService = Exclude<ChatServiceKind, 'claude'>

/** Where a pinned chat's conversation goes on in a service: the account Desk picked there and the thread on it. */
export interface ServiceThread {
  accountId: string // AgentHydra's Codex instance id, or the Free ChatGPT account's id
  label: string // the account as the window names it: '#196 example', a Free account's name
  threadId: string // the Codex thread id, or the ChatGPT chat id
}

/** GET /api/chat-services: each service Pin service offers, and whether one of its accounts can take a chat now. */
export interface ChatServiceInfo {
  kind: ChatServiceKind
  label: string // 'Claude', 'Codex', 'ChatGPT'
  ready: boolean
  /** Why it is not ready, in plain words ("No Codex account is signed in"); absent when ready. */
  why?: string
  /** How many of its accounts are signed in. */
  accounts: number
}

/** A CliMayte worker that waits for an account to start on: `reason` in plain words (no addresses), `until` the epoch ms it is expected to start, when known. */
export interface ChatWait {
  reason: string
  until: number | null
}

export interface ChatSummary {
  id: string // Hydra Desk chat id (uuid), stable for the chat's life
  sessionId: string | null // the Claude Code session id, known once system/init arrives
  title: string
  cwd: string
  account: AccountRef
  /** The account was placed by 'auto' (not named): a usage limit moves the chat to another account. */
  accountAuto: boolean
  model: string | null // null = the account's default model
  effort: Effort | null
  permissionMode: PermissionMode
  delegateToCliMayte: boolean // sub-agents go to CliMayte (Agent/Task tools disallowed)
  status: ChatStatus
  /** While working: what it is doing, short ("Thinking", "Writing", "Bash: bun test", "Edit: src/a.ts"). */
  activity: string | null
  turnStartedAt: number | null // epoch ms the running turn started; null when not working
  lastError: string | null
  limitResetsAt: number | null // epoch ms, when status is 'limited' and the reset is known
  /** A CliMayte chat (status 'starting') whose worker is waiting for an account, not booting: why, and when it is expected to start. */
  waiting?: ChatWait | null
  unread: boolean // finished or needs you since the user last looked at it
  pinned: boolean
  archived: boolean
  group: string | null // the sidebar group it was moved to; null = its project folder's group
  /** The person's own note on the chat (the row menu's Add note…); absent or null = none. */
  note?: string | null
  /** Pin service: Codex or ChatGPT runs the chat's own turns instead of Claude. Absent or null = Claude, on `account`. */
  service?: PinnedService | null
  /** The sus level (SPEC "Sus meter"): absent = 'fine'. */
  sus?: SusLevel
  /** What 'sus' runs the next Claude turn on (the setting that pushes back least); null when none qualifies yet, absent off 'sus'. Never saved. */
  susPick?: SusPick | null
  /** A worker chat's own model and effort before its first Sus override (CliMayte keeps a sent setting): sent back once when Sus stops applying. */
  susRestore?: { model: string | null; effort: string | null }
  /** The chat's thread on each service it ran on, kept when the pin moves on: pinned there again, it goes on in that thread. */
  serviceThreads?: Partial<Record<PinnedService, ServiceThread>>
  /** When the pin last left each service (epoch ms): the next turn there first reads what was said since, then this is cleared. */
  serviceLeftAt?: Partial<Record<ChatServiceKind, number>>
  /** The service the chat's last turn ran on, when that was Codex or ChatGPT; absent = Claude. A handoff names it as what ran the chat meanwhile. */
  serviceRanOn?: PinnedService
  forkedFrom: string | null // the session it was forked from: until it has its own, its next message resumes a fork of that one
  createdAt: number
  updatedAt: number // last activity of any kind
  /** When its newest transcript item happened (a message sent, a reply, a tool call), epoch ms: opening, renaming or
   *  pinning the chat leaves it alone, unlike updatedAt. Absent until it has one. */
  lastActionAt?: number
  costUsd: number // running total reported by the SDK's result messages
  contextPct: number | null // 0..100, share of the context window used after the last turn
  pendingCount: number // open permission / question / plan requests
  queuedCount: number // user messages sent while a turn was running, not yet taken up
  climayteActive: number // CliMayte workers this chat dispatched that are still queued/running/waiting, and its sub-chats (seats) still at work
  /** The chat's own background tasks still running (commands, sub-agents, workflows), less the long-lived
   *  ones (dev servers, watchers: server/src/engine/long-lived.ts). Absent = none. */
  backgroundActive?: number
  /** Every CliMayte worker ever matched to this chat (running and finished), kept so finished ones stay listed under it. */
  workerIds?: string[]
  /** The CliMayte worker this chat runs as; absent = an SDK chat run in this process; null = not started yet. */
  workerId?: string | null
  /** The Desk chat this one was opened from (a sub-manager chat): the sidebar nests it directly below that chat. */
  parentId?: string | null
  /** The manager this chat is pinned to: its Claude process runs with AGENTHYDRA_MANAGER set to it. */
  managerSlug?: string | null
  /**
   * The manager the chat is on now: its pin, else the one its Claude session's state names. Left out when neither has a persona.
   * title and oneLiner come from its persona.json; photo is its avatar file's mtime in whole ms (a cache-buster), null with no avatar.
   * statsLine is the manager's analytics in one line to show as is ('41 turns · 98% answered'), absent or null before there is data.
   * With no manager, Hydra Core's persona for the chat (server/src/engine/core-lead.ts): role 'lead' for the chat's lead,
   * 'seat' for the persona a seat sits as. persona is set for one who is no manager: its photo is GET
   * /api/personas/:slug/avatar, read from wherever its portrait lives, and is not changed from Desk.
   */
  manager?: {
    slug: string
    name: string
    title: string | null
    oneLiner: string | null
    photo: number | null
    statsLine?: string | null
    role?: 'lead' | 'seat'
    persona?: true
  } | null
}

// Transcript items: the normalized form of the SDK's message stream (and of AgentHydra transcripts)

export interface ImageRef {
  mediaType: string // image/png, image/jpeg, image/gif, image/webp; video/mp4 or video/webm for a video (url only)
  dataBase64?: string // present when the client sent it and for small images; omitted in history
  name?: string
  /** Where the window loads the picture from when dataBase64 is absent: a server route of this chat. */
  url?: string
  bytes?: number // file size, for the file card ("PNG, live.png, 67.2KB")
  /** The local file this ref was made from (absolute), so the window can offer "Open in Explorer"; absent for a pasted or generated picture. */
  path?: string
}

export interface ToolResult {
  text: string // the result as text (images described as "[image]"), cut to MAX_TOOL_RESULT_CHARS
  isError: boolean
  truncated?: boolean
  images?: ImageRef[] // pictures the tool returned (a Read of a PNG), shown under its row
}

export interface AskQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description?: string }[]
}

export type ElicitationValue = string | number | boolean | string[]

/** One input of an MCP elicitation form, flattened from the server's requested JSON schema. */
export interface ElicitationField {
  name: string
  label: string
  description?: string
  type: 'text' | 'number' | 'boolean' | 'choice' | 'multichoice'
  required: boolean
  options?: { value: string; label: string }[] // choice, multichoice
  /** choice: the schema's values are numbers, and the answer goes back as a number. */
  numeric?: boolean
  /** The schema's limits, which the answer must keep: number (integer, min, max) and text (minLength, maxLength). */
  integer?: boolean
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  default?: ElicitationValue
}

export interface TodoEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

interface ItemBase {
  id: string // stable: an upsert with the same id replaces the item
  ts: number // epoch ms
  /** Set when the item belongs to a sub-agent (the Agent/Task tool call it runs under). */
  parentToolUseId?: string | null
}

export type TranscriptItem =
  /** sendFailed is client-only: the window's own bubble for a message the POST did not reach the server. */
  | (ItemBase & { kind: 'user'; text: string; images?: ImageRef[]; queued?: boolean; sendFailed?: string })
  /** A message another program typed into the session as a user turn (an AgentHydra ping): never the person's bubble. */
  | (ItemBase & { kind: 'note'; from: string; text: string })
  /** branchFrom: an outside Claude Code session's reply names its transcript line, where "Copy up to here into a new chat" cuts (ExternalBranchRequest).
   * media: pictures and videos the finished reply only names (a path in backticks, prose or a link), shown under it; the text is unchanged. */
  | (ItemBase & { kind: 'assistant_text'; text: string; streaming?: boolean; branchFrom?: string; media?: ImageRef[] })
  | (ItemBase & { kind: 'thinking'; text: string; streaming?: boolean })
  | (ItemBase & {
      kind: 'tool_use'
      /** The item id is the tool_use id. */
      name: string // Bash, Read, Edit, Write, Grep, Glob, WebFetch, TodoWrite, Agent, mcp__server__tool, ...
      input: Record<string, unknown>
      status: 'running' | 'done' | 'error' | 'denied'
      result?: ToolResult
      progress?: string // latest tool progress line, while running
      startedAt: number
      endedAt?: number
    })
  | (ItemBase & {
      kind: 'permission'
      /** The item id is the request id the server made for this canUseTool call. */
      toolName: string
      toolUseId?: string
      input: Record<string, unknown>
      blockedPath?: string
      canAlwaysAllow: boolean // the SDK offered permission suggestions (and did not forbid saving a rule)
      /** The sentence the SDK gives for the prompt ("Claude wants to run git push"); the card falls back to "Allow <tool>?". */
      title?: string
      description?: string
      /** Why it asks (a safety check, an `ask` rule, a hook), when the SDK says. */
      reason?: string
      /** The SDK starts this one on No: Enter must not allow it. */
      defaultToNo?: boolean
      /** What "Always allow" would save, one line each: the rule and where it is kept ("Bash(git status:*) in this project"). */
      alwaysRules?: string[]
      state: 'pending' | 'allowed' | 'session' | 'always' | 'denied' | 'expired'
    })
  | (ItemBase & {
      kind: 'elicitation' // an MCP server asks the user for something (a form, or a link to open)
      /** The item id is the request id the server made for this onElicitation call. */
      serverName: string
      message: string
      /** The header and subtitle an MCP server gives an elicitation-driven permission prompt, when it gives them. */
      title?: string
      description?: string
      mode: 'form' | 'url'
      url?: string // mode 'url': the page to open
      fields?: ElicitationField[] // mode 'form'
      state: 'pending' | 'accepted' | 'declined' | 'expired'
      values?: Record<string, ElicitationValue> // what was sent back
    })
  | (ItemBase & {
      kind: 'question' // the AskUserQuestion tool
      toolUseId?: string
      questions: AskQuestion[]
      state: 'pending' | 'answered' | 'skipped' | 'expired'
      answers?: Record<string, string> // question text -> answer (multi-select comma-separated)
    })
  | (ItemBase & {
      kind: 'plan' // the ExitPlanMode tool
      toolUseId?: string
      plan: string // markdown
      state: 'pending' | 'approved' | 'rejected' | 'expired'
    })
  | (ItemBase & { kind: 'todos'; todos: TodoEntry[] }) // id 'todos': one live checklist per chat
  | (ItemBase & {
      kind: 'task' // a background sub-agent / task the SDK reports (task_started/updated/notification)
      taskId: string
      description: string
      status: 'running' | 'completed' | 'failed' | 'stopped'
      summary?: string
      /** What the task is, for its row and card: a workflow, a background command, a sub-agent. */
      taskKind?: 'workflow' | 'bash' | 'agent' | 'other'
      toolUseId?: string
      command?: string // bash: the command it runs, so a long-lived one (a dev server) is told apart
      agents?: number // workflow: how many agents it ran
      tokens?: number
      durationMs?: number
      outputFile?: string
    })
  | (ItemBase & {
      kind: 'system'
      level: 'info' | 'warn' | 'error'
      text: string
      /** The row has a Retry: the chat's Claude Code download failed and this starts it again. */
      retry?: boolean
    })
  | (ItemBase & {
      kind: 'result' // end of a turn
      ok: boolean
      durationMs: number
      costUsd: number
      turns: number
      error?: string
    })

/** `GET /api/chats/:id/items?before=<position>&limit=<n>`: one page of a chat's items, oldest first. `position` is an
 *  index in the whole list; `olderBefore` is where this page's first item sits (0 = nothing older), `total` the whole count. */
export interface ChatItemsPage {
  items: TranscriptItem[]
  total: number
  olderBefore: number
}

/** A whole transcript in brief (`GET /api/external/sessions/:id/index`): a window holding only the newest page still has every
 *  user message (`position` is its place among all `total` items), the newest checklist and the background tasks. */
export interface TranscriptIndex {
  total: number
  userMessages: { id: string; position: number; firstLine: string; images: number }[]
  latestTodos: TranscriptItem | null
  runningTasks: TranscriptItem[]
  /** The last 20 finished tasks, oldest first. */
  recentTasks: TranscriptItem[]
  lastUserText: string
  /** An outside session's: the tokens in context after its last reply, from its Claude Code .jsonl or Codex rollout; null when
   *  its file has none, absent on a Desk chat (whose ChatSummary.contextPct is the share). */
  contextTokens?: number | null
  /** The model's context window, where the file names it (a Codex rollout's token_count does, a Claude Code .jsonl never). */
  contextWindow?: number | null
  /** How often each tool was called over the whole transcript, the most called first (the rail's Tools and Connectors). */
  tools?: ToolTally[]
}

/** One tool's calls in a transcript (a tool_use item each) and how many of them failed. */
export interface ToolTally {
  name: string
  calls: number
  errors: number
}

/** `GET /api/external/sessions/:id/older?before=<offset>&limit=<n>` answers the newest n items before the offset and this
 *  header: how many items are still above that page. Pass it as `&end=<it>` for the next page; 0 or absent: that was the first. */
export const OLDER_END_HEADER = 'x-older-end'

export const MAX_TOOL_RESULT_CHARS = 20_000

/** `GET /api/external/sessions/:id/items` answers a long session's newest part; this header says where in its file
 *  that part begins, and `GET /api/external/sessions/:id/older?before=<it>` answers what is before it. */
export const OLDER_BEFORE_HEADER = 'x-older-before'

/** How the muted line a CliMayte handoff's continuation prompt is shown as starts (server engine/system-text.ts). */
export const CONTINUED_LINE = 'Continued in a fresh session'

// Things Hydra Desk watches through AgentHydra (the daemon on 127.0.0.1:7787)

/** A Claude Code session NOT run by Hydra Desk: a Claude Desktop chat, a terminal CLI, a CliMayte worker, Codex. */
export interface ExternalSession {
  id: string // the session id AgentHydra knows it by
  title: string
  cwd: string | null
  source: 'desktop' | 'cli' | 'climayte' | 'codex' | 'other'
  instance: string | null // which desktop/CLI instance (label or number) it runs under
  status: 'working' | 'needs_you' | 'idle' | 'stale' // stale = no activity for a long time
  activity: string | null
  lastActivityAt: number | null
  model: string | null
  /** The signed-in CLI instance whose folder already holds this session: it continues there in place. null: it continues as a copy under the account the window lands it on. */
  accountId: string | null
  /** A Codex chat's: the Codex account (AgentHydra's instance id) whose folder holds it, where it continues in place. */
  codexAccountId?: string
  /** Idle in someone else's window, and a Claude Code session or a Codex chat whose account is known: the composer can carry it on. */
  canResume: boolean
  /** The other PC's name for a Desktop chat AgentHydra's chat sync took from it (AgentHydra's `from_pc`); null for this PC's. */
  fromPc: string | null
  /** The ExternalSession id of the chat whose chip started this one, when that chat is in the list; the sidebar nests it under that chat. Left out when the parent is not known. */
  parentId?: string
  /** Set while a usage limit stopped it and nothing has followed (AgentHydra's `limit_stop`, pending): the babysitter's. */
  limit?: ExternalLimit
  // Hydra Desk's own marks (its session-meta overlay; the session's files are never touched). The title above is the overlay's when renamed.
  pinned: boolean
  archived: boolean
  unread: boolean
  group: string | null
  /** The person's note on it (SessionMeta.note); absent = none. */
  note?: string | null
  /** In the sidebar's Unassigned holding area: taken off its account, not archived, on no account now (SessionMeta.unassigned). */
  unassigned?: boolean
}

/** The usage limit an outside session still sits at. */
export interface ExternalLimit {
  /** The CLI's own notice, e.g. "You've hit your session limit · resets 11:40pm (America/Chicago)". */
  notice: string
  /** When it was hit, ms. */
  at: number
  /** When it resets, ms, read from the notice against the moment it was hit; null when the notice names no time. */
  resetsAt: number | null
}

/** POST /api/external/sessions/:id/message: text for a Claude Desktop chat that is working; AgentHydra queues it in the chat. Errors answer { error } with the daemon's reason. */
export interface DesktopMessageRequest {
  text: string
  /** How long the message stays worth sending while the chat is busy (a note sent on a clock: its cadence). */
  holdSecs?: number
}
export interface DesktopMessageResult {
  ok: true
  /** How it got there ('peer': the chat's own input queue over the native peer channel). */
  route: string
  delivered: true
  detail: string
}

/** POST /api/external/sessions/:id/stop: Claude Desktop's own Stop for a working chat. 200 { ok: true } once the app
 *  shows the turn stopping or stopped; otherwise a non-2xx answer with { error }. */
export interface DesktopStopResult {
  ok: boolean
  reason?: string
}

/**
 * POST /api/external/sessions/:id/branch: "Copy up to here into a new chat". AgentHydra writes a new Claude Code
 * session beside this one holding it up to the reply `uuid` (its session-branch), titled "<title> (branch)";
 * the original is not touched. Answers the new session's id; errors answer { error } with the daemon's reason.
 */
export interface ExternalBranchRequest {
  uuid: string
  title?: string
}
export interface ExternalBranchResult {
  id: string
}

/** The overlay Hydra Desk keeps on an outside session (PATCH /api/external/sessions/:id/meta answers it). */
export interface SessionMeta {
  title: string | null // null = the session's own title
  pinned: boolean
  archived: boolean
  unread: boolean
  group: string | null
  /** The person's note on the chat (the row menu's Add note…), at most NOTE_MAX characters; null = none. */
  note: string | null
  /**
   * Move to account > Unassigned (owner, 2026-10-13: "not assigned to an account, but it's not archived"): the chat was
   * taken off its account (archived in that account's app) and waits in the sidebar's Unassigned group, listed however
   * old, until Move to account lands it on one. The list drops the mark once the chat shows on an account again.
   */
  unassigned: boolean
}

/** The longest note a chat keeps. */
export const NOTE_MAX = 2000

export type SessionMetaPatch = Partial<SessionMeta>

/** One session AgentHydra's transcript search found (GET /api/search). */
export interface SearchHit {
  sessionId: string
  title: string
  cwd: string | null
  /** The matching line, at most ~160 characters around the match; the window emphasises the query's words. */
  snippet: string
  source: ExternalSession['source']
  lastActivityAt: number | null
  /** How many times the transcript matched. */
  score?: number
}

// Hydra Desk 2: the cloud list (the chrome bar's cloud button). AgentHydra's whole session list, the
// way its Sessions tab shows it: every source and instance, both PCs' chats included. A Desktop chat
// the chat sync took from another PC carries that PC's name in `fromPc`; every other row is this PC's.

/** One row of the cloud list (GET /api/cloud/sessions), mapped from AgentHydra's GET /api/sessions. */
export interface CloudSession {
  id: string // the session id
  title: string
  /** The folder the session started in, where Claude Desktop and the desk list show it (server bridge/cloud.ts startFolder). */
  cwd: string | null
  /** The folder it last worked in when that is not `cwd` (it moved into a subfolder); null when it never left. */
  lastCwd: string | null
  source: string // AgentHydra's: claude, codex, opencode, hermes, dsh, zswarm, foreign
  instance: string | null // the desktop or CLI instance folder it ran under; null = the default login
  lastActivityAt: number
  createdAt: number | null
  messageCount: number
  dispatched: boolean // queued by AgentHydra rather than driven by hand
  archived: boolean
  fromPc: string | null
  model: string | null
  effort: string | null
  instanceNum: number | null // AgentHydra's instance number, the #37 its rows show
}

export interface CloudList {
  /** This PC's name, for the rows without `fromPc`. */
  thisPc: string
  sessions: CloudSession[]
}

/** A desktop instance the Instance filter offers (GET /api/cloud/instances). */
export interface CloudInstance {
  name: string // the folder name the session list filters by
  label: string
}

export interface CliMayteWorker {
  id: string
  title: string
  description?: string | null // the first line of its task, for the Background tasks card
  group: string | null
  status: string // AgentHydra's own: queued, running, waiting, checking, done, failed, cancelled, ...
  active: boolean // queued, running, waiting or checking
  account: string | null // '#68' style label
  model: string | null
  effort: string | null
  kind: string | null
  cwd: string | null
  sessionId: string | null // the worker's current Claude Code session, for its live transcript
  originSessionId: string | null // the session id of the chat that dispatched it, when known
  originWorkerId?: string | null // the worker that dispatched it, when a worker did
  originTitle?: string | null // the title of the chat that dispatched it, as its own PC knows it (another PC's only)
  sessions?: string[] // every session the worker has had (a handoff gives it a new sessionId and keeps the old ones here)
  folder?: string | null // another PC's only: the last name of the folder it runs in, never the path (its `cwd` stays null)
  startedAt: number | null
  endedAt: number | null // when it settled; null while active
  lastActivityAt: number | null
  lastActivity: string | null // its latest event line, short
  doing?: string | null // what it is doing now: its hold reason or question while held, else its newest narration or step (null when finished)
  doingSince?: number | null // when that began (epoch ms)
  doingKind?: 'hold' | 'said' | 'step' | 'wait' | null // hold: waiting on the scheduler or its manager; said: its narration; step: a tool step; wait: a step blocked on a background job
  lastStepAt?: number | null // when its newest event came (epoch ms)
  usedPct: number | null // % of a Pro 5-hour window it has used
  tokens: number | null // tokens it has spent, when AgentHydra or its transcript says
  verdict: string | null
  error: string | null
  /**
   * What the worker said its current message would take (its `ETA: <n> min` line; AgentHydra's
   * climayte-eta.ts): `at` is when it said it, `tookS` the working seconds it took once that message
   * ended done (null until then). Absent or null when it gave none, or on another PC's worker.
   */
  eta?: { minutes: number; at: number; tookS: number | null } | null
  /**
   * The other PC's name when the worker runs there (AgentHydra's shared queue, GET /api/corch/remote);
   * absent or null = this PC. Such a worker has no folder here (only `folder`, its folder's last name), and
   * its session and origin are only ids that PC shared (a snapshot from an older AgentHydra has neither); its id may equal one of this PC's, and
   * nothing here can cancel it or send to it: the window keeps it apart from this PC's workers.
   */
  pc?: string | null
  /** What it asked with climayte_ask and waits on (absent: nothing). `at` is epoch ms. */
  question?: { text: string; at: number }
  /** ISO time a waiting worker is expected to start (a usage wall); absent when not known. */
  waitUntil?: string | null
  /** The wave it belongs to (a task of it, or its manager) and 'wave' for a manager held on a live wave. */
  wave?: string | null
  hold?: 'wave' | null
}

/**
 * One HSwarm job (AgentHydra's proxy of HSwarm, GET /api/hswarm/api/jobs, and the other PCs' through
 * GET /api/corch/remote), for the sidebar: it sits under the chat that called HSwarm. The jobs list gives the
 * caller's full ids (`caller_ids`): `callerSessionId` is the CLI session (a Claude Desktop chat only has a chat
 * id, which is resolved to its session through AgentHydra's /api/chats; null when unknown), `callerHostSessionId`
 * the Desktop chat id and `callerTitle` that chat's name when known. Only an answer without caller_ids falls back
 * to the old key's 8-character session prefix, which the window matches by prefix.
 * The jobs reach the window in the `swarm.update` event, every 10 s at most.
 */
export interface SwarmJob {
  id: string
  title: string // the job's label, else its id
  status: string // HSwarm's own: running, done, cancelled
  active: boolean // still running
  startedAt: number | null
  endedAt: number | null // null while active
  tasks: { total: number; done: number; failed: number; cancelled: number }
  callerSessionId: string | null
  callerHostSessionId: string | null
  callerTitle: string | null
  /** The other PC's name when the job ran there; null = this PC. Such jobs show only while the cloud is on. */
  pc: string | null
  /** Another PC's only: the last name of its caller's folder, never the path; absent or null when not shared. */
  folder?: string | null
  /** Tokens the job moved (HSwarm's own count: input cached or not, plus output); null when HSwarm gave none (another PC's). */
  tokens: number | null
  /** Dollars the job cost (HSwarm's own figure); null when HSwarm gave none. */
  costUsd: number | null
  /** Per model, from the job's results.jsonl (the server reads it, each finished job once); null when the file is not there. */
  models: SwarmJobModel[] | null
}

/** One model's tasks in a HSwarm job: the model without its `rank:` prefix or `:provider` suffix, and its results. */
export interface SwarmJobModel {
  model: string
  tasks: number
  ok: number
  failed: number
  tokens: number
}

/** How many finished workers and jobs of one session GET /api/session-tasks/:sessionId keeps: the Background tasks panel's
 *  Finished list holds 50, as the real app's does. */
export const SESSION_FINISHED = 50

/**
 * GET /api/session-tasks/:sessionId: the CliMayte workers (through the workers they dispatched) and the HSwarm jobs one
 * session called on this PC, each running one and the SESSION_FINISHED newest finished ones of each. The window's own
 * lists keep the 20 newest finished of the whole PC, which a busy PC turns over in minutes, so the Background tasks
 * panel and the tasks line ask for these while they are on screen and list them beside those.
 */
export interface SessionTasks {
  sessionId: string
  workers: CliMayteWorker[]
  jobs: SwarmJob[]
}

export interface AccountInfo extends AccountRef {
  email: string | null
  plan: string | null // 'Pro', 'Max 5x', 'Max 20x', ...
  signedIn: boolean
  fiveHourPct: number | null
  weeklyPct: number | null
  fiveHourResetsAt: number | null
  weeklyResetsAt: number | null
  inUse: boolean // a person or another session is using it now (AgentHydra's reading)
  /** The owner's priority for AgentHydra's work here (2 Top, 1 High, 0 Normal, -1 Low): a higher one is picked first. */
  priority?: number
  /** The owner's caps (1-84): this account's line in place of the fleet's 85%. Absent or null: the fleet's. */
  maxFiveHourPct?: number | null
  maxWeeklyPct?: number | null
}

// Git (the bar above the composer, and the diff pane)

export interface GitFileChange {
  path: string
  status: string // M, A, D, R, ?? (porcelain)
  added: number
  removed: number
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  added: number // total lines added in the working tree vs HEAD (untracked files counted)
  removed: number
  files: GitFileChange[]
}

/** GET /api/git/merge-conflicts: whether merging the base into HEAD would conflict, before any merge (git.ts mergeConflictFiles). */
export interface MergeConflictPreview {
  /** clean: the merge applies; conflicts: `files` would conflict; unavailable: no answer (no base, no commit, an old Git, a failed run). */
  state: 'clean' | 'conflicts' | 'unavailable'
  /** The ref compared against, e.g. origin/main; null when nothing was compared. */
  base: string | null
  /** The paths that would conflict, in Git's order; empty unless state is conflicts. */
  files: string[]
}

/** GET /api/server/update: the server's code changed on disk after it started (Menu > Restart to update). */
export interface ServerUpdate {
  stale: boolean
  /** The launcher started this server, so POST /api/server/restart can restart it (Windows only). */
  restartable: boolean
}

// Settings

export interface DeskSettings {
  defaultModel: string | null
  defaultEffort: Effort | null
  defaultPermissionMode: PermissionMode
  defaultAccountId: string // 'auto' or an AccountRef id
  delegateToCliMayte: boolean
  idleCloseMinutes: number // close a live runtime after this long idle (its chat goes 'closed')
  browserIdleMinutes: number // close a saved browser's headless Chrome after this long with no tool call against it
  notifications: boolean
  /** Folders added to the New screen's project grid, each one a tile (absolute paths). */
  projectFolders: string[]
  /** Folders whose subfolders each become a tile in the New screen's grid (absolute paths). */
  projectRoots: string[]
  /** Projects taken off the New screen's grid (absolute paths). */
  hiddenProjects: string[]
  /** Projects pinned to the top of the New screen's grid, in the order they were pinned (absolute paths). */
  pinnedProjects: string[]
  /** The babysitter continues chats a usage limit stopped once the limit resets (shared/babysitter.ts). */
  babysitter: boolean
  /** The instance manager moves the chats of a Claude Desktop or Codex app that went down to the same-kind account with the most room, and starts them again (shared/instance-manager.ts). On by default. */
  instanceManager: boolean
  /** The orchestrator, armed: it continues chats an error stopped and its foreman peeks at running ones (shared/orchestrator.ts). Off by default. */
  orchestrator: boolean
  /** The model the orchestrator's judge asks: an alias (opus, sonnet, haiku: the newest of each) or a full model id (shared/orchestrator.ts). */
  orchestratorModel: string
  /** Routines runs the routines in <home>/routines on their schedule, or by their status (shared/routines.ts). */
  routines: boolean
  /** The window folds to the screen's right edge, showing only the chats (web/src/components/sidebar/collapse.ts). Off by default. */
  collapseMode: CollapseMode
  /** New chats run on the new core (core/, server/src/plugins/19-core.ts); chats made before stay where they are. */
  coreEngine: boolean
}

// REST request bodies (see SPEC.md "REST API" for the routes)

export interface CreateChatRequest {
  cwd: string
  prompt?: string // sent as the first message when present
  images?: ImageRef[]
  title?: string
  accountId?: string // 'auto' (default) or an AccountRef id
  model?: string | null
  effort?: Effort | null
  permissionMode?: PermissionMode
  delegateToCliMayte?: boolean
  parentId?: string // the Desk chat this one sits under (a sub-manager chat)
  sus?: SusLevel // the sus level the chat starts on (default 'fine')
  managerSlug?: string // the manager this chat runs as: its Claude process gets AGENTHYDRA_MANAGER
}

export interface SendMessageRequest {
  text: string
  images?: ImageRef[]
}

export interface PermissionDecision {
  decision: 'allow' | 'session' | 'always' | 'deny' // session = allow, and stop asking for the rest of this session only
  message?: string // deny reason shown to the model
}

export interface ElicitationAnswer {
  action: 'accept' | 'decline'
  values?: Record<string, ElicitationValue> // action 'accept' on a form
}

export interface QuestionAnswer {
  answers?: Record<string, string>
  /** Pictures pasted into a question's "Other" box (dataBase64), by question text. The server saves each and adds `[Image: source: <path>]` to that answer. */
  images?: Record<string, ImageRef[]>
  skip?: boolean
}

export interface PlanDecision {
  approve: boolean
  feedback?: string // when rejecting: what to change
  mode?: PermissionMode // when approving: the mode to continue in (default: the mode the chat was in before it entered plan mode, else acceptEdits)
}

export interface ChatPatch {
  title?: string
  pinned?: boolean
  archived?: boolean
  unread?: boolean
  model?: string | null
  effort?: Effort | null
  permissionMode?: PermissionMode
  delegateToCliMayte?: boolean
  accountId?: string // takes effect at the next runtime start
  group?: string | null // 1-60 chars after trimming; null = back to its folder's group
  cwd?: string // put the chat in another folder (an existing local directory); its next turn resumes there
  note?: string | null // at most NOTE_MAX characters after trimming; null or empty = no note
  sus?: SusLevel // fine = the chat's own setting; sus = the setting that pushes back least + owner context; bad = pinned to Codex
  service?: PinnedService | null // Pin service; null = back to Claude. A running turn ends where it is; the next one runs there
}

export interface ImportSessionRequest {
  sessionId: string
  cwd?: string
  configDir?: string | null
  title?: string
  fork?: boolean // a new chat that forks the session at its first message; the original stays listed
  at?: string // with fork: the owner's message (its transcript item id) the fork leaves out, with all after it
}

/** POST /api/chats/:id/fork. No `at`: a copy of the whole chat; with it, the chat cut just before that message of the owner's (its item id). */
export interface ForkChatRequest {
  at?: string
}

/** POST /api/chats/:id/rewind (Undo): the chat drops the owner's message `at` (its item id) and all after it; answers the chat. */
export interface RewindChatRequest {
  at: string
}

/** POST /api/chats/:id/send-now: Send now on a message waiting behind a running turn ("Queued" under its bubble); `itemId` is that bubble. */
export interface SendNowRequest {
  itemId?: string
}

/** Its answer: `stopped` is false when no running turn was stopped for it; `message` then says why, in the words
 *  the bubble shows (it already went, or no turn runs yet: a CliMayte chat waiting for an account). */
export interface SendNowResult {
  ok: true
  stopped: boolean
  message?: string
}

/** POST /api/chats/:id/cancel-queued: takes a queued message back before it is sent; `itemId` is its bubble. */
export interface CancelQueuedRequest {
  itemId: string
}

/** Its answer: `cancelled` is false when the message already went into the turn; `message` says so in the words the bubble shows. */
export interface CancelQueuedResult {
  ok: true
  cancelled: boolean
  message: string
}

export interface SlashCommandInfo {
  name: string // without the leading slash
  description: string
  argumentHint?: string
}

export interface ModelChoice {
  value: string // what is passed to the SDK, e.g. 'claude-opus-5-5' or an alias
  label: string // 'Opus 5.5'
}

/** An MCP server a chat in `cwd` loads (GET /api/mcp-servers): name, scope and transport only, never its config. */
export interface McpServerInfo {
  name: string
  scope: 'user' | 'project' | 'local' | 'hydra-desk' // local = added with `claude mcp add` for this folder (the account's .claude.json)
  transport: 'stdio' | 'http' | 'sse'
}

/** A live chat's MCP servers as its SDK session reports them (GET /api/chats/:id/mcp). */
export interface McpStatus {
  live: boolean
  servers: { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' }[]
}

// The managed send queue (SPEC "Send queue"): messages and new chats the server holds until they can go out.
// Not the SDK's own queue (a message pushed while a turn runs cannot be edited); these are held server-side.

/** waiting = will go out by itself; held = the owner must release it (see reason); sending = being handed over now; failed = see reason. */
export type QueueItemState = 'waiting' | 'held' | 'sending' | 'failed'

interface QueueItemBase {
  id: string
  /** Bumped by every change; an edit or reorder that names an older one is refused (two windows). */
  rev: number
  createdAt: number
  updatedAt: number
  state: QueueItemState
  /** What a waiting item waits for, or why a held or failed one is not going out: one short sentence. */
  reason: string | null
  text: string
  images?: ImageRef[] // url form only: the server keeps the pictures in its media cache
}

export type QueueItem =
  | (QueueItemBase & { kind: 'message'; chatId: string })
  | (QueueItemBase & {
      kind: 'chat' // a new chat, started once an account has room
      cwd: string
      title?: string
      accountId?: string
      model?: string | null
      effort?: Effort | null
      permissionMode?: PermissionMode
      delegateToCliMayte?: boolean
      /** Set once the chat exists (a failed first send leaves the item 'failed' with the chat to open). */
      startedChatId: string | null
    })

export type QueueSendMode = 'immediate' | 'queue'

export interface QueueState {
  items: QueueItem[] // in send order
  paused: boolean // nothing goes out while paused
  /** What a plain Enter does while a chat is working and on the new-session screen: 'immediate' hands the message to the running turn (a new chat starts at once), 'queue' holds it here (a new chat waits for an account with room). Ctrl+Enter queues while a turn runs, and always on the new-session screen. */
  sendMode: QueueSendMode
  /** How many chats started from the queue may run at once; the next one waits for a free slot and an account with room. */
  maxNewChats: number
  /** Chats whose queued messages are held, and why: the owner stopped the turn, it failed, or the server restarted under it. */
  held: Record<string, 'stopped' | 'error' | 'restart'>
  rev: number
}

export type QueueAddRequest =
  | { kind: 'message'; chatId: string; text: string; images?: ImageRef[] }
  | ({ kind: 'chat' } & CreateChatRequest)

export interface QueuePatch {
  text?: string
  images?: ImageRef[]
  ifRev?: number
}

export interface QueueSettingsPatch {
  paused?: boolean
  sendMode?: QueueSendMode
  maxNewChats?: number
}

/** The whole desired order, every id once; ifRev (the queue's rev) guards a stale window. */
export interface QueueReorder {
  ids: string[]
  ifRev?: number
}

// WebSocket (/ws): the server pushes; the client only pings

export type ServerEvent =
  // `chats` is the whole list, so a chat it leaves out is gone; absent while the server is still loading its chats.
  | { type: 'hello'; version: string; chats?: ChatSummary[]; settings: DeskSettings; queue?: QueueState }
  | { type: 'queue.update'; queue: QueueState }
  | { type: 'chat.upsert'; chat: ChatSummary }
  | { type: 'chat.removed'; chatId: string }
  | { type: 'item.upsert'; chatId: string; item: TranscriptItem }
  | { type: 'item.delta'; chatId: string; itemId: string; text: string } // append to a streaming assistant_text/thinking
  | { type: 'item.removed'; chatId: string; itemId: string } // a stand-in item its real copy replaced (a CliMayte chat's sent message), or an item Undo took out
  | {
      type: 'notify'
      chatId: string
      reason: 'finished' | 'needs_you' | 'error' | 'limited'
      title: string
      body: string
    }
  // A desktop notification about an account, not a chat (a Free account that moved between free and paid).
  | { type: 'notice'; title: string; body: string }
  | { type: 'bridge.status'; up: boolean; url: string }
  | { type: 'external.update'; sessions: ExternalSession[] }
  | { type: 'climayte.update'; workers: CliMayteWorker[] }
  | { type: 'browser.audio'; state: { audible: string[]; muted: string[]; unattributed: { profile: string; url: string }[]; unattributedMuted: boolean } }
  | { type: 'swarm.update'; jobs: SwarmJob[] }
  | { type: 'accounts.update'; accounts: AccountInfo[] }
  | { type: 'settings.update'; settings: DeskSettings }

/** What a window sends on /ws: `visibility` right after it connects and whenever it is shown or hidden. */
export type ClientEvent = { type: 'ping' } | { type: 'visibility'; visible: boolean }

// Failure ledger (SPEC "Failure ledger"): <home>/failures.jsonl, GET /api/failures

export type FailureCause =
  | 'auth_expired'
  | 'org_disabled'
  | 'usage_limit'
  | 'interrupted'
  | 'refused_send'
  | 'worker_failed'
  | 'hook_timeout'
  | 'hook_failed'
  | 'move_failed'
  | 'network'
  | 'unknown'

/** One failure event. Never an email: the account is its number or id. */
export interface FailureRow {
  id: string
  ts: number
  chatId: string
  title: string
  cwd: string
  kind: 'sdk' | 'worker'
  accountId: string
  accountNumber: number | null
  model: string | null
  cause: FailureCause
  /** The error text, cut to 500 characters, emails masked. */
  message: string
  /** ms from the turn's start, null when unknown. */
  durationMs: number | null
  sessionId: string | null
  /** Desk moved the chat to another account and sent again. */
  recovered: boolean
  movedToAccountId: string | null
}

export interface FailuresResponse {
  rows: FailureRow[]
  total: number
  byCause: Record<string, number>
  /** Keyed by account number ('#126') else id. */
  byAccount: Record<string, number>
  /** Keyed by local day, YYYY-MM-DD. */
  byDay: Record<string, number>
}

export type HomeStatsRange = 'all' | '30d' | '7d'

/** A part of the card that did not answer: the card shows a dash for it with `reason` as its tooltip. */
export interface HomeStatsMissing {
  part: 'activity' | 'climayte' | 'hswarm'
  reason: string
}

/** One of AgentHydra's sources (desktop, cli, climayte, hswarm, codex, opencode, dsh, hermes). */
export interface HomeStatsSource {
  key: string
  /** 'Claude desktop', 'CliMayte', ...; a source the server does not know keeps its key. */
  label: string
  sessions: number
  messages: number
  tokens: number
  costUsd: number | null
}

/**
 * One square of the stats card's activity grid: its local day (YYYY-MM-DD), that day's figure and its
 * shade 0-4 against the busiest day shown, so a hover can name the day and its number (owner, 2026-10-05:
 * "Each of the squares ... need to have a number I can read when I hover over them").
 */
export interface HeatCell {
  day: string
  count: number
  level: number
}

/**
 * GET /api/stats/home?range=: the home screen's stats card over every source AgentHydra counts (owner,
 * 2026-10-04: "the overview screen needs to display full consolidated stats from all sources"). From
 * AgentHydra's spend and activity reports, CliMayte's totals and HSwarm's stats; a part that failed is
 * null and named in `missing`, never 0.
 */
export interface HomeStats {
  range: HomeStatsRange
  sessions: number
  /** Model turns. */
  messages: number
  /** `input` is uncached input; total = input + cacheRead + cacheWrite + output. */
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; total: number }
  /** At API rates; null when AgentHydra could not price it. */
  costUsd: number | null
  /** `costUsd` at the owner's bulk rate; null when no routing discount is set or it is unpriced. */
  costAtRateUsd?: number | null
  /** The date the prices behind `costUsd` were last known good. */
  pricesAsOf: string | null
  activeDays: number
  /** The busiest hour of the day, '1 PM' (the PC's local time); null when the activity report is missing or quiet. */
  peakHour: string | null
  /** The raw model id with the most sessions ('claude-opus-5-5'). */
  favoriteModel: string | null
  /** Engaged agent time; null when the activity report is missing. */
  agentMinutes: number | null
  /** 27 weeks x 7 days, oldest first, ending today: the card's activity grid; `count` is model turns. */
  heat: HeatCell[]
  /** Most tokens first. */
  sources: HomeStatsSource[]
  /** Raw model ids, most sessions first. */
  models: { key: string; sessions: number }[]
  climayte: { tasks: number; sessions: number; costUsd: number; limitHits: number } | null
  /** For the range; savedUsd null when HSwarm priced none of its tasks. */
  hswarm: { tasks: number; savedUsd: number | null } | null
  /** How much of the store AgentHydra has read: while `refreshing` the figures still grow. */
  coverage: { sessions: number; total: number; refreshing: boolean }
  missing: HomeStatsMissing[]
}

/**
 * GET /api/projects: the New screen's project grid (owner, 2026-10-08: "I click New Chat, and rather than seeing this
 * overview and models, I see all my projects"). Project Hydra's projects placed on this PC when it is installed, plus
 * the folders this app's chats and Recent list use, each with its git state read on this PC (never fetched).
 */
export interface ProjectGit {
  branch: string | null
  /** The branch it tracks, e.g. 'origin/main'; null when it tracks nothing. */
  upstream: string | null
  ahead: number
  behind: number
  /** Changed and untracked files. */
  dirty: number
  /** When the checkout last fetched (ISO); `behind` is only as fresh as this. */
  fetchedAt: string | null
}

export type ProjectSource = 'projecthydra' | 'chats' | 'recent' | 'added' | 'folder'

/** The folder choices the New screen's grid is built from (DeskSettings' lists, as the server keeps them). */
export interface ProjectChoices {
  folders: string[]
  roots: string[]
  hidden: string[]
  pinned: string[]
}

export type ProjectChoiceKind = keyof ProjectChoices

export interface ProjectEntry {
  path: string
  name: string
  /** Project Hydra's group, e.g. 'lunarwerx'. */
  group: string | null
  /** A URL the page can load (Project Hydra's logo), or null for the folder glyph. */
  icon: string | null
  sources: ProjectSource[]
  /** Taken off the New screen with Hide. Listed only by GET /api/projects?hidden=1 (Show hidden projects). */
  hidden: boolean
  /** Pinned to the top of the grid with Pin to top (owner, 2026-10-13: "right-click on one to favorite it or pin it"). */
  pinned: boolean
  /** null when the folder is not a git checkout. */
  git: ProjectGit | null
  lastCommitAt: string | null
  lastChatAt: string | null
  /** Its chats not archived: this app's and the ones run elsewhere on this PC. A chat started in a folder that holds
   * projects counts for the one it worked in. */
  openChats: number
}

export interface ProjectsResponse {
  /** The pinned ones first, in the order they were pinned; then the ones with open chats, then newest of lastChatAt
   * and lastCommitAt first. */
  projects: ProjectEntry[]
  /** `found` false: Project Hydra is not installed here. `problem`: it is, but could not be read. */
  hydra: { found: boolean; root: string | null; placed: number; problem: string | null }
  choices: ProjectChoices
  /** Project Hydra's answer or a listed checkout's git state is stale and being read again behind this answer;
   * GET /api/projects?wait=1 answers once it is done. */
  pending: boolean
}

/** A project group header's read-only stats (GET /api/projects/stats?folder=). Each part is null when it cannot be read. */
export interface ProjectStats {
  /** The folder's git state, or null when it is not a checkout. `lastCommitAt` is an ISO time. */
  git: { branch: string | null; upstream: string | null; ahead: number; behind: number; dirty: number; lastCommitAt: string | null } | null
  /** Project Hydra is installed on this PC (its section shows only then). */
  hydra: boolean
  /** Project Hydra's read of this folder's project (`ph show <key> --json`): the last Architect run's error and warning
   * counts and when it ran, the risk score and the production cell ("7/10"). Null when it has none or cannot be read;
   * a part ph has not measured is null, never 0. */
  architect: { errors: number | null; warnings: number | null; lastRunAt: string | null; risk: number | null; production: string | null } | null
}

/** One chat of an auto-categorize proposal: the project its transcript says it worked in, or null when it stays. */
export interface PlacementProposal {
  kind: 'desk' | 'outside'
  id: string
  title: string
  project: { name: string; path: string } | null
  /** The sidebar group the chat would be put under (the project folder's name), or null when it stays. */
  group: string | null
  /** References to the project. */
  refs: number
  /** `winner`; `no references` or `tie` (the chat stays); `no transcript` (nothing to read, the chat stays). */
  reason: 'winner' | 'no references' | 'tie' | 'no transcript'
}

/** One placement to apply (POST /api/projects/placements). `group` null puts the chat back in its folder's group. */
export interface PlacementMove {
  kind: 'desk' | 'outside'
  id: string
  group: string | null
}
