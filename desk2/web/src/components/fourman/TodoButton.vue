<script setup lang="ts">
import { computed } from 'vue'
import { ListTodo } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import { HEADER_BTN } from '@/components/sidebar/rowClasses'
import { todoEntryShown, todoPressed } from './logic'
import { fourmanAvailable, requestTodo, todoShowing } from './store'

// A sidebar group's To-do button, beside its dashboard button: only where 4MAN is installed. A second click closes the pane.
const props = defineProps<{ folder: string | null; label: string }>()
const shown = computed(() => todoEntryShown(fourmanAvailable.value, props.folder))
const pressed = computed(() => todoPressed(todoShowing.value, props.folder))
const tip = computed(() => `${pressed.value ? 'Close' : 'Open'} the ${props.label} to-do`)

function toggle(): void {
  if (props.folder) requestTodo(props.folder)
}
</script>

<template>
  <Tip v-if="shown" :label="tip">
    <button type="button" :class="[HEADER_BTN, pressed && 'bg-fill-hover text-text']" :aria-label="tip" :aria-pressed="pressed" @click="toggle">
      <ListTodo class="size-3.5" aria-hidden="true" />
    </button>
  </Tip>
</template>
