<script setup lang="ts">
// One task on one line (h-7), the row CliMayte's worker list and HSwarm's Jobs table both use: the status
// icon (the default slot), a kind badge when the list mixes kinds, the title, a cloud for another PC's task,
// the priority, the verdict mark, the account, the model and effort, and how long it has been active. The
// single root is the button, so a parent's listeners and attributes land on it. It is its own size container:
// the account and the model drop out on a narrow row, the title never does.
import { Check, Cloud, RotateCcw, X } from '@lucide/vue'
import { useI18n } from 'vue-i18n'

export interface RowMark {
  kind: string
  label: string
  hint: string
}

export interface RowTag {
  text: string
  differs: boolean
}

defineProps<{
  title: string
  account: string
  time: string
  /** The hover: the title in full and what needs attention. */
  hint: string
  tag?: RowTag | null
  /** Who dispatched the task (the From column): its text, muted when not traced, and its hover. */
  from?: { text: string; muted: boolean; hint: string } | null
  /** A small badge naming what the row is (HSwarm, CliMayte, Wave). */
  kind?: string | null
  /** Another PC's task: the cloud's hover names the PC. */
  cloud?: string | null
  priority?: number
  mark?: RowMark | null
  stale?: boolean
}>()

const { t } = useI18n()
</script>

<template>
  <button
    type="button"
    class="@container flex h-7 w-full min-w-0 items-center gap-2 px-2.5 text-start text-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    :class="stale ? 'opacity-60' : ''"
    :title="hint"
  >
    <slot />
    <span v-if="kind" class="shrink-0 rounded border px-1 text-2xs text-muted-foreground">{{ kind }}</span>
    <span class="min-w-0 flex-1 truncate text-sm">{{ title }}</span>
    <Cloud v-if="cloud" class="size-3.5 shrink-0 text-muted-foreground" :aria-label="cloud" />
    <span
      v-if="priority"
      class="shrink-0 rounded bg-muted px-1 text-2xs text-warning"
      :title="t('climayte.rowPriorityHint', { n: priority })"
    >{{ t('climayte.rowPriority', { n: priority }) }}</span>
    <!-- Its own hover: who judged it and what they said. A failed check on a task still
         working is amber and a retry arrow, never the red cross (owner, 2026-10-02). -->
    <span v-if="mark" class="inline-flex shrink-0" :title="mark.hint">
      <Check v-if="mark.kind === 'pass'" class="size-3.5 text-success" :aria-label="mark.label" />
      <RotateCcw v-else-if="mark.kind === 'retry'" class="size-3.5 text-warning" :aria-label="mark.label" />
      <X v-else class="size-3.5 text-destructive" :aria-label="mark.label" />
    </span>
    <!-- The account and the model fit the row, not the window: the pane beside HSwarm's tree is ~650px, where
         the window's breakpoints left the title ~140px of a 650px row (2026-10-10). -->
    <span class="hidden w-28 shrink-0 truncate text-muted-foreground @lg:block">{{ account }}</span>
    <span
      v-if="from"
      class="hidden w-32 shrink-0 truncate @md:block"
      :class="from.muted ? 'text-muted-foreground' : ''"
      :title="from.hint"
    >{{ from.text }}</span>
    <span
      class="hidden w-32 shrink-0 truncate @md:block"
      :class="tag?.differs ? 'text-warning' : 'text-muted-foreground'"
    >{{ tag?.text }}</span>
    <span class="w-14 shrink-0 text-end tabular-nums text-muted-foreground">{{ time }}</span>
  </button>
</template>
