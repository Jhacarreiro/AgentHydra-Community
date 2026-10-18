// The core's accounts (core/README.md, "Account"): every login the owner has, read over HTTP from the
// running services and cached for 30 s. Account.home is the Claude config dir, the Codex CODEX_HOME, or
// the Free instance id. Read-only: nothing here starts, stops or signs in an account.
import type { Account, Accounts, Service } from './types'

const DAEMON = process.env.DAEMON_URL ?? 'http://127.0.0.1:7787'
const DESK = process.env.DESK_URL ?? 'http://127.0.0.1:7798'
const TTL_MS = 30_000
/** An account at 90% or more of its tighter window is never picked: room must be above this. */
const MIN_ROOM = 10
const NAME: Record<Service, string> = { claude: 'Claude', codex: 'Codex', chatgpt: 'ChatGPT' }

/** GET /api/cli-instances rows (server/src/instance-mode.ts). */
interface CliRow {
  id: string
  num?: number
  name?: string
  configDir: string
  loggedIn: boolean
  /** Someone else is on it now (the daemon's accountInUse, the same one CliMayte judges with). */
  inUse?: boolean
}

/** GET /api/codex-instances rows (server/src/instance-mode.ts). */
interface CodexRow {
  id: string
  num?: number
  name?: string
  codexHome: string
  loggedIn?: boolean
  /** The Codex app is open on this login: Desk's pick (pickCodexAccount) takes one whose app is closed first. */
  isDesktopRunning?: boolean
}

/** GET /api/free/status: `instances` and `jobs` (desk2/server/src/free-instances/service.ts, status()). */
interface FreeRow {
  id: string
  num: number
  name: string
  provider: string
  loggedIn: boolean
  lastActiveAt?: number | null
  usage?: { unlimited_text?: boolean } | null
}

interface FreeJob {
  instanceId: string
  state: string
  auto?: boolean
}

/** Percent used of each window; null or undefined when not read. */
interface Used {
  session?: number | null
  week?: number | null
}

let cache: { at: number; pools: Record<Service, Account[]> } | null = null
let inflight: Promise<Record<Service, Account[]>> | null = null
const holds = new Map<string, number>()
/** When this core last picked each account: picks go round the accounts, so turns started together do not all land on
 *  one login (2026-10-14: the probe's parallel Codex chats all took the emptiest account and it answered 429). */
const lastPicked = new Map<string, number>()
/** Codex logins whose app is open now (the last read). */
const desktopOpen = new Set<string>()

async function get<T>(base: string, path: string): Promise<T> {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`${path} answered ${res.status}`)
  return (await res.json()) as T
}

/** Each account's last reading: a read that fails or times out keeps the one before it. */
const lastUsed = new Map<string, Used>()

/** The room left: 100 minus the higher of the two windows' use. An account never read counts as half full, as Desk's
 *  pick does (2026-10-14: counted as full, every Codex login whose read timed out under load was skipped, and the
 *  probe's Codex chats got "No Codex account has room now"). */
function roomOf(used: Used | null): number {
  const pcts = [used?.session, used?.week].filter((p): p is number => typeof p === 'number')
  return pcts.length ? Math.max(0, 100 - Math.max(...pcts)) : 50
}

/** "#<num> <name>", never an email: a name holding an @ falls back to the service's name. */
function labelOf(num: number | undefined, name: string | undefined, fallback: string): string {
  const shown = name && !name.includes('@') ? name : fallback
  return typeof num === 'number' ? `#${num} ${shown}` : shown
}

function account(
  service: Service,
  id: string,
  home: string,
  label: string,
  used: Used | null,
): Account {
  return { id, service, label, home, room: roomOf(used) }
}

async function usageOf(id: string, path: string): Promise<Used | null> {
  try {
    const res = await get<{
      snapshot?: { session?: { pct?: number } | null; weekAll?: { pct?: number } | null } | null
    }>(DAEMON, path)
    const used = { session: res.snapshot?.session?.pct, week: res.snapshot?.weekAll?.pct }
    if (typeof used.session === 'number' || typeof used.week === 'number') lastUsed.set(id, used)
  } catch {}
  return lastUsed.get(id) ?? null
}

async function claudeAccounts(): Promise<Account[]> {
  const live = (await get<CliRow[]>(DAEMON, '/api/cli-instances')).filter(
    (row) => row.loggedIn && row.inUse !== true,
  )
  const used = await Promise.all(
    live.map((row) =>
      usageOf(row.id, `/api/usage?instance=${encodeURIComponent(String(row.num ?? row.id))}`),
    ),
  )
  return live.map((row, i) =>
    account('claude', row.id, row.configDir, labelOf(row.num, row.name, 'Claude'), used[i]),
  )
}

