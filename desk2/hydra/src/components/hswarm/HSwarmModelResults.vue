<script setup lang="ts">
// "Model results" on the HSwarm overview: one card per table or chart, each with a caption that says what it shows.
// Thumbs up and down per model come from HSwarm's own tasks and from CliMayte's scorecard, with a toggle between
// them. Volume, tokens and money per model are the analytics toolkit's (`source=hswarm`, groupBy model); only the
// edit-survival scoring is HSwarm's own (`model-stats`). Each range is kept once it has been read, so switching
// back is instant, and the scoring joins in after the page has painted.
import { ThumbsDown, ThumbsUp, Wrench } from '@lucide/vue'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BarRows from '@/components/charts/BarRows.vue'
import TrendBars from '@/components/charts/TrendBars.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getCliMayteScorecard, type CliMayteScorecard } from '@/lib/api'
import { seriesColor } from '@/lib/chart'
import type { HswarmMoney } from '@/lib/hswarm-api'
import { moneyLine, useHswarmApi } from '@/lib/hswarm-api'
import {
  rankBySample,
  type ResultsSource,
  SMALL_SAMPLE,
  type ThumbRow,
  thumbRows,
  tokensPerOk,
} from '@/lib/hswarm-results'
import {
  type KitUsageResult,
  fetchKitUsage,
  formatTokens,
  formatUsd,
  localDaysList,
  localTz,
  rollingDaysFrom,
} from '@/lib/kit'

type Range = 14 | 30 | 'all'

interface ModelRow {
  model: string
  tasks: number
  ok: number
  failed: number
  cost_per_ok: number | null
  tokens_per_ok: number | null
  scored: number
  survival: number | null
}

interface DailyDay {
  date: string
  models: Record<string, number>
  other: number
}

interface Kit {
  models: Array<Omit<ModelRow, 'scored' | 'survival'>>
  totals: HswarmMoney
  dayModel: Array<{ date: string; model: string; calls: number }>
}

/** HSwarm's own scoring per model: how many tasks were scored and the mean 1-day edit survival. */
interface Scores {
  [model: string]: { scored: number; survival: number | null }
}

/** One range as it was last read. `scores` is null until HSwarm's scoring has answered for it. */
interface Snapshot {
  kit: Kit
  climayte: CliMayteScorecard | null
  scores: Scores | null
  at: number
}

const TOP = 10
const TOP_DAILY = 6
const RANGES: Range[] = [14, 30, 'all']
const SOURCES: ResultsSource[] = ['both', 'hswarm', 'climayte']
/** A range read this recently is shown without asking again. */
const FRESH_MS = 60_000
/** "All" has no day count of its own: the per-day chart shows this many days, and HSwarm's scoring looks back this far. */
const ALL_DAYS = 3650
const ALL_DAY_CHART = 30

const { t } = useI18n()
const { apiCall } = useHswarmApi()

const range = ref<Range>(14)
const source = ref<ResultsSource>('both')
const kit = shallowRef<Kit | null>(null)
const climayte = ref<CliMayteScorecard | null>(null)
const scores = ref<Scores>({})
const error = ref('')
const loading = ref(false)
const scoresLoading = ref(false)
const outcomesOpen = ref(false)
const failedOpen = ref(false)
const tokensOpen = ref(false)
const survivalOpen = ref(false)
const cache = new Map<Range, Snapshot>()
let latest = 0

const dayRange = (r: Range) => (r === 'all' ? ALL_DAY_CHART : r)
const statsDays = (r: Range) => (r === 'all' ? ALL_DAYS : r)

function windowOf(r: Range): { from: number } | { last: 'all' } {
  return r === 'all' ? { last: 'all' } : { from: rollingDaysFrom(r) }
}

function toKit(byModel: KitUsageResult, byDayModel: KitUsageResult): Kit {
  const listUsd = byModel.totals.list_usd ?? 0
  return {
    models: byModel.rows
      .map((r) => {
        const ok = Number(r.ok)
        const tasks = Number(r.calls)
        return {
          model: String(r.model ?? 'other'),
          tasks,
          ok,
          failed: Number(r.failed),
          cost_per_ok: ok && r.list_usd !== null ? Number(r.list_usd) / ok : null,
          tokens_per_ok: tokensPerOk(Number(r.input), Number(r.output), ok),
        }
      })
      .sort((a, b) => b.tasks - a.tasks || a.model.localeCompare(b.model)),
    totals: {
      value_usd: listUsd,
      spent_usd: byModel.totals.billed_usd ?? 0,
      unknown_usd: byModel.totals.unbilled_usd ?? 0,
    },
    dayModel: byDayModel.rows.map((r) => ({
      date: String(r.day),
      model: String(r.model ?? 'other'),
      calls: Number(r.calls),
    })),
  }
}

