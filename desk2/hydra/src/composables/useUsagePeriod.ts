import { useStorage } from '@vueuse/core'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { freeDaysFor, FREE_KEPT_DAYS, type UsagePeriod } from '@/lib/usage-stats'

// The Usage history card's period (24 hours, 7 days, 30 days, All time), remembered: the Desktop, CLI and Free blocks
// and the header line all read it, so one copy.
export const usagePeriod = useStorage<UsagePeriod>('agenthydra.instances.usagePeriod', '7d')

/** The period in words, for Desktop and CLI ("in the last 7 days") and for Free, whose record is days ("today"). */
export function useUsageSpan() {
  const { t } = useI18n()
  const span = computed(() => t(`instances.summary.span.${usagePeriod.value}`))
  const freeSpan = computed(() => {
    const days = freeDaysFor(usagePeriod.value)
    if (usagePeriod.value === 'all') return t('instances.summary.span.freeKept', { n: FREE_KEPT_DAYS })
    return days === 1 ? t('instances.summary.span.today') : t('instances.summary.span.days', { n: days })
  })
  return { span, freeSpan }
}
