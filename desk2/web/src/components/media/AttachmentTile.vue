<script setup lang="ts">
// One attachment as a 120px square: the thumbnail (a picture, a PDF's first page, or nothing for a plain file) fills it,
// the file type sits top left, and the name and size sit on a soft scrim at the foot. Shared by the message box and the
// sent message so both look the same.
import { computed } from 'vue'

const props = defineProps<{ name: string; size?: string; as?: 'button' | 'div'; revealPath?: string }>()

const typeLabel = computed(() => /\.([A-Za-z0-9]{1,5})$/.exec(props.name)?.[1]?.toUpperCase() ?? 'FILE')
</script>

<template>
  <component :is="as ?? 'div'" :type="as === 'button' ? 'button' : undefined" class="attachment-tile" :data-reveal-path="revealPath">
    <slot />
    <span class="attachment-type">{{ typeLabel }}</span>
    <span class="attachment-caption">
      <span class="attachment-name">{{ name || 'file' }}</span>
      <span v-if="size" class="attachment-size">{{ size }}</span>
    </span>
  </component>
</template>

<style scoped>
.attachment-tile {
  position: relative;
  display: block;
  flex-shrink: 0;
  width: 120px;
  height: 120px;
  overflow: hidden;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: #202022;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  text-align: start;
}
.attachment-caption {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 36px 10px 10px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.5) 40%, transparent 100%);
  transition: background 0.25s;
  pointer-events: none;
}
.attachment-tile:hover .attachment-caption {
  background: linear-gradient(to top, rgba(0, 0, 0, 0.95) 0%, rgba(0, 0, 0, 0.65) 45%, rgba(0, 0, 0, 0.05) 100%);
}
.attachment-name {
  display: block;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  color: #fff;
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8), 0 1px 1px rgba(0, 0, 0, 0.5);
}
.attachment-size {
  display: block;
  color: rgba(255, 255, 255, 0.7);
  font-size: 10px;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}
.attachment-type {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 3px 6px;
  border-radius: 5px;
  border: 0.5px solid rgba(255, 255, 255, 0.2);
  background: rgba(15, 15, 15, 0.55);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  color: #fff;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.5px;
  line-height: 1;
  white-space: nowrap;
  pointer-events: none;
}
</style>
