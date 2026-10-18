<script setup lang="ts">
// The Desktop and CLI parts of the Usage history card (owner, 2026-10-10: "CLI doesn't show model stats, neither does
// desktop, like free does"): tiles for the window's totals, then the models by tokens. Like the bar charts, the top eight
// show and the rest sit behind a "+N more" toggle. The parent reads the reports; this only draws them. On All the models
// are one list of every source's (CombinedModels), so `hideModels` leaves this block its tiles.
import { computed, ref } from 'vue'
import { formatTokens } from '@/lib/kit'
import { useUsageSpan } from '@/composables/useUsagePeriod'
import type { UsageSummary } from '@/lib/usage-stats'

const props = defineProps<{
  title: string
  tiles: Array<{ key: string; label: string; value: string }>
  /** Null while the reports load. */
  summary: UsageSummary | null
  failed: boolean
  hideModels?: boolean
}>()

const TOP = 8
const { span } = useUsageSpan()
const expanded = ref(false)
const models = computed(() => props.summary?.models ?? [])
const shown = computed(() => (expanded.value ? models.value : models.value.slice(0, TOP)))
const hidden = computed(() => Math.max(0, models.value.length - TOP))
</script>

<template>
  <div class="space-y-3">
    <h3 class="text-xs font-semibold">{{ title }}</h3>
    <p v-if="failed" class="py-2 text-center text-2xs text-muted-foreground">{{ $t('instances.summary.usageUnavailable') }}</p>
    <p v-else-if="!summary" class="py-2 text-center text-2xs text-muted-foreground">{{ $t('instances.summary.loading') }}</p>
    <template v-else>
      <div class="grid grid-cols-3 gap-2">
        <div v-for="tile in tiles" :key="tile.key" class="rounded-md border px-2.5 py-2">
          <p class="text-2xs text-muted-foreground">{{ tile.label }}</p>
          <p class="text-base font-semibold tabular-nums">{{ tile.value }}</p>
        </div>
      </div>

      <div v-if="!hideModels">
        <h4 class="mb-1 text-2xs font-semibold text-muted-foreground">{{ $t('instances.summary.usageByModel', { span }) }}</h4>
        <p v-if="!models.length" class="py-2 text-center text-2xs text-muted-foreground">
          {{ $t('instances.summary.usageNoModels', { span }) }}
        </p>
        <template v-else>
          <ul class="divide-y rounded-md border text-xs">
            <li v-for="m in shown" :key="m.model" class="flex items-center gap-3 px-2.5 py-1.5">
              <span class="min-w-0 flex-1 truncate">{{ m.model }}</span>
              <span class="text-2xs tabular-nums text-muted-foreground">
                {{ $t('instances.summary.usageDetail', { sessions: m.sessions, turns: m.turns }) }}
              </span>
              <span class="w-24 text-end tabular-nums">
                {{ formatTokens(m.tokens) }} <span class="text-2xs text-muted-foreground">{{ $t('instances.summary.usageTokens') }}</span>
              </span>
            </li>
          </ul>
          <button
            v-if="hidden > 0 || expanded"
            type="button"
            class="mt-1 text-2xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
            :aria-expanded="expanded"
            @click="expanded = !expanded"
          >
            {{ expanded ? $t('instances.summary.usageFewer') : $t('instances.summary.usageMore', { n: hidden }) }}
          </button>
        </template>
      </div>
    </template>
  </div>
</template>
