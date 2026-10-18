<script setup lang="ts">
// The usage-history card above the Instances table. Owner, 2026-10-07: the account counts, pooled gauges
// and "nearest their limit" list were current numbers he did not want; he wants historical charts only.
// Collapsed (the default, remembered): one line, the fleet's weekly use over the last 7 days as a
// sparkline. Expanded: the 7-day fleet chart (weekly and 5-hour use, with gaps where nothing was sampled)
// and tokens per day over the last 14 days, stacked by source. The usage history and the daily tokens are
// both fetched on mount, so the chart is ready by the time the card is opened: the tokens are one request
// for the 14 days, not one spend report per source. With the Free accounts on screen it shows theirs first (FreeSummary):
// their token totals and success rate in the header, the totals, accounts, models and tokens per day when open.
// Owner, 2026-10-10: each tab shows its own part in the header and when open: Desktop and CLI tokens, sessions, turns
// and models (SpendSummary); All shows Desktop, CLI and Free together. The table's tab is `view`. A toggle at the top of
// the open card picks the period, 24 hours, 7 days, 30 days or All time (owner, the same day: "toggles for, like, seven
// days, 30 days, all time, et cetera"); Free's record keeps 30 days, so its All time is those 30 (useUsagePeriod). All's
// models are one list, Desktop, CLI and Free together (CombinedModels; owner, the same day: All "still doesn't
// properly... show the combined list of models"), in place of each block's own.
import type { FleetUsageHistory, SpendReport } from '@agenthydra/server/types'
import { ChevronRight } from '@lucide/vue'
import { useElementSize, useStorage } from '@vueuse/core'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import HourBars from '@/components/charts/HourBars.vue'
import CombinedModels from '@/components/CombinedModels.vue'
import FreeSummary from '@/components/FreeSummary.vue'
import SpendSummary from '@/components/SpendSummary.vue'
import { Button } from '@/components/ui/button'
import { useFreeInstances } from '@/composables/useFreeInstances'
import type { KindView } from '@/composables/useInstanceFilter'
import { freeStatDays, refreshFreeStats, useFreeStats } from '@/composables/useFreeStats'
import { usagePeriod, useUsageSpan } from '@/composables/useUsagePeriod'
import { useDesktopTokenWindow } from '@/composables/useTokenWindow'
import { getFleetUsageHistory, getSpend, getTokensByDay } from '@/lib/api'
import { axisMax, seriesColor, ticks } from '@/lib/chart'
import { answeredShare, summarizeFree } from '@/lib/free-stats'
import { formatTokens } from '@/lib/kit'
import { dayLabel, formatAt, type PlotBox, segmentPaths } from '@/lib/usage-history'
import { combineModels, type ModelSource, summarizeUsage, USAGE_PERIODS, type UsagePeriod } from '@/lib/usage-stats'

const props = defineProps<{ /** The table's tab: All, Desktop, CLI or Free. */ view: KindView }>()
const { t } = useI18n()
const open = useStorage('agenthydra.instances.summaryOpen', false)

const showFree = computed(() => props.view === 'all' || props.view === 'free')
const showDesktop = computed(() => props.view === 'all' || props.view === 'desktop')
const showCli = computed(() => props.view === 'all' || props.view === 'cli')
const isAll = computed(() => props.view === 'all')

// The Free record is read again whenever an account's numbers move (a message ended), while the Free rows show.
const { instances: freeInstances, tokens: freeTokens, health: freeHealth } = useFreeInstances()
const { rows: freeRows, failed: freeStatsFailed } = useFreeStats()
const tokenWindow = useDesktopTokenWindow()
watch([showFree, freeTokens, freeHealth, freeStatDays], ([free]) => { if (free) void refreshFreeStats() }, { immediate: true })
const { span, freeSpan } = useUsageSpan()
// The Free accounts' record over the period's days; null with no Free accounts. Its totals are in the Free card's own
// window; the All line adds its days, the same period as Desktop and CLI (only All time differs: Free keeps 30 days).
const freeSummary = computed(() =>
  freeInstances.value.length ? summarizeFree(freeRows.value ?? [], freeInstances.value, freeTokens.value, tokenWindow.value, freeStatDays.value, Date.now()) : null,
)
const freeAll = computed(() => freeSummary.value?.totals.all ?? null)
const freeInDays = computed(() => (freeSummary.value?.days ?? []).reduce((n, d) => n + d.claude + d.chatgpt, 0))
const freeLine = computed(() => {
  const all = freeAll.value
  if (!all) return ''
  const share = answeredShare(all)
  return t('freeInstances.stats.headerLine', { tokens: formatTokens(freeInDays.value), answered: share === null ? '–' : `${Math.round(share * 100)}%`, span: freeSpan.value })
})

