<script setup lang="ts">
// A routine's status chip: an icon and a word, coloured only by state (ok green, failed red, running blue, paused grey).
import { computed } from 'vue'
import { CircleAlert, CircleCheck, CircleDashed, CirclePause, Hourglass, LoaderCircle } from '@lucide/vue'
import { STATUS_LABEL, type RoutineStatus } from './routine-view'

const props = defineProps<{ status: RoutineStatus }>()
const ICON = { ok: CircleCheck, failed: CircleAlert, running: LoaderCircle, paused: CirclePause, waiting: Hourglass, new: CircleDashed }
const COLOR: Record<RoutineStatus, string> = {
  ok: 'var(--success)',
  failed: 'var(--danger)',
  running: 'var(--accent)',
  paused: 'var(--text-muted)',
  waiting: 'var(--warning)',
  new: 'var(--text-muted)',
}
const icon = computed(() => ICON[props.status])
</script>

<template>
  <span class="inline-flex shrink-0 items-center gap-1 rounded-full bg-fill-5 px-2 py-0.5 text-ui-sm leading-4 shadow-[inset_0_0_0_1px_var(--border)]" :style="{ color: COLOR[status] }">
    <component :is="icon" class="size-3.5" :class="status === 'running' ? 'animate-spin' : ''" aria-hidden="true" />
    {{ STATUS_LABEL[status] }}
  </span>
</template>
