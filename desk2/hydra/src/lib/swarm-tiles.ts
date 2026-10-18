// The HSwarm stat tiles (saved today / 7 days / all time, tasks and tokens today), shared by the
// plain card (SwarmStatsCard.vue), the combined CliMayte + HSwarm card (OffloadStatsCard.vue) and
// the HSwarm tile in Analytics' lead row (AnalyticsView.vue).
import { computed, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatCompact, formatUsd } from '@/lib/format'
import { lastDaysSaved, type SwarmStatsData } from '@/lib/swarm-stats'

export const money = (n: number | null | undefined) => (n == null ? '—' : formatUsd(n))
export const count = (n: number | null | undefined) => (n == null ? '—' : formatCompact(n))

/** Answered run and ask tasks today; falls back to the feed's task count when it has no per-kind split. */
function answeredToday(s: SwarmStatsData): number {
  const l = s.today.by_label
  return l ? (l.run?.ok ?? 0) + (l.ask?.ok ?? 0) : s.today.tasks
}

export function useSwarmTiles(stats: Ref<SwarmStatsData | null>) {
  const { t } = useI18n()
  const week = computed(() => lastDaysSaved(stats.value?.days ?? [], 7))
  const basisHint = computed(() => {
    const b = stats.value?.basis
    return b?.profile_model
      ? t('swarmStats.basisHint', { model: b.profile_model, since: b.method_since ?? '—' })
      : t('swarmStats.basisHintBare')
  })
  const allHint = computed(() => {
    const o = stats.value?.old_method
    if (!o || !o.rows || o.saved_usd == null) return basisHint.value
    return `${basisHint.value} ${t('swarmStats.oldMethodHint', { usd: money(o.saved_usd), rows: o.rows })}`
  })
  const tasksHint = computed(() => {
    const l = stats.value?.today.by_label
    if (!l) return undefined
    const answered = (l.run?.ok ?? 0) + (l.ask?.ok ?? 0)
    const failed = (l.run ? l.run.tasks - l.run.ok : 0) + (l.ask ? l.ask.tasks - l.ask.ok : 0)
    return t('swarmStats.tasksHint', {
      n: answered,
      decides: l.decide?.tasks ?? 0,
      failed,
    })
  })
  // A day with no rows saved exactly nothing: $0, not "not measured".
  const todaySaved = computed(() => (stats.value ? (stats.value.today.saved_usd ?? 0) : null))
  const tiles = computed(() => [
    { key: 'today', label: t('swarmStats.savedToday'), value: money(todaySaved.value), hint: basisHint.value },
    {
      key: 'week',
      label: t('swarmStats.saved7d'),
      value: money(week.value.sum),
      hint:
        week.value.sum !== null && week.value.measured < week.value.total
          ? `${basisHint.value} ${t('swarmStats.measuredDays', { n: week.value.measured, total: week.value.total })}`
          : basisHint.value,
    },
    {
      key: 'all',
      label: t('swarmStats.savedAllTime'),
      value: money(stats.value?.total.saved_usd),
      hint: allHint.value,
    },
    {
      key: 'tasks',
      label: t('swarmStats.tasksToday'),
      value: count(stats.value ? answeredToday(stats.value) : null),
      hint: tasksHint.value,
    },
    {
      key: 'tokens',
      label: t('swarmStats.tokensKept'),
      value: count(stats.value?.today.est_tokens),
    },
  ])
  return { tiles, week }
}
