<script setup lang="ts">
import { ref } from 'vue'
import { SUS_LEVELS, type SusLevel } from '@shared/protocol'
import { Tip } from '@/components/ui/tooltip'
import { nextSusLevel, SUS_LABEL, SUS_TIP } from './sus'

const props = defineProps<{ level: SusLevel }>()
const emit = defineEmits<{ pick: [level: SusLevel] }>()
const group = ref<HTMLElement | null>(null)

const GROUP =
  'flex h-5 shrink-0 items-center gap-px rounded-[var(--radius-6)] border border-(--border) p-px'
const BUTTON =
  'h-4 rounded-[var(--radius-5)] px-1.5 text-2xs leading-none text-(--text-2) transition-colors duration-[60ms] hover:text-(--text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-text)'
const SELECTED: Record<SusLevel, string> = {
  fine: 'bg-(--fill-selected) text-(--text)',
  sus: 'bg-(--warning-bg) text-(--warning-text)',
  bad: 'bg-(--danger-bg) text-(--danger-text)',
}

function onKeydown(e: KeyboardEvent) {
  const next = nextSusLevel(props.level, e.key)
  if (!next) return
  e.preventDefault()
  emit('pick', next)
  group.value?.querySelector<HTMLElement>(`[data-sus="${next}"]`)?.focus()
}
</script>

<template>
  <div ref="group" role="radiogroup" aria-label="Sus level" :class="GROUP" @keydown="onKeydown">
    <Tip v-for="s in SUS_LEVELS" :key="s" :label="SUS_TIP[s]" side="top">
      <button
        type="button"
        role="radio"
        :data-sus="s"
        :aria-checked="level === s"
        :aria-description="SUS_TIP[s]"
        :tabindex="level === s ? 0 : -1"
        :class="[BUTTON, level === s ? SELECTED[s] : '']"
        @click="emit('pick', s)"
      >{{ SUS_LABEL[s] }}</button>
    </Tip>
  </div>
</template>
