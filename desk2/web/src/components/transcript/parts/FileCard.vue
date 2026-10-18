<script setup lang="ts">
// A file as an attachment tile, a button that opens the viewer on click, Space or Enter: a PDF shows its first page,
// any other file its type and name. The parent opens the viewer on the message's attachments (emit 'open').
import type { ImageRef } from '@shared/protocol'
import { formatSize, pdfSrc, tileKey } from '../lib/media'
import PdfTile from '../../media/PdfTile.vue'
import AttachmentTile from '../../media/AttachmentTile.vue'

const props = defineProps<{ file: ImageRef }>()
const emit = defineEmits<{ open: [] }>()

function onKeydown(e: KeyboardEvent) {
  tileKey(e, () => emit('open'))
}
function onKeyup(e: KeyboardEvent) {
  tileKey(e, () => {})
}
</script>

<template>
  <PdfTile
    v-if="pdfSrc(file)"
    as="button"
    :source="pdfSrc(file)"
    :cache-key="pdfSrc(file)!"
    :height="120"
    :name="file.name || 'file'"
    :size-label="formatSize(file.bytes)"
    :reveal-path="file.path"
    :aria-label="`Open ${file.name || 'file'}`"
    @click="emit('open')"
    @keydown="onKeydown"
    @keyup="onKeyup"
  />
  <AttachmentTile
    v-else
    as="button"
    :name="file.name || 'file'"
    :size="formatSize(file.bytes)"
    :reveal-path="file.path"
    :aria-label="`Open ${file.name || 'file'}`"
    @click="emit('open')"
    @keydown="onKeydown"
    @keyup="onKeyup"
  />
</template>
