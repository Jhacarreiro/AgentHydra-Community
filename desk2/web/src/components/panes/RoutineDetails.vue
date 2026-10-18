<script setup lang="ts">
// A routine's details (Settings > Managers > Routines > Details): stat tiles from its whole history, what its status and
// its runs' counters add up to, trend rows, and EVERY run, newest first, loaded a page at a time (owner, 2026-10-15: "how many
// runs it's done, how many fixes it's made ... I can't really see all its runs"). Replaces the list in place; Back returns.
import { computed, onMounted, ref, shallowRef } from 'vue'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronRight, CircleAlert, CircleCheck, CircleMinus, LoaderCircle } from '@lucide/vue'
import type { RoutineDetails, RoutineRun } from '@shared/routines'
import { usePaneApi } from './api'
import { BUTTON } from './settings-styles'
import { outcomeKind, spanOf } from './routine-view'
import { counterLabel, runStamp, counterTiles, mergeRuns, runCounterText, statTiles, totalTiles, trendRows } from './routine-details'

const props = defineProps<{ id: string; name: string }>()
const emit = defineEmits<{ back: [] }>()

const api = usePaneApi()
const PAGE = 50
const details = shallowRef<RoutineDetails | null>(null)
const runs = shallowRef<RoutineRun[]>([])
const nextBefore = ref<number | null>(null)
const loading = ref(true)
const loadingMore = ref(false)
const error = ref('')
const openRuns = ref<Set<number>>(new Set())

const tiles = computed(() => (details.value ? statTiles(details.value) : []))
const totals = computed(() => (details.value ? totalTiles(details.value) : []))
const counters = computed(() => (details.value ? counterTiles(details.value) : []))
const trendGroups = computed(() => Object.entries(details.value?.trends ?? {}).map(([name, g]) => ({ name, rows: trendRows(g) })))
const numbers = computed(() => Object.entries(details.value?.numbers ?? {}))

const stamp = (ms: number) => new Date(ms).toLocaleString()
const TREND_ICON = { up: ArrowUp, down: ArrowDown, flat: ArrowRight }