const TOKEN_SOURCES = ['desktop', 'cli', 'climayte', 'hswarm'] as const
type TokenSource = (typeof TOKEN_SOURCES)[number]
const FLEET_ORDER = ['week', 'session'] as const

const sourceLabel = (s: TokenSource) =>
  ({
    desktop: t('instances.summary.sourceDesktop'),
    cli: t('instances.summary.sourceCli'),
    climayte: t('instances.summary.sourceClimayte'),
    hswarm: t('instances.summary.sourceHswarm'),
  })[s]

const history = shallowRef<FleetUsageHistory | null>(null)
const historyFailed = ref(false)
const tokenDays = ref<Array<{ key: string; values: number[] }> | null>(null)
const tokensFailed = ref(false)

async function loadHistory() {
  try {
    history.value = await getFleetUsageHistory(168)
  } catch {
    historyFailed.value = true
  }
}

async function loadTokens() {
  try {
    const report = await getTokensByDay(14)
    tokenDays.value = report.days.map((d) => ({
      key: d.key,
      values: TOKEN_SOURCES.map((s) => d.bySource[s]),
    }))
  } catch {
    tokensFailed.value = true
  }
}

onMounted(() => {
  void loadHistory()
  void loadTokens()
})

const points = computed(() => history.value?.points ?? [])
const weekValues = computed(() => points.value.map((p) => p.week))
const sessionValues = computed(() => points.value.map((p) => p.session))
const hasFleetData = computed(() => points.value.some((p) => p.week !== null || p.session !== null))

const SPARK: PlotBox = { left: 0, top: 1, width: 120, height: 22 }
const sparkPaths = computed(() => segmentPaths(weekValues.value, SPARK, 100))

// The chart is drawn at the card's own width, one SVG unit per pixel, so it fills the card at any size.
const fleetEl = ref<HTMLElement | null>(null)
const { width: fleetWidth } = useElementSize(fleetEl)
const FLEET_HEIGHT = 160
const fleetView = computed(() => ({ width: Math.max(320, Math.round(fleetWidth.value) || 600), height: FLEET_HEIGHT }))
const fleetBox = computed<PlotBox>(() => ({ left: 34, top: 8, width: fleetView.value.width - 42, height: FLEET_HEIGHT - 16 }))
const fleetMax = computed(() => {
  const all = [...weekValues.value, ...sessionValues.value].filter((v): v is number => v !== null)
  return axisMax(Math.max(100, ...all))
})
const fleetTicks = computed(() => ticks(fleetMax.value))
const yAt = (v: number) =>
  fleetBox.value.top + fleetBox.value.height - (v / fleetMax.value) * fleetBox.value.height
const weekPaths = computed(() => segmentPaths(weekValues.value, fleetBox.value, fleetMax.value))
const sessionPaths = computed(() => segmentPaths(sessionValues.value, fleetBox.value, fleetMax.value))
const pctOrGap = (v: number | null) => (v === null ? t('instances.summary.noSample') : `${Math.round(v)}%`)
const fleetHits = computed(() => {
  const n = points.value.length
  const box = fleetBox.value
  const slot = box.width / Math.max(1, n)
  return points.value.map((p, i) => ({
    x: box.left + (i / Math.max(1, n - 1)) * box.width - slot / 2,
    tip: t('instances.summary.tipPoint', {
      time: formatAt(p.t),
      week: pctOrGap(p.week),
      session: pctOrGap(p.session),
    }),
  }))
})
const fleetLegend = computed(() => [
  { key: 'week', label: t('instances.summary.fleetWeek'), color: seriesColor('week', FLEET_ORDER) },
  { key: 'session', label: t('instances.summary.fleetSession'), color: seriesColor('session', FLEET_ORDER) },
])
const fleetSpan = computed(() => {
  const first = points.value[0]?.t
  const last = points.value[points.value.length - 1]?.t
  return { first: first ? formatAt(first) : '', last: last ? formatAt(last) : '' }
})

