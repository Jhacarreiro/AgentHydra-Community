<script setup lang="ts">
// A message's pictures as a responsive gallery (rule: lib/gallery.ts): one stays large, several share the row
// width at their own aspect ratio and wrap into rows that fit the column, whatever its width. A tile opens the
// viewer on click or Space; the viewer steps through this message's pictures. A ref with nothing to load
// (history without bytes) is a name chip.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ImageRef } from '@shared/protocol'
import FileCard from './FileCard.vue'
import HtmlPreview from './HtmlPreview.vue'
import { aspectOf, galleryLayout } from '../lib/gallery'
import { htmlSrc, imageSrc, openViewerAt, tileKey, viewerItemFor } from '../lib/media'

const props = defineProps<{ images: ImageRef[] }>()

const root = ref<HTMLElement | null>(null)
const width = ref(0)
// Each picture's aspect ratio once it has loaded; until then 4:3.
const aspects = ref<Record<number, number>>({})

const pictures = computed(() => props.images.flatMap((img, i) => (imageSrc(img) ? [{ i, src: imageSrc(img)!, alt: img.name ?? '' }] : [])))
const sizes = computed(() =>
  galleryLayout(
    pictures.value.map((p) => aspects.value[p.i] ?? aspectOf(0, 0)),
    width.value || 480,
  ),
)
const sizeOf = computed(() => new Map(pictures.value.map((p, k) => [p.i, sizes.value[k]!])))

function onLoad(i: number, e: Event) {
  const el = e.target as HTMLImageElement
  aspects.value = { ...aspects.value, [i]: aspectOf(el.naturalWidth, el.naturalHeight) }
}
const items = computed(() => props.images.map(viewerItemFor))
function open(i: number) {
  openViewerAt(items.value, i)
}

let observer: ResizeObserver | null = null
onMounted(() => {
  if (!root.value) return
  width.value = root.value.clientWidth
  if (typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver((entries) => {
    const w = Math.floor(entries[0]?.contentRect.width ?? 0)
    if (w > 0 && w !== width.value) width.value = w
  })
  observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div ref="root" class="flex w-full flex-wrap gap-2" data-testid="image-gallery">
    <template v-for="(img, i) in images" :key="i">
      <button
        v-if="imageSrc(img)"
        type="button"
        class="tx-tile"
        :data-reveal-path="img.path"
        :style="sizeOf.get(i) ? { width: `${sizeOf.get(i)!.width}px`, height: `${sizeOf.get(i)!.height}px` } : undefined"
        :aria-label="`Open ${img.name || 'picture'}`"
        @click="open(i)"
        @keydown="tileKey($event, () => open(i))"
        @keyup="tileKey($event, () => {})"
      >
        <img :src="imageSrc(img)!" :alt="img.name || 'picture'" loading="lazy" @load="onLoad(i, $event)" />
      </button>
      <HtmlPreview v-else-if="htmlSrc(img)" :src="htmlSrc(img)!" :name="img.name" />
      <FileCard v-else :file="img" @open="open(i)" />
    </template>
  </div>
</template>
