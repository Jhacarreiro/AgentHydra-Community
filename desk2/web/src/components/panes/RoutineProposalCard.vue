<script setup lang="ts">
// A routine an AI proposed, waiting for the owner's yes: a collapsed row (icon, name, Awaiting approval chip) that opens into
// why it should be a routine, when it runs, what it does, and Approve (it runs from then on) or Discard (its file is
// deleted). An AI can never approve one.
import { computed, ref } from 'vue'
import { ChevronRight, MessageSquare, Repeat } from '@lucide/vue'
import type { RoutineProposal } from '@shared/routines'
import { usePaneApi } from './api'
import { BUTTON } from './settings-styles'
import RoutineStatusChip from './RoutineStatusChip.vue'
import { localZone, scheduleSentence } from './routine-view'

const props = defineProps<{ proposal: RoutineProposal }>()
/** Approved or discarded: the parent re-reads the status. */
const emit = defineEmits<{ changed: [] }>()

const api = usePaneApi()
const busy = ref(false)
const error = ref('')
const open = ref(false)
const promptOpen = ref(false)

const when = computed(() => {
  const p = props.proposal
  if (p.schedule !== undefined) return scheduleSentence(p.schedule, localZone())
  if (p.windowsTask !== undefined) return `Windows: ${p.windowsTask.replace(/^\\/, '')}`
  return 'its own pace'
})
const what = computed(() => {
  const p = props.proposal
  // The prompt itself is shown below (clamped, Show more opens all of it): the owner approves what runs, never a cut copy.
  if (p.prompt !== undefined) return `An AI prompt in ${p.cwd ?? 'its folder'}:`
  if (p.run !== undefined) return `A command: ${p.run.join(' ')}`
  if (p.status !== undefined) return `A status command: ${p.status.join(' ')}`
  return 'Windows runs it'
})

async function act(body: { approve: string } | { discard: string }) {
  busy.value = true
  error.value = ''
  try {
    await api.routinesAct(body)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
    emit('changed')
  }
}
</script>

<template>
  <div class="mt-2 rounded-[var(--radius-6)] bg-fill-5 shadow-[inset_0_0_0_1px_var(--border)]">
    <button
      type="button"
      class="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-6)] p-3 text-start hover:bg-fill-5 focus-visible:outline-2 focus-visible:outline-accent"
      :aria-expanded="open"
      @click="open = !open"
    >
      <ChevronRight class="size-4 shrink-0 text-text-muted transition-transform" :class="open ? 'rotate-90' : ''" aria-hidden="true" />
      <component :is="proposal.prompt !== undefined ? MessageSquare : Repeat" class="size-4 shrink-0 text-text-2" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate text-ui leading-5 text-text">{{ proposal.name }}</span>
      <RoutineStatusChip status="waiting" />
      <span class="basis-full truncate ps-12 text-ui-sm leading-4.5 text-text-muted">{{ when }}</span>
    </button>
    <div v-if="open" class="border-t border-[var(--border)] p-3 pt-2">
      <div class="wrap-break-word text-ui-sm leading-4.5 text-text-2">Why: {{ proposal.why }}</div>
      <div class="mt-0.5 wrap-break-word text-ui-sm leading-4.5 text-text-muted">When: {{ when }}<template v-if="proposal.until"> · until {{ proposal.until }}</template></div>
      <div class="mt-0.5 wrap-break-word text-ui-sm leading-4.5 text-text-muted">What: {{ what }}</div>
      <template v-if="proposal.prompt !== undefined">
        <div
          class="mt-1 whitespace-pre-wrap wrap-break-word ps-2 text-ui-sm leading-4.5 text-text-2 shadow-[inset_2px_0_0_var(--border)]"
          :class="promptOpen ? 'max-h-96 overflow-y-auto' : 'line-clamp-4'"
        >{{ proposal.prompt }}</div>
        <button type="button" class="mt-0.5 text-ui-sm leading-4.5 text-accent hover:underline" :aria-expanded="promptOpen" @click="promptOpen = !promptOpen">
          {{ promptOpen ? 'Show less' : 'Show more' }}
        </button>
      </template>
      <div class="mt-0.5 wrap-break-word text-ui-sm leading-4.5 text-text-muted">Asked for by {{ proposal.askedBy }}</div>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" :class="BUTTON" :disabled="busy" @click="act({ discard: proposal.id })">Discard</button>
        <button type="button" :class="BUTTON" :disabled="busy" @click="act({ approve: proposal.id })">Approve</button>
      </div>
      <div v-if="error" role="alert" class="mt-1.5 wrap-break-word text-ui-sm leading-4.5 text-danger-text">{{ error }}</div>
    </div>
  </div>
</template>
