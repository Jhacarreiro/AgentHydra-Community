// The All tab's one ranking across the kinds. Owner, 2026-10-10: "for the All tab in instances, I would
// like the desktop, CLI and free combined into a single table. Which then just indicates whether or not
// they are CLI, desktop, or free, but sorted by tokens, so I can see how they rank among each other."
//
// Each source (Claude, Codex and DeepSeek desktop rows; CLI; Free) keeps its own rows and components,
// and reports the sort values of every visible row, for every sortable column (useMergedOrderSource).
// The provider sorts those reports together with the same useSortable the tables use, under the same
// persisted header sort, so missing values still sort last, ties keep the source order, and the order
// settles the same way. Each row then gets its place as `order` in the one grid InstanceTable lays out
// in merged mode (components/InstanceTable.vue). It is on only while the All tab shows more than one
// kind; a source's report is dropped when it unmounts or the tab leaves All.
import {
  computed,
  type ComputedRef,
  type CSSProperties,
  inject,
  type InjectionKey,
  onScopeDispose,
  provide,
  shallowRef,
  triggerRef,
  watchEffect,
} from 'vue'
import { type PersistedSort, type SortableColumn, useSortable } from '@/composables/useSortable'

export type MergedSource = 'claude' | 'codex' | 'dsh' | 'cli' | 'free'
type MergedValue = string | number | boolean | null | undefined
interface MergedReport {
  /** Identifies the row within its source. */
  key: string
  /** The row's sort value for every sortable column key. */
  values: Record<string, MergedValue>
  /** The row this one is counted on (`${source}:${key}`), when that row is ranked too: see MergedEntry. */
  countedOn?: string
}

interface MergedEntry {
  /** `${source}:${key}`: one row across every source. */
  id: string
  values: Record<string, MergedValue>
  /** A row counted on another (a linked CLI login on its Desktop row, the same account signed in twice,
   *  owner 2026-10-10) is not ranked itself: it takes its place in the ranking, right after it. */
  countedOn?: string
}

/** The order a tie keeps: today's blocks, Claude first. */
const SOURCE_ORDER: MergedSource[] = ['claude', 'codex', 'dsh', 'cli', 'free']

export interface MergedOrderContext {
  /** Whether the All tab ranks its rows together (more than one kind is shown). */
  active: ComputedRef<boolean>
  /** Replaces one source's visible rows. */
  report: (source: MergedSource, rows: MergedReport[]) => void
  /** Drops one source's rows. */
  clear: (source: MergedSource) => void
  /** A row's place in the one ranking, or undefined while it is not ranked. */
  rank: (source: MergedSource, key: string) => number | undefined
  /** Whether a row is in the ranking now (shown, not filtered out): a row counted on it says so only then. */
  ranked: (source: MergedSource, key: string) => boolean
}

export const MERGED_ORDER: InjectionKey<MergedOrderContext> = Symbol('merged-order')

/**
 * Provide the ranking to the sources below (InstancesView). `keys` is every column the ranking sorts by,
 * and `persisted` is the header's own remembered sort, so the merged order follows the one header.
 */
export function provideMergedOrder(opts: {
  active: ComputedRef<boolean>
  keys: readonly string[]
  persisted: PersistedSort
}): MergedOrderContext {
  // Not reactive on purpose: a source's watcher reports from inside its own effect, and a reactive
  // map read there would re-run that effect. `changed` is the one signal, poked by triggerRef.
  const reports = new Map<MergedSource, MergedReport[]>()
  const changed = shallowRef(0)

  const entries = computed<MergedEntry[]>(() => {
    changed.value
    if (!opts.active.value) return []
    return SOURCE_ORDER.flatMap((source) =>
      (reports.get(source) ?? []).map((row) => ({
        id: `${source}:${row.key}`,
        values: row.values,
        countedOn: row.countedOn,
      })),
    )
  })
  const present = computed(() => new Set(entries.value.map((row) => row.id)))
  // A counted row is left out of the sort when the row it is counted on is ranked, so it has no sort value; with
  // that row filtered out it ranks on its own, figure and all.
  const rows = computed(() => entries.value.filter((row) => !(row.countedOn && present.value.has(row.countedOn))))
  const columns: SortableColumn<MergedEntry>[] = opts.keys.map((key) => ({
    key,
    accessor: (row) => row.values[key],
  }))
  const { sortedRows } = useSortable(() => rows.value, columns, opts.persisted, {
    rowKey: (row) => row.id,
  })
  const ranks = computed(() => {
    const map = new Map(sortedRows.value.map((row, index) => [row.id, index]))
    for (const row of entries.value) {
      const at = row.countedOn ? map.get(row.countedOn) : undefined
      if (at !== undefined) map.set(row.id, at)
    }
    return map
  })

  const ctx: MergedOrderContext = {
    active: opts.active,
    report: (source, list) => {
      reports.set(source, list)
      triggerRef(changed)
    },
    clear: (source) => {
      if (reports.delete(source)) triggerRef(changed)
    },
    rank: (source, key) => ranks.value.get(`${source}:${key}`),
    ranked: (source, key) => present.value.has(`${source}:${key}`),
  }
  provide(MERGED_ORDER, ctx)
  return ctx
}

/**
 * A source's side of the ranking: its visible rows and their sort values, reported while the All tab
 * ranks them. Returns `orderStyle`, which a row's root takes as its style: `order` is its rank, and
 * undefined when the rows are not ranked together (every tab but All, or no provider above).
 */
export function useMergedOrderSource<Row>(
  source: MergedSource,
  opts: {
    rows: () => readonly Row[]
    rowKey: (row: Row) => string
    values: (row: Row) => Record<string, MergedValue>
    /** The row this one is counted on, when it is another source's row (a linked CLI login on its Desktop
     *  row): it then takes that row's place instead of ranking on its own (MergedEntry.countedOn). */
    countedOn?: (row: Row) => { source: MergedSource; key: string } | undefined
    /** The provider when it is the calling component itself (InstancesView's own Claude rows), which
     *  cannot inject what it provides. Other sources inject it. */
    ctx?: MergedOrderContext
  },
) {
  const ctx = opts.ctx ?? inject(MERGED_ORDER, null)
  if (ctx) {
    watchEffect(() => {
      if (!ctx.active.value) {
        ctx.clear(source)
        return
      }
      ctx.report(
        source,
        opts.rows().map((row) => {
          const on = opts.countedOn?.(row)
          return {
            key: opts.rowKey(row),
            values: opts.values(row),
            countedOn: on && `${on.source}:${on.key}`,
          }
        }),
      )
    })
    onScopeDispose(() => ctx.clear(source))
  }
  return {
    orderStyle: (row: Row): CSSProperties | undefined => {
      if (!ctx?.active.value) return undefined
      const rank = ctx.rank(source, opts.rowKey(row))
      return rank === undefined ? undefined : { order: rank }
    },
  }
}