async function codexAccounts(): Promise<Account[]> {
  const live = (await get<CodexRow[]>(DAEMON, '/api/codex-instances')).filter((row) => row.loggedIn)
  desktopOpen.clear()
  for (const row of live) if (row.isDesktopRunning) desktopOpen.add(row.id)
  const used = await Promise.all(
    live.map((row) => usageOf(row.id, `/api/codex-instances/${encodeURIComponent(row.id)}/usage`)),
  )
  return live.map((row, i) =>
    account('codex', row.id, row.codexHome, labelOf(row.num, row.name, 'Codex'), used[i]),
  )
}

/** What Desk's ChatGPT pick sorts by, per signed-in account, from the last read (chatgptOrder). */
const chatgptRows = new Map<string, { busy: boolean; unlimited: boolean; lastActiveAt: number }>()

async function chatgptAccounts(): Promise<Account[]> {
  const { instances, jobs } = await get<{ instances: FreeRow[]; jobs: FreeJob[] }>(
    DESK,
    '/api/free/status',
  )
  const busy = new Set(
    jobs.filter((job) => job.state === 'running' && !job.auto).map((job) => job.instanceId),
  )
  const signedIn = instances.filter((row) => row.provider === 'chatgpt' && row.loggedIn)
  chatgptRows.clear()
  return signedIn.map((row): Account => {
    chatgptRows.set(row.id, {
      busy: busy.has(row.id),
      unlimited: row.usage?.unlimited_text === true,
      lastActiveAt: row.lastActiveAt ?? 0,
    })
    // Desk's pick reads no usage window, so a signed-in account has full room; chatgptOrder decides the pick.
    return {
      ...account('chatgpt', row.id, row.id, labelOf(row.num, row.name, 'ChatGPT'), null),
      room: 100,
    }
  })
}

/** Desk's pickChatgptAccount order (desk2/server/src/engine/chatgpt/runtime.ts): an account no person's operation
 *  runs on first, then one with unlimited text, then the one used longest ago (never used counts as 0). */
function chatgptOrder(x: Account, y: Account): number {
  const none = { busy: false, unlimited: false, lastActiveAt: 0 }
  const a = chatgptRows.get(x.id) ?? none
  const b = chatgptRows.get(y.id) ?? none
  return (
    Number(a.busy) - Number(b.busy) ||
    Number(b.unlimited) - Number(a.unlimited) ||
    picked(x) - picked(y) ||
    a.lastActiveAt - b.lastActiveAt
  )
}

const picked = (a: Account): number => lastPicked.get(a.id) ?? 0

/** Claude and Codex: a Codex login whose app is closed first, then the one this core picked longest ago, then the
 *  emptiest. */
function agentOrder(x: Account, y: Account): number {
  return (
    Number(desktopOpen.has(x.id)) - Number(desktopOpen.has(y.id)) ||
    picked(x) - picked(y) ||
    y.room - x.room
  )
}

/** One service's accounts. A service whose listing fails has none this round: nothing is picked from it. */
async function settle(service: Service, read: () => Promise<Account[]>): Promise<Account[]> {
  try {
    return await read()
  } catch (err) {
    console.warn(
      `[core:accounts] ${NAME[service]} accounts could not be read: ${(err as Error).message}`,
    )
    return []
  }
}

async function load(): Promise<Record<Service, Account[]>> {
  const [claude, codex, chatgpt] = await Promise.all([
    settle('claude', claudeAccounts),
    settle('codex', codexAccounts),
    settle('chatgpt', chatgptAccounts),
  ])
  const pools = { claude, codex, chatgpt }
  cache = { at: Date.now(), pools }
  return pools
}

/** The pools, from the cache while it is under 30 s old; one read at a time. */
async function current(): Promise<Record<Service, Account[]>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.pools
  inflight ??= load().finally(() => {
    inflight = null
  })
  return inflight
}

export function accounts(): Accounts {
  return {
    async pick(service, avoid) {
      const now = Date.now()
      const free = (await current())[service].filter(
        (a) => !avoid.has(a.id) && (holds.get(a.id) ?? 0) <= now,
      )
      const [best] =
        service === 'chatgpt'
          ? free.sort(chatgptOrder)
          : free.filter((a) => a.room > MIN_ROOM).sort(agentOrder)
      if (!best) {
        // Why each was passed over, for the core's log: the chat says only that none had room.
        const all = (await current())[service]
        console.warn(
          `[core:accounts] no ${service}: ${
            all
              .map(
                (a) =>
                  `${a.id.slice(0, 8)} ${avoid.has(a.id) ? 'tried' : (holds.get(a.id) ?? 0) > now ? 'held' : `room ${a.room}`}`,
              )
              .join(', ') || 'none listed'
          }`,
        )
        return { why: `No ${NAME[service]} account has room now.` }
      }
      lastPicked.set(best.id, now)
      return best
    },
    async find(service, id) {
      return (await current())[service].find((a) => a.id === id) ?? null
    },
    async list() {
      return Object.values(await current()).flat()
    },
    hold(id, until) {
      holds.set(id, until)
    },
  }
}
