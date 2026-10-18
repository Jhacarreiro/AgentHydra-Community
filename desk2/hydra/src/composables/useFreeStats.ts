import type { FreeStatRow } from '@desk/shared/free-instances'
import { computed, ref, shallowRef } from 'vue'
import { usagePeriod } from '@/composables/useUsagePeriod'
import { freeApi } from '@/lib/free-instances'
import { freeDaysFor } from '@/lib/usage-stats'

/** The days the Usage history card shows of Desk's daily Free record (server/src/free-instances/stats.ts): its period's. */
export const freeStatDays = computed(() => freeDaysFor(usagePeriod.value))

// One copy for the card's header and its open body. A read is one small local file, so it is asked again whenever an
// account's numbers move (useFreeInstances' poll), never on a timer of its own.
const rows = shallowRef<FreeStatRow[] | null>(null)
const failed = ref(false)
let reading: Promise<void> | null = null
let readingDays = 0

/** Reads the record for the period's days; a read for days the period has since left is dropped when it answers. */
export function refreshFreeStats(): Promise<void> {
  const days = freeStatDays.value
  if (reading && readingDays === days) return reading
  readingDays = days
  const read: Promise<void> = freeApi.stats(days)
    .then((next) => {
      if (days !== freeStatDays.value) return
      if (JSON.stringify(next) !== JSON.stringify(rows.value)) rows.value = next
      failed.value = false
    })
    .catch(() => { if (days === freeStatDays.value) failed.value = rows.value === null })
    .finally(() => { if (reading === read) reading = null })
  reading = read
  return read
}

export const useFreeStats = () => ({ rows, failed })
