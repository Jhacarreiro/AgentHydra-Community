// The contract between the core's parts (README: A + B = C). A chat's record and its items are Desk 2's own types
// (desk2/shared/protocol.ts), so the window and the smoke probe read the core as they read Desk.
import type {
  ChatSummary,
  ExternalSession,
  ServiceThread,
  TranscriptItem,
} from '../../desk2/shared/protocol'

export type { ChatSummary, ExternalSession, ServiceThread, TranscriptItem }

/** What runs a turn. */
export type Service = 'claude' | 'codex' | 'chatgpt'

/** A: one login, with the room it has left. */
export interface Account {
  id: string
  service: Service
  /** What the owner calls it ("#7 alpha"): never an email. */
  label: string
  /** Claude: its config dir. Codex: its CODEX_HOME. ChatGPT: the Free instance id. */
  home: string
  /** Percent left of the tighter of its windows (5-hour, weekly), 0 to 100. */
  room: number
}

export interface Image {
  mediaType: string
  dataBase64: string
  name?: string
}

/** B: one message, for the service the chat runs on now. */
export interface Task {
  chatId: string
  cwd: string
  title: string
  text: string
  images?: Image[]
  /** The chat's thread on this service when it has one: a Claude session, a Codex thread, a ChatGPT chat. */
  thread?: ServiceThread
  permissionMode: string
  model: string | null
}

/** What a turn says while it runs. */
export interface TurnSink {
  /** A transcript item, new or updated under the same id. Never a user or result item: the chat writes those. */
  item(item: TranscriptItem): void
  /** The turn is bound to this thread: a new one, or the task's own. */
  thread(t: ServiceThread): void
  /** The chat's activity line ("Thinking", "Running git status"). */
  activity(text: string): void
}

export interface TurnEnd {
  ok: boolean
  /** The sentence the chat shows as the turn's error: 'Interrupted' when it was stopped. */
  error?: string
  durationMs?: number
  /** The account ran into a usage limit: held until then (epoch ms), and the message goes on another account. */
  limitedUntil?: number
  /** The provider is throttling this account for now (a 429): this message goes on another account, and the account is
   *  not held, since a hold on every throttled login left none to pick (2026-10-14, probe round 4). */
  throttled?: boolean
}

export interface Turn {
  done: Promise<TurnEnd>
  interrupt(): void
}

/** C: runs one turn of a task on one account of its service. */
export interface Backend {
  service: Service
  start(task: Task, account: Account, sink: TurnSink): Turn
  /** Lets go of everything held for the chat (an app-server, a thread): the chat was deleted. */
  release(chatId: string): Promise<void>
}

/** Every account, who has room for a service, and the one a thread lives on. */
export interface Accounts {
  pick(service: Service, avoid: ReadonlySet<string>): Promise<Account | { why: string }>
  find(service: Service, id: string): Promise<Account | null>
  /** The account ran into a limit: no picks until `until` (epoch ms). */
  hold(id: string, until: number): void
  /** Every account of every service as it reads now (the usage tool). */
  list(): Promise<Account[]>
}

/** A page of an outside chat's transcript, and the `before` that reads the page above it (null at the start). */
export interface Page {
  items: TranscriptItem[]
  olderBefore: number | null
}

/** Outside chats (Claude sessions on disk, Codex threads), read where they are, never copied. */
export interface History {
  list(): Promise<ExternalSession[]>
  find(id: string): Promise<ExternalSession | null>
  tail(id: string): Promise<Page | null>
  older(id: string, before: number): Promise<Page | null>
}
