<script setup lang="ts">
// The All tab's one list of models (owner, 2026-10-10: All "still doesn't properly... show the combined list of
// models"): every model Desktop, CLI and Free used in the period, one row each whichever accounts ran it, the most tokens
// first, marked with where its tokens came from as the table's Type column marks a row (a model two sources used shows
// each one's share). The top eight show and the rest sit behind "+N more", as on SpendSummary. The parent merges the
// reports (lib/usage-stats.ts combineModels); this only draws them.
import { computed, ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { useUsageSpan } from '@/composables/useUsagePeriod'
import { formatTokens } from '@/lib/kit'
import type { CombinedModel, ModelSource } from '@/lib/usage-stats'

const props = defineProps<{
  /** Null while a report loads. */
  models: CombinedModel[] | null
  /** The sources whose report failed, so not in the list. */
  failed: ModelSource[]
}>()

const SOURCE_LABEL: Record<ModelSource, string> = { desktop: 'app.tabDesktop', cli: 'app.tabCli', free: 'app.tabFree' }
const TOP = 8
const { span, freeSpan } = useUsageSpan()
const expanded = ref(false)
const rows = computed(() => props.models ?? [])
const shown = computed(() => (expanded.value ? rows.value : rows.value.slice(0, TOP)))
const hidden = computed(() => Math.max(0, rows.value.length - TOP))
</script>

<template>
  <div class="space-y-1">
    <h3 class="text-xs font-semibold">{{ $t('instances.summary.allModelsTitle', { span }) }}</h3>
    <p v-if="freeSpan !== span" class="text-2xs text-muted-foreground">{{ $t('instances.summary.allModelsFreeSpan', { freeSpan }) }}</p>
    <p v-if="failed.length" class="text-2xs text-muted-foreground">
      {{ $t('instances.summary.allModelsMissing', { sources: failed.map((s) => $t(SOURCE_LABEL[s])).join(', ') }) }}
    </p>
    <p v-if="!models" class="py-2 text-center text-2xs text-muted-foreground">{{ $t('instances.summary.loading') }}</p>
    <p v-else-if="!rows.length" class="py-2 text-center text-2xs text-muted-foreground">
      {{ $t('instances.summary.usageNoModels', { span }) }}
    </p>
    <template v-else>
      <ul class="divide-y rounded-md border text-xs">
        <li v-for="m in shown" :key="m.model" class="flex items-center gap-3 px-2.5 py-1.5">
          <span class="min-w-0 flex-1 truncate">{{ m.model }}</span>
          <span class="flex shrink-0 gap-1">
            <Badge v-for="p in m.parts" :key="p.source" variant="outline" class="text-muted-foreground tabular-nums">
              {{ $t(SOURCE_LABEL[p.source]) }}<span v-if="m.parts.length > 1" class="ms-1 text-foreground">{{ formatTokens(p.tokens) }}</span>
            </Badge>
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
