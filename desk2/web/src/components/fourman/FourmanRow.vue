<script setup lang="ts">
import { computed } from 'vue'
import { User } from '@lucide/vue'
import type { FourmanNote, FourmanTask } from '@shared/fourman'
import { claimInitials } from './logic'

// One line per task or note; a task opens to show its body and why its tier. Read only: nothing here changes the board.
const props = defineProps<{ task?: FourmanTask; note?: FourmanNote; forYou?: boolean; open?: boolean }>()
const emit = defineEmits<{ toggle: [] }>()

const title = computed(() => props.task?.title ?? props.note?.title ?? '')
const chip = computed(() => (props.task?.claimedBy ? claimInitials(props.task.claimedBy) : null))
</script>

<template>
  <div class="border-b border-border last:border-b-0" :class="forYou ? 'border-s-2 border-s-(--accent)' : ''">
    <button
      type="button"
      class="flex h-7 w-full min-w-0 items-center gap-1.5 px-2.5 text-start hover:bg-(--bg-popover) focus-visible:outline-none focus-visible:shadow-(--focus-ring)"
      :aria-expanded="task ? open : undefined"
      :disabled="!task"
      @click="emit('toggle')"
    >
      <User v-if="forYou" :size="11" class="shrink-0 text-(--warning)" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate text-ui-sm leading-4 text-text" :class="note?.done ? 'line-through' : ''">{{ title }}</span>
      <template v-if="task">
        <span v-if="task.live" class="rounded-sm bg-(--danger-bg) px-1 font-mono text-[9px] font-semibold leading-3.5 text-(--danger-text)">LIVE</span>
        <span class="rounded-sm border border-border px-1 font-mono text-[9px] leading-3.5 text-text-muted">{{ task.type }}</span>
        <span class="rounded-sm border border-border px-1 font-mono text-[9px] leading-3.5 text-text-muted">{{ task.size }}</span>
        <span class="rounded-sm border border-border px-1 font-mono text-[9px] leading-3.5 text-text-muted">I:{{ task.impact }}</span>
        <span
          v-if="chip"
          class="flex size-4 shrink-0 items-center justify-center rounded-full bg-(--accent-bg) font-mono text-[8px] text-(--accent-text)"
          :title="task.claimedBy ?? undefined"
        >{{ chip }}</span>
        <span v-else class="size-4 shrink-0 rounded-full border border-dashed border-text-muted" aria-label="Nobody has claimed it" />
      </template>
      <span v-else-if="note?.due" class="shrink-0 font-mono text-3xs text-text-muted">{{ note.due }}</span>
    </button>
    <div v-if="task && open" class="flex flex-col gap-1.5 px-2.5 pb-2 ps-6 text-ui-sm leading-4.5 text-text-2">
      <p v-if="task.body" class="whitespace-pre-wrap wrap-break-word">{{ task.body }}</p>
      <p v-if="task.tierWhy" class="text-text-muted"><span class="text-text-2">Why this tier:</span> {{ task.tierWhy }}</p>
    </div>
  </div>
</template>