const tokenSeries = computed(() =>
  TOKEN_SOURCES.map((s) => ({ key: s, label: sourceLabel(s), color: seriesColor(s, TOKEN_SOURCES) })),
)
const tokenHours = computed(() =>
  (tokenDays.value ?? []).map((d) => ({ label: dayLabel(d.key), values: d.values })),
)
const tokensEmpty = computed(
  () => tokenDays.value !== null && tokenDays.value.every((d) => d.values.every((v) => v === 0)),
)

// Desktop and CLI over the period: one spend report per source, read the first time the period is shown and kept, so
// toggling back is instant. CLI is cli plus climayte.
const SPEND_SOURCES = ['desktop', 'cli', 'climayte'] as const
type SpendSource = (typeof SPEND_SOURCES)[number]
type BySource<T> = Partial<Record<SpendSource, T>>
const spendBy = ref<Partial<Record<UsagePeriod, BySource<SpendReport>>>>({})
const failedBy = ref<Partial<Record<UsagePeriod, BySource<boolean>>>>({})
async function loadSpend(period: UsagePeriod, source: SpendSource) {
  try {
    // Awaited before the spread: `{ ...x, [source]: await ... }` copies the reports as they were when the request went
    // out, so the last of the three to answer dropped the other two.
    const report = await getSpend(period, source)
    spendBy.value = { ...spendBy.value, [period]: { ...spendBy.value[period], [source]: report } }
  } catch {
    failedBy.value = { ...failedBy.value, [period]: { ...failedBy.value[period], [source]: true } }
  }
}
const asked = new Set<UsagePeriod>()
watch(usagePeriod, (p) => {
  if (asked.has(p)) return
  asked.add(p)
  for (const s of SPEND_SOURCES) void loadSpend(p, s)
}, { immediate: true })
const spend = computed<BySource<SpendReport>>(() => spendBy.value[usagePeriod.value] ?? {})
const spendFailed = computed<BySource<boolean>>(() => failedBy.value[usagePeriod.value] ?? {})
const periodLabel = (p: UsagePeriod) => t(`instances.summary.period.${p}`)

const desktopUsage = computed(() => (spend.value.desktop ? summarizeUsage([spend.value.desktop]) : null))
const desktopFailed = computed(() => !!spendFailed.value.desktop)
const cliUsage = computed(() => (spend.value.cli && spend.value.climayte ? summarizeUsage([spend.value.cli, spend.value.climayte]) : null))
const cliFailed = computed(() => !!spendFailed.value.cli || !!spendFailed.value.climayte)
const desktopTiles = computed(() => {
  const u = desktopUsage.value
  if (!u) return []
  return [
    { key: 'tokens', label: t('instances.summary.tileTokens'), value: formatTokens(u.tokens) },
    { key: 'sessions', label: t('instances.summary.tileSessions'), value: String(u.sessions) },
    { key: 'turns', label: t('instances.summary.tileTurns'), value: String(u.turns) },
  ]
})
const cliTiles = computed(() => {
  const all = cliUsage.value
  const cli = spend.value.cli ? summarizeUsage([spend.value.cli]) : null
  const climayte = spend.value.climayte ? summarizeUsage([spend.value.climayte]) : null
  if (!all || !cli || !climayte) return []
  return [
    { key: 'all', label: t('instances.summary.tileAllCli'), value: formatTokens(all.tokens) },
    { key: 'cli', label: sourceLabel('cli'), value: formatTokens(cli.tokens) },
    { key: 'climayte', label: sourceLabel('climayte'), value: formatTokens(climayte.tokens) },
  ]
})