function show(snap: Snapshot) {
  kit.value = snap.kit
  climayte.value = snap.climayte
  scores.value = snap.scores ?? {}
}

async function load() {
  const mine = ++latest
  const key = range.value
  const cached = cache.get(key)
  error.value = ''
  if (cached) {
    show(cached)
    loading.value = false
    if (cached.scores && Date.now() - cached.at < FRESH_MS) return
  } else {
    loading.value = true
  }
  try {
    const [byModel, byDayModel, board] = await Promise.all([
      fetchKitUsage({
        source: 'hswarm',
        tz: localTz(),
        ...windowOf(key),
        groupBy: 'model',
        measures: ['input', 'output', 'calls', 'ok', 'failed', 'list_usd', 'billed_usd', 'unbilled_usd'],
      }),
      fetchKitUsage({
        source: 'hswarm',
        tz: localTz(),
        from: rollingDaysFrom(dayRange(key)),
        groupBy: ['day', 'model'],
        measures: ['calls'],
      }),
      // The scorecard shows the range's window; its picks still come from all time (server side).
      getCliMayteScorecard(key === 'all' ? undefined : rollingDaysFrom(key)).catch(() => null),
    ])
    const snap: Snapshot = {
      kit: toKit(byModel, byDayModel),
      climayte: board,
      scores: cached?.scores ?? null,
      at: Date.now(),
    }
    cache.set(key, snap)
    if (mine !== latest) return
    show(snap)
  } catch (err) {
    if (mine === latest && !cached) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  } finally {
    if (mine === latest) loading.value = false
  }
  if (mine === latest && !error.value) await loadScores(mine, key)
}

// Thumbs scoring and edit survival stay HSwarm's: slow to compute (5 to 6 seconds a range), so they join in after the page has painted.
async function loadScores(mine: number, key: Range) {
  scoresLoading.value = true
  try {
    const stats: { models: Array<{ model: string; scored: number; survival: number | null }> } =
      await apiCall(`model-stats?days=${statsDays(key)}`)
    const next: Scores = Object.fromEntries(
      stats.models.map((m) => [m.model, { scored: m.scored, survival: m.survival }]),
    )
    const snap = cache.get(key)
    if (snap) snap.scores = next
    if (mine !== latest) return
    scores.value = next
  } catch {
    // Without HSwarm's scoring the survival panel simply stays empty.
    if (mine === latest) scores.value = {}
  } finally {
    if (mine === latest) scoresLoading.value = false
  }
}
onMounted(load)
watch(range, () => {
  outcomesOpen.value = false
  load()
})

const models = computed<ModelRow[]>(() =>
  (kit.value?.models ?? []).map((m) => ({
    ...m,
    scored: scores.value[m.model]?.scored ?? 0,
    survival: scores.value[m.model]?.survival ?? null,
  })),
)
const order = computed(() => models.value.map((m) => m.model))

const outcomes = computed(() => thumbRows(models.value, climayte.value?.rows ?? null, source.value))
const outcomeMax = computed(() => Math.max(1, ...outcomes.value.map((r) => r.up + r.fixed + r.down)))
const shownOutcomes = computed(() => (outcomesOpen.value ? outcomes.value : outcomes.value.slice(0, TOP)))
const rowName = (r: { source: 'hswarm' | 'climayte'; model: string }) =>
  r.model || t('climayte.runDefaultUnrecorded')
const rowHint = (r: ThumbRow) =>
  r.source === 'hswarm'
    ? t('hswarm.v.overview.results.hswarmPctHint')
    : [t('climayte.scoreScoreHint'), t('climayte.scoreFixedSplit', { slip: r.slip, rework: r.rework }), r.dim ? t('climayte.scoreOffLadder') : '']
        .filter(Boolean)
        .join(' · ')
const pctFmt = (n: number) => `${Math.round(n)}%`
const tokenFmt = formatTokens
const sourceTag = (s: 'hswarm' | 'climayte') => t(`hswarm.v.overview.results.sourceTag.${s}`)

