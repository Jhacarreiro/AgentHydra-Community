import { type CatalogEntry, loadRef } from './catalog'

export interface HydraDoc {
  updated: string
  tier: string
  team: string
  lead: string | null
  under: string[]
  tools: string[]
  knowledge: string[]
  plan: string[]
  scopeLog: string[]
}

const HEAD = /^## (.+)$/
const HEADER = /^Updated: (\S+)\s+Tier: (\S+)\s+Team: (\S+)/
const LINE_ID =
  /^- (?:(?:consult|hire) )?((?:person|instrument|worker|knowledge|skill):[a-z0-9-]+) - /

export function emptyDoc(now: Date): HydraDoc {
  return {
    updated: now.toISOString(),
    tier: '-',
    team: '-',
    lead: null,
    under: [],
    tools: [],
    knowledge: [],
    plan: [],
    scopeLog: [],
  }
}

export function parseHydra(text: string): HydraDoc | null {
  if (!text.trim()) return null
  const doc = emptyDoc(new Date(0))
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const h = line.match(HEAD)
    if (h) {
      section = h[1]
      continue
    }
    if (!section) {
      const m = line.match(HEADER)
      if (m) {
        doc.updated = m[1]
        doc.tier = m[2]
        doc.team = m[3]
      }
      continue
    }
    if (!line.trim()) continue
    if (section.startsWith('Lead')) doc.lead ??= line
    else if (section === 'Under you') doc.under.push(line)
    else if (section === 'Tools') doc.tools.push(line)
    else if (section === 'Knowledge') doc.knowledge.push(line)
    else if (section === 'Plan') doc.plan.push(line)
    else if (section === 'Scope log') doc.scopeLog.push(line)
  }
  return doc
}

/** Scope-log lines a hydra.md keeps, newest last; nothing reads further back. */
const SCOPE_LOG_KEPT = 20

export function renderHydra(doc: HydraDoc): string {
  const lines = [
    '# hydra.md',
    `Updated: ${doc.updated}  Tier: ${doc.tier}  Team: ${doc.team}`,
    '## Lead (become)',
    ...(doc.lead ? [doc.lead] : []),
    '## Under you',
    ...doc.under,
    '## Tools',
    ...doc.tools,
    '## Knowledge',
    ...doc.knowledge,
    '## Plan',
    ...doc.plan,
    '## Scope log',
    ...doc.scopeLog.slice(-SCOPE_LOG_KEPT),
  ]
  return `${lines.join('\n')}\n`
}

export function leadLine(e: CatalogEntry): string {
  return `${e.name} - ${e.title ?? e.when}. Full text: ${loadRef(e)}`
}

export function leadName(doc: HydraDoc): string {
  return doc.lead ? (doc.lead.split(' - ')[0] ?? doc.lead) : 'none'
}

/** Adds an entry under the section its kind belongs to; returns its id when it was new, else null. */
export function addPick(doc: HydraDoc, e: CatalogEntry, mode?: 'consult' | 'hire'): string | null {
  const have = new Set(
    [...doc.under, ...doc.tools, ...doc.knowledge].map((l) => l.match(LINE_ID)?.[1] ?? ''),
  )
  if (have.has(e.id)) return null
  if (e.kind === 'person') doc.under.push(`- ${mode ?? 'consult'} ${e.id} - ${e.when}`)
  else if (e.kind === 'instrument' || e.kind === 'worker') doc.tools.push(`- ${e.id} - ${e.how}`)
  else doc.knowledge.push(`- ${e.id} - ${e.when}; ${loadRef(e)}`)
  return e.id
}

export function scopeLine(at: Date, msg: string, verdict: string, steps: string[]): string {
  return `- ${at.toISOString()} "${msg}" -> ${verdict} (${steps.join('; ')})`
}
