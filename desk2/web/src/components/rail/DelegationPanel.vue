<script setup lang="ts">
// The Delegation panel the rail slides over its cards, as the Background tasks panel does (owner, 2026-10-15: "a similar simple
// version ... just basic stats on this chat"): per service, its runs, tasks and outcomes, its tokens (an estimate, marked est.),
// then one row per model with its tasks, succeeded and failed. Its back arrow slides the cards back.
import { ChevronLeft, Network, Users, X } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import { formatCompact } from '@/components/session-header/logic'
import type { DelegationService, ServiceStats } from './delegation'
import { RAIL_ICON_BTN } from './classes'

defineProps<{ stats: ServiceStats[] }>()
const SERVICE_ICON: Record<DelegationService, typeof Network> = { hswarm: Network, climayte: Users }
const emit = defineEmits<{ back: []; close: [] }>()

// HSwarm's tokens are measured; CliMayte's are an estimate, so they say so. HSwarm's dollars follow when it reported any.
const tokensText = (s: ServiceStats) => {
  const tokens = s.tokens === null ? 'Tokens not recorded' : `${formatCompact(s.tokens)} tokens${s.tokensEst ? ' est.' : ''}`
  return s.costUsd === null ? tokens : `${tokens} · $${s.costUsd.toFixed(2)}`
}
// A row of the rail's height and inset, laid out as a grid: its name, then three counts.
const ROW_GRID = 'grid h-6.5 grid-cols-[minmax(0,1fr)_repeat(3,2.5rem)] items-center gap-1 rounded-(--radius-6) px-1.5'
</script>

<template>
  <section class="flex size-full min-h-0 flex-col overflow-hidden rounded-lg border border-(--border) bg-(--bg-panel) text-ui leading-5" aria-label="Delegation">
    <header class="flex h-8.5 shrink-0 items-center ps-1 pe-1">
      <Tip label="Back to session details" side="bottom">
        <button type="button" :class="RAIL_ICON_BTN" aria-label="Back to session details" @click="emit('back')">
          <ChevronLeft class="size-4" :stroke-width="1.5" />
        </button>
      </Tip>
      <h2 class="min-w-0 flex-1 truncate font-normal text-text-2">Delegation</h2>
      <Tip label="Close" side="bottom">
        <button type="button" :class="RAIL_ICON_BTN" aria-label="Close" @click="emit('close')">
          <X class="size-3.5" :stroke-width="1.75" />
        </button>
      </Tip>
    </header>
    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-2">
      <section v-for="s in stats" :key="s.service" class="flex flex-col gap-1" :aria-label="s.label" :data-testid="`delegation-${s.service}`">
        <h3 class="flex items-center gap-2 font-medium text-text">
          <component :is="SERVICE_ICON[s.service]" class="size-4 shrink-0 text-text-2" aria-hidden="true" />
          {{ s.label }}
        </h3>
        <p class="tnum text-ui-sm text-text-muted">
          {{ s.runs }} {{ s.runs === 1 ? 'run' : 'runs' }} · {{ s.tasks }} tasks · {{ s.succeeded }} succeeded · {{ s.failed }} failed · {{ s.running }} running
        </p>
        <p class="tnum text-ui-sm text-text-muted">{{ tokensText(s) }}</p>
        <div :class="ROW_GRID" class="text-ui-sm text-text-muted">
          <span>Model</span>
          <span class="tnum text-end">Tasks</span>
          <span class="tnum text-end">Succeeded</span>
          <span class="tnum text-end">Failed</span>
        </div>
        <div v-for="m in s.models" :key="m.model" :class="ROW_GRID">
          <span class="min-w-0 truncate text-text">{{ m.model }}</span>
          <span class="tnum text-end text-text">{{ m.tasks }}</span>
          <span class="tnum text-end text-text">{{ m.succeeded }}</span>
          <span class="tnum text-end" :class="m.failed ? 'text-danger-text' : 'text-text-muted'">{{ m.failed }}</span>
        </div>
      </section>
      <p v-if="!stats.length" class="text-text-muted">Nothing delegated in this chat</p>
    </div>
  </section>
</template>