async function load(more: boolean) {
  if (more) loadingMore.value = true
  else loading.value = true
  error.value = ''
  try {
    const d = await api.routineDetails(props.id, more ? nextBefore.value : null, PAGE)
    if (more) runs.value = mergeRuns(runs.value, d.runs)
    else {
      details.value = d
      runs.value = d.runs
    }
    nextBefore.value = d.nextBefore
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}
onMounted(() => void load(false))

function toggleRun(at: number) {
  const s = new Set(openRuns.value)
  if (!s.delete(at)) s.add(at)
  openRuns.value = s
}
const openable = (r: RoutineRun) => !!r.lastLine || r.description?.state === 'failed'

const TILE = 'rounded-[var(--radius-6)] bg-fill-5 px-2.5 py-1.5 shadow-[inset_0_0_0_1px_var(--border)]'
</script>

<template>
  <section class="mt-3 w-0 min-w-full" :aria-label="`${name} details`">
    <div class="flex items-center gap-2">
      <button type="button" :class="[BUTTON, 'gap-1.5']" @click="emit('back')">
        <ArrowLeft class="size-3.5" aria-hidden="true" />All routines
      </button>
      <h3 class="min-w-0 flex-1 truncate text-ui-lg leading-5 text-text">{{ name }}</h3>
    </div>

    <div v-if="loading" class="mt-3 flex items-center gap-2 text-ui-sm leading-4.5 text-text-muted" role="status">
      <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />Loading its runs
    </div>
    <div v-else-if="error && !details" role="alert" class="mt-3 text-ui-sm leading-4.5 text-danger-text">
      <div class="wrap-break-word">Could not load the details: {{ error }}</div>
      <button type="button" :class="[BUTTON, 'mt-2']" @click="load(false)">Try again</button>
    </div>
    <template v-else-if="details">
      <div v-if="details.headline" class="mt-1 wrap-break-word text-ui-sm leading-4.5 text-text-muted">{{ details.headline }}</div>

      <h4 class="mt-3 text-ui-sm leading-4.5 text-text-2">Runs</h4>
      <ul class="mt-1 grid grid-cols-[repeat(auto-fill,minmax(min(6rem,100%),1fr))] gap-1.5">
        <li v-for="t in tiles" :key="t.key" :class="TILE" :title="t.title">
          <div class="text-ui-sm leading-4.5 text-text-muted">{{ t.label }}</div>
          <div class="tnum text-ui-lg leading-5 text-text">{{ t.value }}</div>
        </li>
      </ul>

      <template v-if="totals.length">
        <h4 class="mt-3 text-ui-sm leading-4.5 text-text-2">Totals</h4>
        <ul class="mt-1 grid grid-cols-[repeat(auto-fill,minmax(min(6rem,100%),1fr))] gap-1.5">
          <li v-for="t in totals" :key="t.key" :class="TILE">
            <div class="text-ui-sm leading-4.5 text-text-muted">{{ t.label }}</div>
            <div class="tnum text-ui-lg leading-5 text-text">{{ t.value }}</div>
          </li>
        </ul>
      </template>

      <template v-if="counters.length">
        <h4 class="mt-3 text-ui-sm leading-4.5 text-text-2">Across all runs</h4>
        <ul class="mt-1 grid grid-cols-[repeat(auto-fill,minmax(min(6rem,100%),1fr))] gap-1.5">
          <li v-for="t in counters" :key="t.key" :class="TILE">
            <div class="text-ui-sm leading-4.5 text-text-muted">{{ t.label }}</div>
            <div class="tnum text-ui-lg leading-5 text-text">{{ t.value }}</div>
          </li>
        </ul>
      </template>

      <dl v-if="numbers.length" class="mt-3 grid gap-1">
        <div v-for="[k, v] in numbers" :key="k" class="flex items-baseline justify-between gap-4 text-ui-sm leading-4.5">
          <dt class="text-text-muted">{{ counterLabel(k) }}</dt>
          <dd class="tnum text-text-2">{{ v }}</dd>
        </div>
      </dl>

      <template v-for="g in trendGroups" :key="g.name">
        <h4 class="mt-3 text-ui-sm leading-4.5 text-text-2">{{ counterLabel(g.name) }}</h4>
        <ul class="mt-1 grid grid-cols-[minmax(0,1fr)] gap-0.5">
          <li v-for="row in g.rows" :key="row.name" class="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-4 px-1.5 text-ui-sm leading-6">
            <span class="truncate text-text-2">{{ row.label }}</span>
            <span class="tnum text-text">{{ row.latest }}</span>
            <span class="tnum text-text-muted">best {{ row.best }}</span>
            <span class="inline-flex w-12 items-center gap-1 text-text-muted">
              <component :is="TREND_ICON[row.word]" class="size-3.5" aria-hidden="true" />{{ row.word }}
            </span>
          </li>
        </ul>
      </template>

      <h4 class="mt-4 text-ui-sm leading-4.5 text-text-2">All runs ({{ details.stats.total }})</h4>
      <div v-if="!runs.length" class="text-ui-sm leading-4.5 text-text-muted">No runs yet.</div>
      <ul v-else class="mt-1 grid grid-cols-[minmax(0,1fr)] gap-0.5">
        <li v-for="r in runs" :key="r.startedAt">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-[var(--radius-6)] px-1.5 py-1 text-start text-ui-sm leading-4.5 hover:bg-fill-5 disabled:hover:bg-transparent"
            :aria-expanded="openable(r) ? openRuns.has(r.startedAt) : undefined"
            :disabled="!openable(r)"
            @click="toggleRun(r.startedAt)"
          >
            <CircleCheck v-if="outcomeKind(r.outcome) === 'ok'" class="size-3.5 shrink-0 text-success" aria-hidden="true" />
            <CircleAlert v-else-if="outcomeKind(r.outcome) === 'failed'" class="size-3.5 shrink-0 text-danger-text" aria-hidden="true" />
            <CircleMinus v-else class="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
            <span class="shrink-0 text-text-2" :title="stamp(r.startedAt)">{{ runStamp(r.startedAt) }}</span>
            <span class="tnum shrink-0 text-text-muted">{{ spanOf(r.endedAt - r.startedAt) }} · {{ r.outcome }}</span>
            <span v-if="runCounterText(r.lastLine)" class="tnum min-w-0 truncate text-text-muted">{{ runCounterText(r.lastLine) }}</span>
            <LoaderCircle v-if="r.description?.state === 'pending'" class="size-3.5 shrink-0 animate-spin text-text-muted" aria-label="Describing the run" />
            <ChevronRight v-if="openable(r)" class="ms-auto size-3.5 shrink-0 text-text-muted transition-transform" :class="openRuns.has(r.startedAt) ? 'rotate-90' : ''" aria-hidden="true" />
          </button>
          <div v-if="r.description?.state === 'done'" class="wrap-break-word ps-7 text-ui-sm leading-4.5 text-text-2">{{ r.description.text }}</div>
          <template v-if="openRuns.has(r.startedAt)">
            <div v-if="r.lastLine" class="wrap-break-word ps-7 font-mono text-ui-sm leading-4.5 text-text-muted">{{ r.lastLine }}</div>
            <div v-if="r.description?.state === 'failed'" class="wrap-break-word ps-7 text-ui-sm leading-4.5 text-text-muted">Not described: {{ r.description.text }}</div>
          </template>
        </li>
      </ul>
      <div v-if="error" role="alert" class="mt-2 wrap-break-word text-ui-sm leading-4.5 text-danger-text">Could not load more: {{ error }}</div>
      <div v-if="nextBefore !== null" class="mt-2 flex items-center gap-3">
        <button type="button" :class="BUTTON" :disabled="loadingMore" @click="load(true)">{{ loadingMore ? 'Loading…' : 'Load more' }}</button>
        <span class="tnum text-ui-sm leading-4.5 text-text-muted">Showing {{ runs.length }} of {{ details.stats.total }}</span>
      </div>
    </template>
  </section>
</template>
