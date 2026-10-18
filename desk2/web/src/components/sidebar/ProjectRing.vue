<script setup lang="ts">
import { computed } from 'vue'
import { glyphDotClass, glyphRingClass, isQuiet, type StatusGlyph } from './logic'

// The compact mode's lead (compact.ts): a row's project icon where its status dot was, inside a square ring (r4; owner,
// 2026-10-10: "less rounded") when the chat has something going on (glyphRingClass). The ring is 22px and 1px wide, cut
// out of a gradient with a mask so the 2px gap before the 16px icon shows whatever is under the row (a selected or
// hovered row's fill too), and only the ring blinks or pulses, never the icon. Whole pixels (owner, 2026-10-10: "one
// side is thicker than the other"): at 1.5px the mask's inner edge rounded to 2px on the left and top and 1px on the
// right and bottom, at every display scale; 1px is even at 100% and 200% and within a quarter pixel at 125% and 150%. A row keeps its 26px height. A project with
// no icon (the group header's fallback) keeps the dot in the middle, so the state still shows.
// The icon dims once the row is quiet (logic.ts isQuiet), as its title does, unless the row is the one open (owner,
// 2026-10-10: "the outline ... strobes when it's working and lights up when I need to do something, and the text dims
// when it is not working. Can you also have the logo dim when it's done?").
const props = defineProps<{ glyph: StatusGlyph; icon: string | null; selected?: boolean }>()
const ring = computed(() => glyphRingClass(props.glyph))
const quiet = computed(() => isQuiet(props.glyph, !!props.selected))
</script>

<template>
  <span role="img" :aria-label="glyph.label" class="relative flex size-5.5 shrink-0 items-center justify-center">
    <span
      v-if="ring"
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 rounded-[4px] p-px [mask:linear-gradient(#000_0_0)_content-box_exclude,linear-gradient(#000_0_0)]"
      :class="ring"
    />
    <img
      v-if="icon"
      :src="icon"
      alt=""
      class="size-4 rounded-[3px] transition-opacity duration-(--dur-fast) ease-(--ease-snap)"
      :class="{ 'opacity-50': quiet }"
    />
    <span v-else class="size-1.5 rounded-full" :class="glyphDotClass({ shape: glyph.shape, tone: glyph.tone, motion: 'none' })" />
  </span>
</template>
