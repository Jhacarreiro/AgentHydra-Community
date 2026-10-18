<script setup lang="ts">
// The one instance table: every kind's Instances table (Claude desktop with its Codex and DeepSeek
// rows, the CLI logins) draws its header, first-load skeleton and empty state here, from a list of
// column definitions (lib/instance-table.ts). The default slot is the table's bodies: one <tbody> of
// InstanceRow per provider, so a kind differs only in the columns it lists and the rows it hands over.
// The skeleton stands in for a provider's rows only while they load; the other bodies stay drawn.
//
// `widths` holds a column at one width from the first paint. The table lays out by content, so a
// column whose cells fill in as the stats load (a "—" that becomes a chip and a bar, a spinner
// beside a number) used to widen as each one landed and every other column snapped sideways with
// it (owner, 2026-10-04). A width is a floor sized for the column's final content and its header:
// Name still takes the rest, and a cell that somehow outgrows it widens the column, never spills.
import { computed, type Component } from 'vue'
import SortButton from '@/components/SortButton.vue'
import { Skeleton } from '@/components/ui/skeleton'
import type { TableVariants } from '@/components/ui/table'
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { SortDirection } from '@/composables/useSortable'
import type { InstanceColumn, InstanceColumnKey } from '@/lib/instance-table'
import { useTooltipConfig } from '@/lib/tooltip-config'
import InfoHint from '@/shell/InfoHint.vue'

const props = withDefaults(
  defineProps<{
    columns: InstanceColumn[]
    indicatorFor: (key: string) => SortDirection
    density?: TableVariants['density']
    /** Draw first-load skeleton rows instead of the bodies. */
    skeleton?: boolean
    skeletonRows?: number
    /** Drawn after the bodies when there is nothing to list (or the filter took every row). */
    empty?: { icon: Component; title: string; hint: string } | null
    /** A CSS width per column key, padding included; a column left out sizes to its content. */
    widths?: Partial<Record<InstanceColumnKey, string>>
    /** One ranking across the bodies (the All tab, composables/useMergedOrder.ts): every row takes its
     *  place from its `order`, whichever body it is in. */
    merged?: boolean
  }>(),
  { skeletonRows: 3, empty: null, widths: undefined, merged: false },
)
const emit = defineEmits<{ sort: [key: string] }>()
const { enabled: tooltipsEnabled } = useTooltipConfig()

// Merged mode is a grid, not a table. A table lays each <tbody> out as its own block, so the rows of
// two bodies can never interleave, and a ranking across the kinds needs exactly that. So the table is
// one grid of the same columns: every body is display:contents, every row a grid item spanning the
// tracks (subgrid, so its cells line up with the header), and each row's `order` (InstanceRow's style)
// is its rank. The header is order -1, and the skeleton and empty bodies sit after every row.
// Tracks: Name takes what is left, every other column its content (see the grid's columns below).
const MERGED_TABLE = [
  'grid [grid-template-columns:var(--merged-cols)]',
  '[&>thead]:col-span-full [&>thead]:grid [&>thead]:[grid-template-columns:subgrid] [&>thead]:[order:-1]',
  '[&>thead>tr]:col-span-full [&>thead>tr]:grid [&>thead>tr]:[grid-template-columns:subgrid]',
  '[&>tbody]:contents',
  '[&_tbody>tr]:col-span-full [&_tbody>tr]:grid [&_tbody>tr]:[grid-template-columns:subgrid] [&_tbody>tr]:items-center',
  // A table cell takes its width from the track; the header's width classes would fix it instead.
  '[&_th]:w-auto',
  // The name cell is max-w-0 so a table truncates it; in a grid that would collapse it to nothing.
  '[&_td.max-w-0]:max-w-none [&_td.max-w-0]:min-w-0',
].join(' ')
const AFTER_ROWS = '[&>tr]:[order:1000000]'
const mergedCols = computed(() =>
  props.columns.map((c) => (c.key === 'name' ? 'minmax(0,1fr)' : 'auto')).join(' '),
)
</script>

<template>
  <!-- Rows about a third shorter (owner, 2026-10-06): 41px became ~27: py-px cells around the 24px
       buttons, and a h-7 header: the kit's tight rows, which only these tables ask for. -->
  <!-- The style goes on the container, which the table inherits the track list from (--merged-cols). -->
  <Table
    :density="density"
    rows="tight"
    :class="merged ? MERGED_TABLE : undefined"
    :style="merged ? { '--merged-cols': mergedCols } : undefined"
  >
    <TableHeader sticky>
      <TableRow>
        <TableHead
          v-for="col in columns"
          :key="col.key"
          :width="col.head?.width ?? 'measured'"
          :align="col.head?.align"
          :style="{ '--col-w': widths?.[col.key] }"
          :title="col.title && tooltipsEnabled ? $t(col.title) : undefined"
        >
          <span v-if="!col.sortable" class="inline-flex items-center gap-0.5">{{ $t(col.label) }}</span>
          <span v-else class="inline-flex items-center gap-0.5">
            <component :is="col.flyout ?? 'span'" v-bind="col.flyoutProps">
              <SortButton
                :direction="indicatorFor(col.key)"
                :quiet="col.key === 'status'"
                @sort="emit('sort', col.key)"
              >
                {{ col.label ? $t(col.label) : '●' }}
              </SortButton>
            </component>
            <InfoHint v-if="col.hint" :text="$t(col.hint)" />
          </span>
          <!-- The width is only a wish to a table laid out by content: while Name's long text asks
               for more than the row has, the browser shrank these columns to their skeletons and
               grew them back as the figures landed (measured 2026-10-04: Actions 92 px, then 118).
               A strut of the width, less the cell's padding, makes it the column's least width. -->
          <div
            v-if="widths?.[col.key]"
            aria-hidden="true"
            class="h-0 w-(--strut-w)"
            :style="{ '--strut-w': `calc(${widths[col.key]} - ${density === 'compact' ? '0.75rem' : '1rem'})` }"
          />
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody v-if="skeleton" :class="merged ? AFTER_ROWS : undefined">
      <TableRow v-for="i in skeletonRows" :key="i">
        <TableCell v-for="col in columns" :key="col.key">
          <div v-if="col.key === 'actions'" class="flex justify-end">
            <Skeleton :line="col.skeleton.line" :width="col.skeleton.width" />
          </div>
          <Skeleton v-else :line="col.skeleton.line" :width="col.skeleton.width" />
        </TableCell>
      </TableRow>
    </TableBody>
    <slot />
    <TableBody v-if="empty" :class="merged ? AFTER_ROWS : undefined">
      <TableEmpty :colspan="columns.length" :class="merged ? 'col-span-full' : undefined">
        <div class="flex flex-col items-center gap-1 text-center">
          <component :is="empty.icon" class="mb-1 size-6 opacity-40" />
          <p class="font-medium text-foreground">{{ empty.title }}</p>
          <p class="text-xs text-muted-foreground">{{ empty.hint }}</p>
        </div>
      </TableEmpty>
    </TableBody>
  </Table>
</template>
