<script setup lang="ts">
// A compact ranked list of stacked bars, one per entity (e.g. per model). The bar is scaled to the
// busiest row, so lengths compare; green is passed, amber is fixed (a small fix or a rework) and red
// is failed. The counts and the score are printed at the end of the row, so colour is never the only
// signal. `score` is the text beside the counts, `hint` the row's tooltip.
import { ThumbsDown, ThumbsUp, Wrench } from '@lucide/vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

type Row = {
  key: string
  label: string
  pass: number
  fixed: number
  fail: number
  score: string
  hint?: string
  dim?: boolean
}

const props = defineProps<{
  rows: Row[]
  /** Shown beside the rows past `limit`, e.g. "3 more". */
  moreLabel?: (n: number) => string
  limit?: number
  scoreHint?: string
}>()
const { t } = useI18n()

const total = (r: Row) => r.pass + r.fixed + r.fail
const sorted = computed(() =>
  [...props.rows].sort((a, b) => Number(!!a.dim) - Number(!!b.dim) || total(b) - total(a) || a.label.localeCompare(b.label)),
)
const shown = computed(() => (props.limit ? sorted.value.slice(0, props.limit) : sorted.value))
const hidden = computed(() => sorted.value.length - shown.value.length)
const max = computed(() => Math.max(1, ...sorted.value.map(total)))
</script>

<template>
  <ul class="flex flex-col gap-1 text-2xs">
    <li
      v-for="r in shown"
      :key="r.key"
      class="flex items-center gap-2"
      :class="r.dim ? 'opacity-60' : ''"
      :title="r.hint"
    >
      <span class="w-28 shrink-0 truncate text-muted-foreground" :title="r.label">{{ r.label }}</span>
      <div class="flex h-2 min-w-0 flex-1 items-center">
        <div
          class="flex h-full w-(--bar-w) overflow-hidden rounded-full bg-muted"
          :style="{ '--bar-w': `${Math.max(4, (total(r) / max) * 100)}%` }"
        >
          <div class="h-full grow-(--grow) bg-success" :style="{ '--grow': r.pass }" />
          <div class="h-full grow-(--grow) bg-warning" :style="{ '--grow': r.fixed }" />
          <div class="h-full grow-(--grow) bg-destructive" :style="{ '--grow': r.fail }" />
        </div>
      </div>
      <span class="flex shrink-0 items-center gap-1.5 tabular-nums">
        <span class="flex items-center gap-0.5 text-success" :title="t('climayte.scorePasses', { n: r.pass })" :aria-label="t('climayte.scorePasses', { n: r.pass })"><ThumbsUp class="size-3" aria-hidden="true" />{{ r.pass }}</span>
        <span class="flex items-center gap-0.5 text-warning" :title="t('climayte.scoreFixedN', { n: r.fixed })" :aria-label="t('climayte.scoreFixedN', { n: r.fixed })"><Wrench class="size-3" aria-hidden="true" />{{ r.fixed }}</span>
        <span class="flex items-center gap-0.5 text-destructive" :title="t('climayte.scoreFailedN', { n: r.fail })" :aria-label="t('climayte.scoreFailedN', { n: r.fail })"><ThumbsDown class="size-3" aria-hidden="true" />{{ r.fail }}</span>
        <span class="text-muted-foreground" :title="scoreHint">{{ r.score }}</span>
      </span>
    </li>
    <li v-if="hidden > 0 && moreLabel" class="text-muted-foreground">{{ moreLabel(hidden) }}</li>
  </ul>
</template>
