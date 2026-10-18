<script setup lang="ts">
// An html file a reply shows as a live preview: the same card a markdown image of one draws (lib/markdown.ts
// htmlPreviewMarkup: the page in a sandboxed frame, no script, no origin of the window's, no forms or popups), its
// buttons worked by the same handler. Phone narrows the page to a phone's width, to see a marketing email as its
// recipients will on a phone; Expand makes it taller.
import { computed } from 'vue'
import { htmlPreviewMarkup } from '../lib/markdown'
import { htmlPreviewClick } from '../lib/media'

const props = defineProps<{ src: string; name?: string }>()

const markup = computed(() => htmlPreviewMarkup(props.src, props.name || 'Preview'))
</script>

<template>
  <!-- the markup is htmlPreviewMarkup's own, its src and name escaped there -->
  <div class="contents" data-testid="html-preview" v-html="markup" @click="htmlPreviewClick($event.target as Element)" />
</template>
