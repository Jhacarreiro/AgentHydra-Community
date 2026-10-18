import { contentWords, SYNONYMS, words } from '../mcp-find'
import type { CatalogEntry, Kind } from './catalog'
import { type Feedback, priorOf } from './feedback'

export interface FindOpts {
  kinds?: readonly Kind[]
  mode?: string
  /** Keep only these tiers, and rank the earlier ones first. */
  tiers?: readonly string[]
  start?: number
  limit?: number
  /** Drop CONTENT_STOP words from the need (filler such as what, into, every, its). */
  content?: boolean
  /** Leave the `how` line out of the score: it is one template shared by every person. */
  noHow?: boolean
  /** Keep only matches this strong, then rank by score before tier, so tier order only breaks ties. */
  min?: number
  /** The last feedback fold: each score is multiplied by the entry's prior (priorOf). */
  feedback?: Feedback | null
}

export interface Match {
  id: string
  kind: Kind
  name: string
  title?: string
  tier?: string
  family?: string
  when: string
  cost: string
  how: string
}

export const PAGE = 5

export function modesOf(e: CatalogEntry): string[] {
  return e.kind === 'person' ? (e.modes ?? []) : ['load']
}

/** Words a chat says about a look, mapped to the words the persona entries use, on top of the tool finder's
 *  SYNONYMS (2026-10-13: "redesign the pricing page" never reached Iris, whose entry says design, screen, ui). */
const CORE_SYNONYMS: Record<string, string[]> = {
  redesign: ['design', 'ui', 'screen'],
  restyle: ['design', 'visual', 'ui'],
  look: ['design', 'visual'],
  page: ['screen', 'layout', 'ui'],
  pages: ['screen', 'layout', 'ui'],
}

export function terms(need: string, content = false): Map<string, number> {
  const out = new Map<string, number>()
  for (const w of content ? contentWords(need) : words(need)) {
    out.set(w, 1)
    for (const s of [...(SYNONYMS[w] ?? []), ...(CORE_SYNONYMS[w] ?? [])])
      out.set(s, Math.max(out.get(s) ?? 0, 0.6))
  }
  return out
}

/** A word in the name weighs 5, in the title, tags or when 2, in the how 1; synonyms count at 0.6. */
export function scoreEntry(e: CatalogEntry, need: Map<string, number>, noHow = false): number {
  return detailOf(e, need, noHow).score
}

export interface Detail {
  score: number
  /** The need's own words (not synonyms) found in the entry's name, title, tags or when. */
  hits: string[]
  /** A word of the need is in the entry's name or title. */
  strong: boolean
}

export function detailOf(e: CatalogEntry, need: Map<string, number>, noHow = false): Detail {
  const name = new Set(words(e.name))
  const title = new Set(words(e.title ?? ''))
  const near = new Set(words([e.title ?? '', e.tags.join(' '), e.when].join(' ')))
  const how = new Set(noHow ? [] : words(e.how))
  let score = 0
  let strong = false
  const hits: string[] = []
  for (const [w, tw] of need) {
    if (name.has(w)) score += 5 * tw
    if (near.has(w)) score += 2 * tw
    if (how.has(w)) score += tw
    if (tw === 1 && (name.has(w) || near.has(w))) hits.push(w)
    if (tw === 1 && (name.has(w) || title.has(w))) strong = true
  }
  return { score, hits, strong }
}

export interface Scored {
  entry: CatalogEntry
  score: number
}

/** Every entry that matches the need, best first (tier rank, then score, then id); with feedback, scores carry the prior. */
export function rankEntries(
  entries: Iterable<CatalogEntry>,
  need: string,
  opts: FindOpts = {},
): Scored[] {
  const t = terms(need, opts.content)
  const scored: { entry: CatalogEntry; rank: number; score: number }[] = []
  if (t.size)
    for (const e of entries) {
      if (opts.kinds && !opts.kinds.includes(e.kind)) continue
      if (opts.mode && !modesOf(e).includes(opts.mode)) continue
      const rank = opts.tiers ? opts.tiers.indexOf(e.tier ?? '') : 0
      if (rank < 0) continue
      const score = scoreEntry(e, t, opts.noHow) * priorOf(opts.feedback ?? null, e)
      if (score > 0 && score >= (opts.min ?? 0)) scored.push({ entry: e, rank, score })
    }
  scored.sort((a, b) =>
    opts.min !== undefined
      ? b.score - a.score || a.rank - b.rank || a.entry.id.localeCompare(b.entry.id)
      : a.rank - b.rank || b.score - a.score || a.entry.id.localeCompare(b.entry.id),
  )
  return scored.map(({ entry, score }) => ({ entry, score }))
}

export function findPage(
  entries: Iterable<CatalogEntry>,
  need: string,
  opts: FindOpts = {},
): { ids: string[]; total: number } {
  const ranked = rankEntries(entries, need, opts)
  const start = opts.start ?? 0
  const limit = opts.limit ?? PAGE
  return { ids: ranked.slice(start, start + limit).map((s) => s.entry.id), total: ranked.length }
}

export function matchOf(e: CatalogEntry): Match {
  const m: Match = { id: e.id, kind: e.kind, name: e.name, when: e.when, cost: e.cost, how: e.how }
  if (e.title) m.title = e.title
  if (e.tier) m.tier = e.tier
  if (e.family) m.family = e.family
  return m
}
