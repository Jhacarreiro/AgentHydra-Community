<script setup lang="ts">
import { computed } from 'vue'
import { Tip } from '@/components/ui/tooltip'
import { shellGlyphs } from '@/lib/icons'
import { runPulse } from './logic'

// A row's fold button, for the chats started from it that sit under it (logic.ts nestChildren; owner, 2026-10-10: "I
// need the ability to collapse subthreads of a subagent"): at the right edge with the row's other badges, drawn as
// they are (SubBadges.vue), the group heading's chevron (pointing down while they show) and how many there are. A
// click folds them away or shows them again (folded.ts). While folded, the chevron says what the hidden ones do, as a
// folded group's heading does: orange when one needs you, the gray running pulse when one runs.
const props = defineProps<{ count: number; open: boolean; running: boolean; needsYou: boolean }>()
defineEmits<{ toggle: [] }>()
const chats = computed(() => `${props.count} ${props.count === 1 ? 'chat' : 'chats'}`)
const label = computed(() => (props.open ? `Fold the ${chats.value} started from this one` : `Show the ${chats.value} started from this one`))
const tone = computed(() => (props.open ? 'text-text-muted' : props.needsYou ? 'text-(--status-needs-you)' : props.running ? runPulse('gray') : 'text-text-muted'))
</script>

<template>
  <Tip :label="label">
    <button
      type="button"
      :aria-label="label"
      :aria-expanded="open"
      class="flex h-4 min-w-4 shrink-0 cursor-default items-center justify-center gap-0.5 rounded-sm bg-(--fill-secondary) px-1 text-2xs leading-4 text-text-muted tnum transition-colors duration-(--dur-fast) hover:bg-fill-hover"
      @click.stop="$emit('toggle')"
      @keydown.enter.stop
    >
      <component :is="shellGlyphs.groupChevron" class="size-3 shrink-0 transition-transform duration-(--dur-fast)" :class="[open && 'rotate-90', tone]" aria-hidden="true" />
      {{ count }}
    </button>
  </Tip>
</template>