// All's one list of models: every report that has not failed, merged by model; null until they are all in.
const allFailed = computed(() => {
  const out: ModelSource[] = []
  if (desktopFailed.value) out.push('desktop')
  if (cliFailed.value) out.push('cli')
  if (freeStatsFailed.value) out.push('free')
  return out
})
const allModels = computed(() => {
  const failed = allFailed.value
  const freeWaiting = freeInstances.value.length > 0 && !freeRows.value
  if ((!desktopUsage.value && !failed.includes('desktop')) || (!cliUsage.value && !failed.includes('cli')) || (freeWaiting && !failed.includes('free'))) return null
  return combineModels({ desktop: desktopUsage.value?.models, cli: cliUsage.value?.models, free: freeSummary.value?.models })
})

// The header line: the tab's own part; All adds Desktop, CLI and Free, its parts in the tooltip.
const headerLine = computed(() => {
  const d = desktopUsage.value
  const c = cliUsage.value
  if (props.view === 'free') return freeLine.value
  if (props.view === 'desktop') {
    return d ? t('instances.summary.headerDesktop', { tokens: formatTokens(d.tokens), sessions: d.sessions, span: span.value }) : ''
  }
  if (props.view === 'cli') {
    return c ? t('instances.summary.headerCli', { tokens: formatTokens(c.tokens), sessions: c.sessions, span: span.value }) : ''
  }
  if (!d || !c) return ''
  return t('instances.summary.headerAll', { tokens: formatTokens(d.tokens + c.tokens + freeInDays.value), span: span.value })
})
const headerTip = computed(() => {
  const d = desktopUsage.value
  const c = cliUsage.value
  if (props.view !== 'all' || !d || !c) return undefined
  return t('instances.summary.headerAllTip', {
    desktop: formatTokens(d.tokens),
    cli: formatTokens(c.tokens),
    free: formatTokens(freeInDays.value),
    span: span.value,
    freeSpan: freeSpan.value,
  })
})
</script>

