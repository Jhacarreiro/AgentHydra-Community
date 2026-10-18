<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <span
    data-slot="dropdown-menu-shortcut"
    :class="cn('text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground ms-auto text-3xs tracking-widest', props.class)"
  >
    <slot />
  </span>
</template>
