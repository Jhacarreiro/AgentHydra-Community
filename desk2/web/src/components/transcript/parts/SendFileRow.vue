<script setup lang="ts">
// Files the assistant hands over (SendUserFile), as the real app draws them: with display 'render' a
// picture inline (at most 360 high, r5, 1px ring, zoom on click) and a video playing in place, the caption
// as prose, then a file card per file. Until the result lands the files are not known; the caption shows alone.
import { computed } from 'vue'
import type { ImageRef, TranscriptItem } from '@shared/protocol'
import { Tip } from '@/components/ui/tooltip'
import { useTranscript } from '../context'
import { imageSrc, openViewerAt, tileKey, videoSrc, viewerItemFor } from '../lib/media'
import FileCard from './FileCard.vue'
import MarkdownBlock from './MarkdownBlock.vue'

const props = defineProps<{ item: Extract<TranscriptItem, { kind: 'tool_use' }> }>()
const ctx = useTranscript()
/** The newest live row (ctx.shimmerId): the one line that shimmers. */
const shimmer = computed(() => (ctx.shimmerId ? ctx.shimmerId.value === props.item.id : true))

const files = computed(() => props.item.result?.images ?? [])
const caption = computed(() => (typeof props.item.input.caption === 'string' ? props.item.input.caption : ''))
const render = computed(() => props.item.input.display !== 'attach')
const pictures = computed(() => (render.value ? files.value.filter((f) => imageSrc(f)) : []))
const videos = computed(() => (render.value ? files.value.filter((f) => videoSrc(f)) : []))
const viewerItems = computed(() => files.value.map(viewerItemFor))
function openAt(f: ImageRef) {
  openViewerAt(viewerItems.value, files.value.indexOf(f))
}
</script>

<template>
  <div class="flex flex-col gap-2.5">
    <button
      v-for="(f, i) in pictures"
      :key="`p${i}`"
      type="button"
      class="tx-inline-picture"
      :data-reveal-path="f.path"
      :aria-label="`Open ${f.name || 'picture'}`"
      @click="openAt(f)"
      @keydown="tileKey($event, () => openAt(f))"
      @keyup="tileKey($event, () => {})"
    >
      <img :src="imageSrc(f)!" :alt="f.name || 'picture'" loading="lazy" />
    </button>
    <Tip v-for="(f, i) in videos" :key="`v${i}`" :label="f.name || 'video'">
      <video
        class="tx-inline-video"
        :src="videoSrc(f)!"
        :data-reveal-path="f.path"
        :aria-label="f.name || 'video'"
        controls
        autoplay
        muted
        loop
        playsinline
        preload="metadata"
      />
    </Tip>
    <MarkdownBlock v-if="caption" :text="caption" />
    <div v-if="files.length" class="flex flex-wrap gap-2 ps-0">
      <FileCard v-for="(f, i) in files" :key="`f${i}`" :file="f" @open="openAt(f)" />
    </div>
    <div v-else-if="item.status === 'running'" class="px-1 text-ui-lg leading-5 text-text-muted"><span :class="shimmer && 'tx-shimmer'">Sending a file</span></div>
    <div v-else-if="item.result?.isError" class="px-1 text-ui-lg leading-5 text-danger-text">{{ item.result.text || 'The file could not be sent' }}</div>
  </div>
</template>