<template>
  <section class="m-4 rounded-lg border bg-card">
    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-start focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
      :aria-expanded="open"
      @click="open = !open"
    >
      <ChevronRight
        class="size-4 shrink-0 text-muted-foreground transition-transform"
        :class="{ 'rotate-90': open }"
      />
      <span class="text-xs font-semibold whitespace-nowrap">{{ $t('instances.summary.title') }}</span>
      <span v-if="headerLine" class="truncate text-2xs text-muted-foreground tabular-nums" :title="headerTip">{{ headerLine }}</span>
      <svg
        v-if="sparkPaths.length"
        class="ms-auto shrink-0 overflow-visible text-primary"
        width="120"
        height="24"
        :viewBox="`0 0 ${SPARK.width} 24`"
        role="img"
        :aria-label="$t('instances.summary.sparklineLabel')"
      >
        <path
          v-for="(d, k) in sparkPaths"
          :key="k"
          :d="d"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
        />
      </svg>
    </button>

    <div v-if="open" class="space-y-4 border-t p-3">
      <div class="flex gap-1" role="group" :aria-label="$t('instances.summary.periodLabel')">
        <Button
          v-for="p in USAGE_PERIODS"
          :key="p"
          size="sm"
          :variant="usagePeriod === p ? 'default' : 'outline'"
          :aria-pressed="usagePeriod === p"
          @click="usagePeriod = p"
        >{{ periodLabel(p) }}</Button>
      </div>
      <CombinedModels v-if="isAll" :models="allModels" :failed="allFailed" />
      <SpendSummary
        v-if="showDesktop"
        :title="$t('instances.summary.desktopTitle')"
        :tiles="desktopTiles"
        :summary="desktopUsage"
        :failed="desktopFailed"
        :hide-models="isAll"
      />
      <SpendSummary
        v-if="showCli"
        :title="$t('instances.summary.cliTitle')"
        :tiles="cliTiles"
        :summary="cliUsage"
        :failed="cliFailed"
        :hide-models="isAll"
      />
      <FreeSummary v-if="showFree" :hide-models="isAll" />
      <div>
        <h3 class="mb-1 text-xs font-semibold">{{ $t('instances.summary.fleetTitle') }}</h3>
        <p v-if="historyFailed" class="py-6 text-center text-2xs text-muted-foreground">
          {{ $t('instances.summary.unavailable') }}
        </p>
        <p v-else-if="!history" class="py-6 text-center text-2xs text-muted-foreground">
          {{ $t('instances.summary.loading') }}
        </p>
        <p v-else-if="!hasFleetData" class="py-6 text-center text-2xs text-muted-foreground">
          {{ $t('instances.summary.noData') }}
        </p>
        <div v-else ref="fleetEl">
          <svg
            :viewBox="`0 0 ${fleetView.width} ${fleetView.height}`"
            class="h-40 w-full overflow-visible"
            role="img"
            :aria-label="$t('instances.summary.fleetTitle')"
          >
            <g v-for="tk in fleetTicks" :key="tk">
              <line
                :x1="fleetBox.left"
                :x2="fleetBox.left + fleetBox.width"
                :y1="yAt(tk)"
                :y2="yAt(tk)"
                class="stroke-border"
                stroke-width="1"
              />
              <text
                :x="fleetBox.left - 6"
                :y="yAt(tk) + 3"
                text-anchor="end"
                class="fill-muted-foreground"
                font-size="10"
              >{{ tk }}%</text>
            </g>
            <path
              v-for="(d, k) in weekPaths"
              :key="`w${k}`"
              :d="d"
              fill="none"
              stroke-width="1.75"
              stroke-linejoin="round"
              class="stroke-(--line-c)"
              :style="{ '--line-c': seriesColor('week', FLEET_ORDER) }"
            />
            <path
              v-for="(d, k) in sessionPaths"
              :key="`s${k}`"
              :d="d"
              fill="none"
              stroke-width="1.75"
              stroke-linejoin="round"
              class="stroke-(--line-c)"
              :style="{ '--line-c': seriesColor('session', FLEET_ORDER) }"
            />
            <rect
              v-for="(h, i) in fleetHits"
              :key="i"
              :x="h.x"
              :y="fleetBox.top"
              :width="fleetBox.width / Math.max(1, points.length)"
              :height="fleetBox.height"
              fill="transparent"
            >
              <title>{{ h.tip }}</title>
            </rect>
          </svg>
          <div class="mt-0.5 flex justify-between ps-8.5 text-3xs text-muted-foreground tabular-nums">
            <span>{{ fleetSpan.first }}</span>
            <span>{{ fleetSpan.last }}</span>
          </div>
          <ul class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-3xs text-muted-foreground">
            <li v-for="l in fleetLegend" :key="l.key" class="flex items-center gap-1">
              <span class="inline-block size-2 rounded-sm bg-(--dot-c)" :style="{ '--dot-c': l.color }"></span>
              {{ l.label }}
            </li>
          </ul>
        </div>
      </div>

      <div>
        <h3 class="mb-1 text-xs font-semibold">{{ $t('instances.summary.tokensTitle') }}</h3>
        <p v-if="tokensFailed" class="py-6 text-center text-2xs text-muted-foreground">
          {{ $t('instances.summary.unavailable') }}
        </p>
        <p v-else-if="!tokenDays" class="py-6 text-center text-2xs text-muted-foreground">
          {{ $t('instances.summary.loading') }}
        </p>
        <p v-else-if="tokensEmpty" class="py-6 text-center text-2xs text-muted-foreground">
          {{ $t('instances.summary.noData') }}
        </p>
        <template v-else>
          <HourBars
            :hours="tokenHours"
            :series="tokenSeries"
            height-class="h-32"
            :format-value="formatTokens"
          />
          <ul class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-3xs text-muted-foreground">
            <li v-for="s in tokenSeries" :key="s.key" class="flex items-center gap-1">
              <span class="inline-block size-2 rounded-sm bg-(--dot-c)" :style="{ '--dot-c': s.color }"></span>
              {{ s.label }}
            </li>
          </ul>
        </template>
      </div>
    </div>
  </section>
</template>
