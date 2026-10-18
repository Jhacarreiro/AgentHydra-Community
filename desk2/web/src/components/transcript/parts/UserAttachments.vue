<script setup lang="ts">
// A user's attachments as fixed 120px squares in a row on the bubble's side, as Claude and Codex show them: a picture
// fills its square (a tall page from its top), a PDF shows its first page, any other file is a file card. A tile opens
// the viewer on click, Space or Enter; the viewer steps through this message's attachments in order.
import { computed, ref } from 'vue'
import type { ImageRef } from '@shared/protocol'
import FileCard from './FileCard.vue'
import AttachmentTile from '../../media/AttachmentTile.vue'
import { formatSize, imageSrc, openViewerAt, tileKey, viewerItemFor } from '../lib/media'
import { attachmentTile } from '../../../lib/picture-tile'

const props = defineProps<{ images: ImageRef[] }>()

const natural = ref<Record<number, { w: number; h: number }>>({})
const items = computed(() => props.images.map(viewerItemFor))

function tile(i: number) {
  return attachmentTile(natural.value[i]?.w ?? 0, natural.value[i]?.h ?? 0)
}
function onLoad(i: number, e: Event) {
  const el = e.target as HTMLImageElement
  natural.value = { ...natural.value, [i]: { w: el.naturalWidth, h: el.naturalHeight } }
}
function open(i: number) {
  openViewerAt(items.value, i)
}
</script>

<template>
  <div class="flex w-full flex-wrap justify-end gap-1.5" data-testid="image-gallery">
    <template v-for="(img, i) in images" :key="i">
      <AttachmentTile
        v-if="imageSrc(img)"
        as="button"
        class="cursor-zoom-in"
        :name="img.name || 'picture'"
        :size="formatSize(img.bytes)"
        :reveal-path="img.path"
        :aria-label="`Open ${img.name || 'picture'}`"
        @click="open(i)"
        @keydown="tileKey($event, () => open(i))"
        @keyup="tileKey($event, () => {})"
      >
        <img
          :src="imageSrc(img)!"
          :alt="img.name || 'picture'"
          loading="lazy"
          class="block size-full object-cover"
          :style="{ objectPosition: tile(i).objectPosition }"
          @load="onLoad(i, $event)"
        />
      </AttachmentTile>
      <FileCard v-else :file="img" @open="open(i)" />
    </template>
  </div>
</template>
