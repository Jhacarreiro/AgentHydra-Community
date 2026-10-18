<script setup lang="ts">
// One card of the session rail, as Claude Desktop draws them: its name and a chevron that folds it (remembered per card), what it
// says at a glance on the right while folded (`summary`, "1 running"), any actions at its right end, then its rows.
import { computed } from 'vue'
import { ChevronDown } from '@lucide/vue'
import { foldedCards, toggleCard } from './state'

const props = defineProps<{ id: string; title: string; summary?: string }>()
const folded = computed(() => foldedCards.value.has(props.id))
</script>

<template>
  <section class="pointer-events-auto rounded-(--radius-10) border border-(--border) bg-(--bg-panel) p-1.5 text-ui leading-5" :aria-label="title" :data-rail-card="id">
    <header class="flex h-7 min-w-0 items-center gap-1">
      <button
        type="button"
        class="flex h-6 min-w-0 cursor-default items-center gap-1 rounded-(--radius-6) px-1.5 font-medium text-text outline-none transition-colors duration-60 hover:bg-fill-hover focus-visible:shadow-(--focus-ring)"
        :aria-expanded="!folded"
        @click="toggleCard(id)"
      >
        <span class="truncate">{{ title }}</span>
        <ChevronDown class="size-3.5 shrink-0 text-text-muted transition-transform duration-150" :class="folded && '-rotate-90'" aria-hidden="true" />
      </button>
      <span class="min-w-0 flex-1" />
      <span v-if="folded && summary" class="tnum min-w-0 truncate pe-1.5 text-ui-sm text-text-muted">{{ summary }}</span>
      <slot name="actions" />
    </header>
    <div v-show="!folded">
      <slot />
    </div>
  </section>
</template>
