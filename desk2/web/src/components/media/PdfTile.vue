<script setup lang="ts">
// A PDF as its first page in an attachment tile, the page filling it from the top. Until the page is rendered, or when it
// cannot be (encrypted, broken, too slow), the tile is the plain file tile. Listeners and attributes fall through to it.
import { ref, watch } from 'vue'
import { pdfFirstPageThumb } from '../../lib/pdf-thumb'
import { renderPdfFirstPage } from '../../lib/pdf-render'
import AttachmentTile from './AttachmentTile.vue'

const props = defineProps<{
  source: string | Blob | null | undefined
  cacheKey: string
  height: number
  name: string
  sizeLabel: string
  revealPath?: string
  as?: 'button' | 'div'
}>()

const thumb = ref<string | null>(null)

let latest = 0
watch(
  () => [props.source, props.cacheKey, props.height] as const,
  async ([source, key, height]) => {
    const run = ++latest
    thumb.value = null
    if (!source) return
    const url = await pdfFirstPageThumb(key, height, () => renderPdfFirstPage(source, height))
    if (run === latest) thumb.value = url
  },
  { immediate: true },
)
</script>

<template>
  <AttachmentTile :name="name" :size="sizeLabel" :reveal-path="revealPath" :as="as" :data-testid="thumb ? 'pdf-tile' : undefined">
    <img v-if="thumb" :src="thumb" alt="" draggable="false" class="block size-full object-cover object-top" />
  </AttachmentTile>
</template>
