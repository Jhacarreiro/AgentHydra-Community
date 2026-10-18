<script setup lang="ts">
// The muted '1 running task · 2 finished' line the real app shows under the last message
// (real-running-task-and-attachments.png: 14px #898781, text at the status rows' x), 12px under the row above it as
// a reply is under a status row: the real app's 64 read as a hole (owner, 2026-10-08: "way too big of gaps"). It counts the Background tasks panel's running and finished units for this chat
// and opens the panel; nothing renders when there are neither. When a running worker gave an estimate
// (its `ETA:` line) it also says about how long is left, by the latest one.
import { computed, effectScope, onBeforeUnmount, shallowRef, watch, type EffectScope, type Ref } from 'vue'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import { useShellSource } from '@/components/shell/source'
import { useDesk } from '@/stores/desk'
import { useClock } from '@/lib/clock'
import { cleared, openBackgroundTasks } from './api'
import { doingsOf, doingTitle, latestEtaEnd, panelLists, runningLabel } from './logic'
import { useSessionTasks } from './session'

const props = defineProps<{ chat: ChatSummary; items: TranscriptItem[] }>()
const src = useShellSource()
const desk = useDesk()

// Running and finished, as the Background tasks panel lists them for this chat (its CliMayte workers, its
// own background tasks and the HSwarm jobs it called, with those the server keeps for it), minus the finished ones cleared there.
const own = useSessionTasks(computed(() => props.chat.sessionId))
const lists = computed(() =>
  panelLists({ workers: src.workers.value, items: props.items, jobs: [...desk.swarmJobs.value, ...desk.remoteSwarmJobs.value], own: own.value, sessionId: props.chat.sessionId, workerIds: props.chat.workerIds, cleared: cleared.value })
)
const etaEndsAt = computed(() => latestEtaEnd(lists.value.running))
// The longest-held running doing: what it is doing and since when, the one the row names.
const doings = computed(() => doingsOf(lists.value.running))

// A 15 s clock, only while an estimate or a doing's start is on show: the label counts whole minutes.
const clock = shallowRef<{ now: Readonly<Ref<number>> } | null>(null)
let clockScope: EffectScope | null = null
watch(
  () => etaEndsAt.value !== null || doings.value.length > 0,
  (on) => {
    if (on && !clockScope) {
      clockScope = effectScope()
      const tick = clockScope.run(() => useClock(15_000))
      clock.value = tick ? { now: tick } : null
    } else if (!on && clockScope) {
      clockScope.stop()
      clockScope = null
      clock.value = null
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => clockScope?.stop())

const now = computed(() => clock.value?.now.value ?? Date.now())
const label = computed(() => runningLabel(lists.value.running.length, lists.value.finished.length, now.value, etaEndsAt.value, doings.value))
const title = computed(() => (doings.value.length ? doingTitle(doings.value, now.value) : undefined))
</script>

<template>
  <button
    v-if="label"
    type="button"
    class="mt-3 flex h-6 items-center rounded-md px-1 text-ui-lg text-(--text-muted) outline-none transition-colors duration-60 hover:text-(--text-2) focus-visible:shadow-(--focus-ring)"
    data-running-tasks
    :title="title"
    @click="openBackgroundTasks()"
  >
    {{ label }}
  </button>
</template>
