// The instance manager (owner, 2026-10-15: "if it notices a desktop instance close, it should start the next
// available desktop instance with room ... migrate the threads, confirm they're migrated and moved over ... and then
// go back to babysitting"). Every EVERY_MS it looks at every Claude Desktop and Codex Desktop app AgentHydra manages
// and remembers which chats each one was running. When an app that was up goes down (it closed, or its account was
// signed out, ran out of plan or had its organization disabled) while chats were working in it, it picks the
// same-kind account with the most room (a Claude chat goes to a Claude app, a Codex chat to a Codex app), opens that
// app if it is closed, moves the chats there through AgentHydra's own move, confirms they landed, and starts each one
// again with a note saying why. A chat that only ever ran in AgentHydra's own window is not its business: nothing is
// opened for it. The server keeps it (server/src/plugins/74-instance-manager.ts, deciding in
// server/src/instance-manager/); GET /api/instance-manager answers what it saw last and Settings > Managers draws it.
// Plain types only.

/** How often it looks. A look is two local reads of AgentHydra (about 0.2 s). */
export const INSTANCE_MANAGER_EVERY_MS = 20_000

/** Who its messages are from: the text a moved chat is started again with opens with this. */
export const INSTANCE_MANAGER_FROM = 'AgentHydra · instance manager'

/** Which app an instance is. */
export type ManagedKind = 'desktop' | 'codex'

/**
 * Why an app went down, as far as its own log, its sign-in and its account say:
 * logged-out    the account was signed out (the app's sign-in is gone, or its log says so)
 * account-dead  the account answers, but no longer works: its plan ended or its organization was disabled
 * crashed       the app died without quitting: no quit in its log
 * quit          the app quit cleanly with its account still fine: a person, most likely, so the chats stay
 * unknown       nothing said (a Codex app keeps no log the manager reads): it may be a person's close, so the chats stay
 */
export type DownCause = 'logged-out' | 'account-dead' | 'crashed' | 'quit' | 'unknown'

/** One app as the last look saw it. */
export interface ManagedInstance {
  ref: string // desktop:<profile dir> or codex:<id>
  kind: ManagedKind
  num: number
  name: string
  plan: string | null
  running: boolean
  signedIn: boolean
  /** Chats working in it at the last look. */
  working: number
  /** When it was last seen running and signed in, ms; null when never. */
  lastUpAt: number | null
}

/**
 * Where a recovery stands:
 * waiting     the app went down; it is given a moment to come back by itself (an update restarts it)
 * came-back   it came back by itself: nothing was moved
 * left        it went down in a way that is not the manager's to undo (a clean quit, several apps at once): said, not acted on
 * opening     the account chosen to take the chats is being opened
 * moving      AgentHydra is moving the chats
 * watching    the chats landed and were started again; it watches that they really run
 * done        every chat runs again (or each one's own line says why not)
 * failed      it could not finish: no account had room, the app did not open, or the move was refused
 */
export type RecoveryState = 'waiting' | 'came-back' | 'left' | 'opening' | 'moving' | 'watching' | 'done' | 'failed'

/**
 * Where one chat of a recovery stands:
 * pending   not moved yet
 * moved     landed in the new app; not yet seen running
 * running   seen working (or newly active) in the new app
 * stuck     landed, but not seen running after the watch window: a person should look
 * failed    the move refused or did not land
 */
export type RecoveredChatState = 'pending' | 'moved' | 'running' | 'stuck' | 'failed'

export interface RecoveredChat {
  id: string // the Claude session id, or the Codex thread id
  title: string
  state: RecoveredChatState
  detail: string
}

export interface Recovery {
  id: string
  kind: ManagedKind
  /** The app that went down. */
  from: { ref: string; num: number; name: string }
  /** The app the chats went to; null until one is chosen. */
  to: { ref: string; num: number; name: string; opened: boolean } | null
  cause: DownCause
  causeDetail: string
  state: RecoveryState
  detail: string
  /** When the app was seen down, ms. */
  at: number
  /** When it last changed, ms. */
  updatedAt: number
  chats: RecoveredChat[]
}

/** GET /api/instance-manager. */
export interface InstanceManagerStatus {
  enabled: boolean
  everyMs: number
  checkedAt: number | null
  nextCheckAt: number | null
  /** Every app it watches, Claude Desktop first, then Codex, by number. */
  instances: ManagedInstance[]
  /** Its recoveries, newest first. */
  recoveries: Recovery[]
  /** Why the last look saw less than everything (AgentHydra did not answer), or null. */
  error: string | null
}

/** POST /api/instance-manager: turn it on or off (saved in Settings), and/or look now. */
export interface InstanceManagerRequest {
  enabled?: boolean
  check?: boolean
}
