// Pushback tracking (SPEC "Sus meter"): how often each Claude/Codex/ChatGPT setting declines, warns or asks
// "are you sure" on routine work. A finished turn is classified, counted per setting (service, model, effort) in
// <home>/pushback.json (temp file + rename, like chats.json), and the sus level reads the rates.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatServiceKind, TranscriptItem } from '@shared/protocol'
import { renameOver, writeFlushed } from '../write-flushed'

export type TurnClass = 'clean' | 'pushback' | 'refusal'

/** Settings with fewer classified turns than this are never picked by the sus level. */
export const SUS_MIN_TURNS = 20

const Q = "['\u2019]"

/**
 * What counts as a kickback, matched case-insensitively against a turn's closing text; each pattern has a short label
 * stored with the turn so the counts can be audited. Any kickback counts, not only hard declines: refusing, asking
 * permission or "are you sure" for routine work, warning about the owner's own keys, production or accounts, lecturing,
 * and doing less than asked while saying why. A plain technical caveat ("this will need a restart") matches nothing.
 */
export const PUSHBACK_PHRASES: readonly { label: string; re: RegExp }[] = [
  { label: "can't help", re: new RegExp(String.raw`\bI (?:can${Q}?t|cannot|can not|won${Q}t|will not|am unable to|${Q}m unable to|${Q}m not able to|am not able to) (?:help|assist|do that|do this|continue with|proceed with|comply|work on|touch|provide|share|write|run|execute)\b`, 'i') },
  { label: 'not comfortable', re: new RegExp(String.raw`\bI(?:${Q}m| am) not comfortable\b`, 'i') },
  { label: 'decline', re: new RegExp(String.raw`\bI (?:must|have to|need to|will|${Q}ll|would have to|${Q}d have to) (?:decline|refuse)\b|\bI${Q}m going to (?:decline|refrain|pass on)\b`, 'i') },
  { label: 'recommend against', re: new RegExp(String.raw`\bI${Q}d (?:strongly )?(?:recommend|advise|urge|suggest) (?:against|you not|not )|\bI (?:strongly )?(?:recommend|advise) against\b`, 'i') },
  { label: 'are you sure', re: /\bare you (?:absolutely |really |completely )?sure\b/i },
  { label: 'confirm first', re: new RegExp(String.raw`\b(?:before I (?:go ahead|proceed|continue|touch|change|run|do)|can you (?:please )?confirm|please confirm|do you want me to (?:go ahead|proceed)|shall I (?:go ahead|proceed)|want me to proceed|would you like me to proceed|let me know (?:if|before) (?:you(?:${Q}d like| want) me to|I (?:proceed|go ahead)))\b`, 'i') },
  { label: 'asks permission', re: /(?:with|need|require|without) your (?:explicit |express )?(?:permission|authori[sz]ation|approval|go-ahead)|I(?: would|'d| need to|) need (?:your )?(?:permission|authori[sz]ation|approval)/i },
  { label: 'own keys warning', re: /\b(?:api keys?|secrets?|passwords?|credentials?|tokens?|private keys?|ssh keys?)\b[^.\n]{0,80}\b(?:risky|unsafe|dangerous|not safe|security (?:risk|concern)|should (?:never|not) be shared|leak|exposed)\b/i },
  { label: 'prod warning', re: /\b(?:production|prod|live) (?:server|database|db|system|environment|account|data|site)s?\b[^.\n]{0,80}\b(?:risky|dangerous|too risky|be careful|extreme caution|proceed with caution|I(?:'|\u2019)d rather not|not going to|irreversible)\b/i },
  { label: 'safety lecture', re: /\b(?:for (?:security|safety) reasons|as a (?:security|safety) (?:best practice|precaution)|it(?:'|\u2019)s (?:important|worth noting) (?:to|that) (?:you )?(?:should )?(?:never|always)|security best practices? (?:say|suggest|recommend)|I want to (?:caution|warn|flag|emphasi[sz]e)|I(?:'|\u2019)d be remiss|a word of caution|I should (?:caution|warn|note that this could be (?:dangerous|harmful)))\b/i },
  { label: 'did less', re: new RegExp(String.raw`\b(?:instead of (?:doing|running|making) (?:that|this|it)|I (?:didn${Q}t|did not|haven${Q}t|have not|chose not to|decided not to|held off|stopped short|skipped|left out|only did part)\b[^.\n]{0,80}\b(?:because|since|as it|for safety|to be safe|for security|out of caution)|rather than (?:doing|running) (?:exactly )?(?:that|what you asked)|I(?:${Q}ve| have) (?:limited|restricted|scaled back) (?:this|it|my))`, 'i') },
]

/** refusal: the stop reason says so; pushback: the closing text matches a phrase (its label says which); else clean. */
export function classifyTurn(stopReason: string | null | undefined, text: string): { cls: TurnClass; label: string | null } {
  if (stopReason === 'refusal') return { cls: 'refusal', label: 'stop_reason refusal' }
  const t = text.trim()
  const hit = t ? PUSHBACK_PHRASES.find((p) => p.re.test(t)) : undefined
  return hit ? { cls: 'pushback', label: hit.label } : { cls: 'clean', label: null }
}

export interface SettingKey {
  service: ChatServiceKind
  model: string
  effort: string
}

export interface PushbackRow extends SettingKey {
  turns: number
  pushback: number
  refusals: number
  pushbackRate: number
}

interface Counts {
  turns: number
  pushback: number
  refusals: number
}

interface FileShape {
  v: 1
  settings: Record<string, SettingKey & Counts>
  /** Chats whose existing transcript the backfill counted already. */
  backfilled: string[]
  /** The turns counted by their own key (`recordOnce`), newest last: a reload or replay of one adds nothing. */
  counted?: string[]
  /** The newest classified turns that were not clean, with the phrase label that matched, for auditing the counts. */
  audit: AuditEntry[]
}

export interface AuditEntry {
  ts: number
  chat: string | null
  service: string
  model: string
  effort: string
  cls: TurnClass
  label: string | null
}

const AUDIT_MAX = 2000
const COUNTED_MAX = 5000

/** A worker chat's turn, by the id of its closing reply (else of its message): the same key live and in the backfill. */
export const workerTurnKey = (chatId: string, itemId: string): string => `worker:${chatId}:${itemId}`

const keyOf = (k: SettingKey): string => `${k.service}\u0000${k.model}\u0000${k.effort}`

export class PushbackStore {
  private data: FileShape = { v: 1, settings: {}, backfilled: [], audit: [] }
  private readonly path: string

  constructor(home: string) {
    this.path = join(home, 'pushback.json')
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileShape>
      if (raw && typeof raw === 'object' && raw.settings && typeof raw.settings === 'object') {
        this.data = {
          v: 1,
          settings: raw.settings,
          backfilled: Array.isArray(raw.backfilled) ? raw.backfilled : [],
          counted: Array.isArray(raw.counted) ? raw.counted : [],
          audit: Array.isArray(raw.audit) ? raw.audit : [],
        }
      }
    } catch {
      // No file yet, or an unreadable one: counting starts again.
    }
  }

  /** Counts one classified turn under the setting that ran it. */
  record(key: SettingKey, cls: TurnClass, audit?: { chat: string | null; label: string | null }, save = true): void {
    const k = keyOf(key)
    const row = (this.data.settings[k] ??= { service: key.service, model: key.model, effort: key.effort, turns: 0, pushback: 0, refusals: 0 })
    row.turns++
    if (cls === 'pushback') row.pushback++
    if (cls === 'refusal') row.refusals++
    if (cls !== 'clean') {
      this.data.audit.push({ ts: Date.now(), chat: audit?.chat ?? null, service: key.service, model: key.model, effort: key.effort, cls, label: audit?.label ?? null })
      if (this.data.audit.length > AUDIT_MAX) this.data.audit.splice(0, this.data.audit.length - AUDIT_MAX)
    }
    if (save) this.save()
  }

  /** Counts the turn `turn` names once; false when it was counted already. */
  recordOnce(turn: string, key: SettingKey, cls: TurnClass, audit?: { chat: string | null; label: string | null }, save = true): boolean {
    const counted = (this.data.counted ??= [])
    if (counted.includes(turn)) return false
    counted.push(turn)
    if (counted.length > COUNTED_MAX) counted.splice(0, counted.length - COUNTED_MAX)
    this.record(key, cls, audit, save)
    return true
  }

  rows(): PushbackRow[] {
    return Object.values(this.data.settings).map((r) => ({
      service: r.service,
      model: r.model,
      effort: r.effort,
      turns: r.turns,
      pushback: r.pushback,
      refusals: r.refusals,
      pushbackRate: r.turns ? r.pushback / r.turns : 0,
    }))
  }

  /**
   * The Claude setting with the lowest pushbackRate among those with at least `minTurns` classified turns
   * (ties: more turns, then the key). Refusals do not enter the ranking. Null when none qualifies.
   */
  pick(minTurns = SUS_MIN_TURNS): PushbackRow | null {
    const ok = this.rows().filter((r) => r.service === 'claude' && r.turns >= minTurns)
    ok.sort((a, b) => a.pushbackRate - b.pushbackRate || b.turns - a.turns || keyOf(a).localeCompare(keyOf(b)))
    return ok[0] ?? null
  }

  /**
   * Seeds the counts once from the transcripts of chats the Desk knows. `chats` lists each chat's id and its own
   * model/effort (a transcript does not say which setting ran a turn); a chat already counted is skipped, so a
   * second run adds nothing. A transcript has no stop reasons, so only pushback turns are found here. A worker
   * chat's transcript has no results: its turn ends at the next message, or at the end once it is not at work,
   * and is keyed as its live count is (`workerTurnKey`), so a turn counted live is not counted again.
   */
  backfill(chats: { id: string; model: string | null; effort: string | null; items: () => TranscriptItem[]; worker?: { busy: boolean } }[]): { chats: number; turns: number } {
    let n = 0
    let turns = 0
    const done = new Set(this.data.backfilled)
    for (const c of chats) {
      if (done.has(c.id)) continue
      const key: SettingKey = { service: 'claude', model: c.model ?? 'default', effort: c.effort ?? 'default' }
      let last: { id: string; text: string } | null = null
      let opened: string | null = null
      const count = (): void => {
        const v = classifyTurn(null, last?.text ?? '')
        const turn = last?.id ?? opened
        if (!c.worker) {
          this.record(key, v.cls, { chat: c.id, label: v.label }, false)
          turns++
        } else if (turn && this.recordOnce(workerTurnKey(c.id, turn), key, v.cls, { chat: c.id, label: v.label }, false)) turns++
        last = null
        opened = null
      }
      for (const i of c.items()) {
        if (i.kind === 'assistant_text') last = { id: i.id, text: i.text }
        else if (i.kind === 'result' && !c.worker) count()
        else if (i.kind === 'user' && c.worker && !i.queued) {
          if (opened || last) count()
          opened = i.id
        }
      }
      if (c.worker && !c.worker.busy && (opened || last)) count()
      this.data.backfilled.push(c.id)
      done.add(c.id)
      n++
    }
    if (n) this.save()
    return { chats: n, turns }
  }

  /** The recorded non-clean turns, newest last. */
  auditLog(): AuditEntry[] {
    return [...this.data.audit]
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFlushed(tmp, JSON.stringify(this.data))
    renameOver(tmp, this.path)
  }
}
