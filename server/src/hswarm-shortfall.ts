// The owner hears when the capacity that costs nothing extra ran short (2026-10-13: "if we had six more, this would
// have helped"). HSwarm's shortfall report (hswarm/shortfall.py, GET /api/shortfall on its console) counts the tasks
// the Free web accounts or CliMayte could have taken but found no account free for, so they went to a paid key, and
// how many more accounts of each kind would have taken them. It is read once an hour, and a notification goes out at
// most once a day, over the channels Settings -> Notifications has on (as incidents.ts delivers).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config'
import { sendOsNotification } from './notify-os'
import { getNotificationSettings, smtpPassword } from './notify-settings'
import { sendMail } from './notify-smtp'

/** One kind of account in a pool: how many more would have been worth having, and how many tasks they would have taken. */
export interface ShortfallKind {
  kind: string
  accounts: number | null
  served: number
  per_hour: number | null
  more: number | null
  would_take: number | null
}

export interface ShortfallPool {
  pool: string
  /** Tasks turned away for want of an account (the ones more accounts would have fixed). */
  turned_away: number
  /** The rest, by reason: a cap HSwarm set, signed-out accounts, a PC too busy to start a worker. */
  not_counted: Record<string, number>
  kinds: ShortfallKind[]
}

export interface ShortfallReport {
  days: number
  since: string
  pools: ShortfallPool[]
}

/** Fewer turn-aways than this in a day are noise, not a reason to add accounts. */
export const MIN_TURNED = 20
const CHECK_MS = 60 * 60 * 1000
const FIRST_CHECK_MS = 10 * 60 * 1000 // after a start, once HSwarm's sidecar is up
const QUIET_MS = 24 * 60 * 60 * 1000
const STATE_PATH = join(DATA_DIR, 'hswarm-shortfall.json')

const KIND_NAMES: Record<string, string> = {
  chatgpt: 'Free ChatGPT',
  claude: 'Free Claude',
  climayte: 'CliMayte',
}
const POOL_NAMES: Record<string, string> = { free: 'a Free account', climayte: 'CliMayte' }

const accountsOf = (k: ShortfallKind): string =>
  `${k.more} more ${KIND_NAMES[k.kind] ?? k.kind} account${k.more === 1 ? '' : 's'}`

/** The notification a report calls for, or null when no pool turned away MIN_TURNED tasks that more accounts would
 *  have taken. The title names the fewest accounts that would have helped; the body says what each kind would have done. */
export function shortfallMessage(report: ShortfallReport): { title: string; body: string } | null {
  const lines: string[] = []
  let title: string | null = null
  for (const pool of report.pools) {
    const kinds = pool.kinds
      .filter((k) => (k.more ?? 0) > 0 && (k.would_take ?? 0) > 0)
      .sort((a, b) => (a.more ?? 0) - (b.more ?? 0))
    if (pool.turned_away < MIN_TURNED || !kinds.length) continue
    const options = kinds.map((k) => `${accountsOf(k)} would have taken ${k.would_take}`)
    lines.push(
      `${pool.turned_away} tasks could have run on ${POOL_NAMES[pool.pool] ?? pool.pool} but found none free and went to a paid key; ${options.join(', or ')}.`,
    )
    title ??= `We would love ${accountsOf(kinds[0])}`
  }
  if (!title) return null
  return { title, body: `In the last ${Math.round(report.days * 24)} hours: ${lines.join(' ')}` }
}

export interface ShortfallDeps {
  /** The day's report, or null when HSwarm does not answer. */
  read: () => Promise<ShortfallReport | null>
  /** True when the message reached at least one channel. */
  send: (msg: { title: string; body: string }) => Promise<boolean>
}

function lastSent(): number {
  try {
    return Date.parse(
      (JSON.parse(readFileSync(STATE_PATH, 'utf8')) as { lastAt?: string }).lastAt ?? '',
    )
  } catch {
    return Number.NaN
  }
}

/** One check: nothing within a day of the last notification (a restart included); else the day's report, and a
 *  notification when it calls for one. True when one went out. */
export async function checkShortfall(
  deps: ShortfallDeps = liveDeps,
  now = Date.now(),
): Promise<boolean> {
  const last = lastSent()
  if (Number.isFinite(last) && now - last < QUIET_MS) return false
  const report = await deps.read().catch(() => null)
  const msg = report ? shortfallMessage(report) : null
  if (!msg || !(await deps.send(msg))) return false
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify({ lastAt: new Date(now).toISOString() }))
  } catch {
    // unwritten: the next check may say it again, which beats never saying it
  }
  return true
}

async function readReport(): Promise<ShortfallReport | null> {
  const { getHSwarmStatus, hswarmHome } = await import('./hswarm')
  const st = getHSwarmStatus()
  if (!st.running || !st.port) return null
  const headers: Record<string, string> = {}
  try {
    const token = readFileSync(join(hswarmHome(), 'console-token'), 'utf8').trim()
    if (token) headers['X-Hswarm-Token'] = token
  } catch {
    // no token file yet: ask without it
  }
  const r = await fetch(`http://127.0.0.1:${st.port}/api/shortfall?days=1`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  })
  return r.ok ? ((await r.json()) as ShortfallReport) : null
}

async function sendToOwner(msg: { title: string; body: string }): Promise<boolean> {
  const settings = getNotificationSettings()
  if (!settings.notifyEnabled) return false
  let ok = false
  if (settings.notifyDesktop) {
    ok = (await sendOsNotification({ title: msg.title, body: msg.body, sticky: false })).ok || ok
  }
  if (settings.notifyEmail && settings.notifySmtpHost && settings.notifyEmailTo) {
    const r = await sendMail(
      {
        host: settings.notifySmtpHost,
        port: settings.notifySmtpPort,
        secure: settings.notifySmtpSecure,
        user: settings.notifySmtpUser,
        pass: smtpPassword(),
      },
      {
        from: settings.notifyEmailFrom || settings.notifySmtpUser || settings.notifyEmailTo,
        to: settings.notifyEmailTo,
        subject: msg.title,
        text: `${msg.body}\n\n— AgentHydra`,
      },
    )
    ok = r.ok || ok
  }
  return ok
}

const liveDeps: ShortfallDeps = { read: readReport, send: sendToOwner }

let timer: ReturnType<typeof setInterval> | null = null

/** Check once FIRST_CHECK_MS after the start, then hourly. Idempotent. */
export function startShortfallWatch(): void {
  if (timer) return
  // checkShortfall handles a silent HSwarm and a failed channel itself: anything reaching here is a bug, so it is logged.
  const tick = () =>
    void checkShortfall().catch((err) => console.warn('[hswarm-shortfall] check failed:', err))
  setTimeout(tick, FIRST_CHECK_MS).unref?.()
  timer = setInterval(tick, CHECK_MS)
  timer.unref?.()
}