// Tokens are the toolkit's and HSwarm's alone: CliMayte keeps no token count per model, so this chart stays HSwarm's.
const tokenPoints = computed(() =>
  rankBySample(
    models.value
      .filter((m) => m.tokens_per_ok != null)
      .map((m) => {
        const small = m.ok < SMALL_SAMPLE
        return {
          key: m.model,
          label: small ? `${m.model} (${t('hswarm.v.overview.results.few')})` : m.model,
          value: m.tokens_per_ok ?? 0,
          small,
          detail: [
            m.model.startsWith('free:') ? t('hswarm.v.overview.results.tokensEstimated') : '',
            small ? t('hswarm.v.overview.results.fewTasks', { n: SMALL_SAMPLE }) : '',
            m.cost_per_ok != null ? `${formatUsd(m.cost_per_ok, { style: 'fine' })} ${t('hswarm.v.money.atListPrice')}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        }
      }),
  ),
)
const tokensWithoutCount = computed(() => models.value.filter((m) => m.ok > 0 && m.tokens_per_ok == null).length)
const shownTokens = computed(() => (tokensOpen.value ? tokenPoints.value : tokenPoints.value.slice(0, TOP)))

// The share of tasks that failed, lowest first. A model with fewer than SMALL_SAMPLE tasks goes after the rest.
const failedPoints = computed(() =>
  rankBySample(
    outcomes.value
      .filter((r) => r.up + r.fixed + r.down > 0)
      .map((r) => {
        const total = r.up + r.fixed + r.down
        const small = total < SMALL_SAMPLE
        return {
          key: r.key,
          label: small ? `${rowName(r)} (${t('hswarm.v.overview.results.few')})` : rowName(r),
          value: (r.down / total) * 100,
          small,
          detail: `${r.up} ${t('hswarm.v.overview.results.up')} · ${r.fixed ? `${r.fixed} ${t('hswarm.v.overview.results.fixed')} · ` : ''}${r.down} ${t('hswarm.v.overview.results.down')} · ${sourceTag(r.source)}`,
        }
      }),
  ),
)
const shownFailed = computed(() => (failedOpen.value ? failedPoints.value : failedPoints.value.slice(0, TOP)))

const totals = computed<HswarmMoney>(() => kit.value?.totals ?? {})
const totalsText = computed(() => moneyLine(totals.value, t))
const survivalRows = computed(() =>
  models.value
    .filter((m) => m.survival !== null)
    .sort((a, b) => (b.survival ?? 0) - (a.survival ?? 0))
    .map((m) => ({
      key: m.model,
      label: m.model,
      value: (m.survival ?? 0) * 100,
      detail: t('hswarm.v.overview.results.scored', { n: m.scored }),
    })),
)

// The busiest models by name, everything else lumped as "other", over the chart's days.
const dailyTop = computed(() => models.value.slice(0, TOP_DAILY).map((m) => m.model))
const daily = computed<DailyDay[]>(() => {
  const byDay = new Map<string, DailyDay>()
  for (const date of localDaysList(dayRange(range.value))) byDay.set(date, { date, models: {}, other: 0 })
  for (const r of kit.value?.dayModel ?? []) {
    const day = byDay.get(r.date)
    if (!day) continue
    if (dailyTop.value.includes(r.model)) day.models[r.model] = r.calls
    else day.other += r.calls
  }
  return [...byDay.values()]
})
const dayTotal = (d: DailyDay) => Object.values(d.models).reduce((a, b) => a + b, 0) + d.other
const dayMax = computed(() => Math.max(1, ...daily.value.map(dayTotal)))
const colorOf = (name: string) => seriesColor(name, dailyTop.value)
const rangeLabel = (r: Range) => (r === 'all' ? t('hswarm.v.overview.results.all') : t('hswarm.v.overview.results.days', { n: r }))
const expander = 'text-2xs font-medium text-muted-foreground hover:text-foreground hover:underline'
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <CardTitle size="lg">{{ t('hswarm.v.overview.results.title') }}</CardTitle>
      <div class="flex flex-wrap gap-2">
        <div class="flex gap-1">
          <Button
            v-for="r in RANGES"
            :key="String(r)"
            size="sm"
            :variant="range === r ? 'default' : 'outline'"
            @click="range = r"
          >{{ rangeLabel(r) }}</Button>
        </div>
        <div class="flex gap-1">
          <Button
            v-for="s in SOURCES"
            :key="s"
            size="sm"
            :variant="source === s ? 'default' : 'outline'"
            @click="source = s"
          >{{ t(`hswarm.v.overview.results.sources.${s}`) }}</Button>
        </div>
      </div>
    </div>
    <p v-if="kit && !error && (loading || scoresLoading)" class="text-center text-xs text-muted-foreground">{{ t('hswarm.v.overview.loading') }}</p>
    <p v-if="error" class="text-xs text-destructive">{{ t('hswarm.v.overview.results.failed') }} {{ error }}</p>
    <p v-else-if="!kit && loading" class="py-4 text-center text-xs text-muted-foreground">{{ t('hswarm.v.overview.loading') }}</p>
    <div v-else-if="models.length === 0" class="py-4 text-center">
      <div class="text-sm font-medium">{{ t('hswarm.v.overview.results.emptyTitle') }}</div>
      <p class="text-xs text-muted-foreground">{{ t('hswarm.v.overview.results.emptyBody') }}</p>
    </div>
    <div v-else class="grid items-start gap-3 sm:grid-cols-2">
      <Card size="sm" class="sm:col-span-2">
        <CardHeader>
          <CardTitle>{{ t('hswarm.v.overview.results.outcomes') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-2">
          <p class="text-2xs text-muted-foreground">{{ t('hswarm.v.overview.results.outcomesCaption') }}</p>
          <p v-if="source !== 'hswarm' && !climayte" class="text-xs text-muted-foreground">{{ t('hswarm.v.overview.results.climayteMissing') }}</p>
          <p v-else-if="!outcomes.length" class="text-xs text-muted-foreground">{{ t('hswarm.v.overview.results.noRows') }}</p>
          <ul v-else class="space-y-1.5">
            <li v-for="r in shownOutcomes" :key="r.key" :class="r.dim ? 'opacity-60' : ''" :title="rowHint(r)">
              <div class="flex items-baseline justify-between gap-3 text-xs">
                <span class="flex min-w-0 items-baseline gap-1.5">
                  <span class="shrink-0 rounded bg-muted px-1 text-2xs text-muted-foreground">{{ sourceTag(r.source) }}</span>
                  <span class="truncate text-muted-foreground" :title="rowName(r)">{{ rowName(r) }}</span>
                </span>
                <span class="shrink-0 tabular-nums font-medium">
                  <ThumbsUp class="mr-0.5 inline size-3 text-success" :aria-label="t('hswarm.v.overview.results.up')" />{{ r.up }}
                  <template v-if="r.source === 'climayte'">
                    <Wrench class="mx-0.5 inline size-3 text-warning" :aria-label="t('hswarm.v.overview.results.fixed')" />{{ r.fixed }}
                  </template>
                  <ThumbsDown class="mx-0.5 inline size-3 text-destructive" :aria-label="t('hswarm.v.overview.results.down')" />{{ r.down }}
                  · {{ r.pct }}
                </span>
              </div>
              <div class="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <div class="flex h-full w-(--bar-w)" :style="{ '--bar-w': `${Math.max(1.5, ((r.up + r.fixed + r.down) / outcomeMax) * 100)}%` }">
                  <div class="h-full w-(--ok-w) bg-success" :style="{ '--ok-w': `${(r.up / (r.up + r.fixed + r.down)) * 100}%` }"></div>
                  <div class="h-full w-(--fixed-w) bg-warning" :style="{ '--fixed-w': `${(r.fixed / (r.up + r.fixed + r.down)) * 100}%` }"></div>
                  <div class="h-full w-(--failed-w) bg-destructive" :style="{ '--failed-w': `${(r.down / (r.up + r.fixed + r.down)) * 100}%` }"></div>
                </div>
              </div>
            </li>
          </ul>
          <button v-if="outcomes.length > TOP" type="button" :class="expander" @click="outcomesOpen = !outcomesOpen">
            {{ outcomesOpen ? t('hswarm.v.overview.results.showLess') : t('hswarm.v.overview.results.showMore') }}
          </button>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{{ t('hswarm.v.overview.results.tokensPerOk') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-2">
          <p class="text-2xs text-muted-foreground">{{ t('hswarm.v.overview.results.tokensCaption') }}</p>
          <p v-if="source === 'climayte'" class="text-xs text-muted-foreground">{{ t('hswarm.v.overview.results.tokensHswarmOnly') }}</p>
          <p v-else-if="!tokenPoints.length" class="text-xs text-muted-foreground">{{ t('hswarm.v.overview.results.noOk') }}</p>
          <template v-else>
            <TrendBars
              :points="shownTokens"
              :format="tokenFmt"
              :bar-label="t('hswarm.v.overview.results.tokensPerOk')"
              :line-label="t('hswarm.v.overview.results.trend')"
              :y-title="t('hswarm.v.overview.results.tokensAxis')"
              :x-title="t('hswarm.v.overview.results.modelAxis')"
            />
            <button v-if="tokenPoints.length > TOP" type="button" :class="expander" @click="tokensOpen = !tokensOpen">
              {{ tokensOpen ? t('hswarm.v.overview.results.showLess') : t('hswarm.v.overview.results.showMore') }}
            </button>
          </template>
          <p v-if="source !== 'climayte' && tokensWithoutCount" class="text-2xs text-muted-foreground">{{ t('hswarm.v.overview.results.noTokens', { n: tokensWithoutCount }) }}</p>
          <p v-if="totalsText" class="text-2xs text-muted-foreground">{{ totalsText }}</p>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{{ t('hswarm.v.overview.results.failedShare') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-2">
          <p class="text-2xs text-muted-foreground">{{ t('hswarm.v.overview.results.failedCaption') }}</p>
          <p v-if="!failedPoints.length" class="text-xs text-muted-foreground">{{ t('hswarm.v.overview.results.noRows') }}</p>
          <template v-else>
            <TrendBars
              :points="shownFailed"
              :format="pctFmt"
              :bar-label="t('hswarm.v.overview.results.failedShare')"
              :line-label="t('hswarm.v.overview.results.trend')"
              :y-title="t('hswarm.v.overview.results.failedAxis')"
              :x-title="t('hswarm.v.overview.results.modelAxis')"
            />
            <button v-if="failedPoints.length > TOP" type="button" :class="expander" @click="failedOpen = !failedOpen">
              {{ failedOpen ? t('hswarm.v.overview.results.showLess') : t('hswarm.v.overview.results.showMore') }}
            </button>
          </template>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{{ t('hswarm.v.overview.results.survival') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-2">
          <p class="text-2xs text-muted-foreground">{{ t('hswarm.v.overview.results.survivalCaption') }}</p>
          <p v-if="!survivalRows.length" class="text-xs text-muted-foreground">{{ t('hswarm.v.overview.results.noSurvival') }}</p>
          <BarRows
            v-else
            :rows="survivalRows.slice(0, TOP)"
            :more="survivalRows.slice(TOP)"
            :more-label="t('hswarm.v.overview.results.showMore')"
            :order="order"
            :format="(n) => `${Math.round(n)}%`"
          />
        </CardContent>
      </Card>

      <Card size="sm" class="sm:col-span-2">
        <CardHeader>
          <CardTitle>{{ t('hswarm.v.overview.results.perDay') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-2">
          <p class="text-2xs text-muted-foreground">{{ t('hswarm.v.overview.results.perDayCaption') }}</p>
          <div class="flex h-32 items-end gap-0.5">
            <div
              v-for="d in daily"
              :key="d.date"
              class="flex h-full min-w-0 flex-1 flex-col-reverse"
              :title="`${d.date}: ${dayTotal(d)}`"
            >
              <div class="flex flex-col-reverse h-(--day-h)" :style="{ '--day-h': `${(dayTotal(d) / dayMax) * 100}%` }">
                <div
                  v-for="name in dailyTop"
                  :key="name"
                  class="grow-(--grow) bg-(--series-color)"
                  :style="{ '--grow': d.models[name] || 0, '--series-color': colorOf(name) }"
                ></div>
                <div class="grow-(--grow) bg-muted-foreground/40" :style="{ '--grow': d.other }"></div>
              </div>
            </div>
          </div>
          <ul class="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
            <li v-for="name in dailyTop" :key="name" class="flex items-center gap-1">
              <span class="size-2 rounded-sm bg-(--series-color)" :style="{ '--series-color': colorOf(name) }"></span>{{ name }}
            </li>
            <li v-if="daily.some((d) => d.other > 0)" class="flex items-center gap-1">
              <span class="size-2 rounded-sm bg-muted-foreground/40"></span>{{ t('hswarm.v.overview.results.other') }}
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
