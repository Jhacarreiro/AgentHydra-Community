<script setup lang="ts">
import { computed } from 'vue'
import { Tip } from '@/components/ui/tooltip'
import { HEADER_BTN } from '@/components/sidebar/rowClasses'
import { DashboardGlyph } from './glyph'
import { hasSite, showingDashboard } from './logic'
import { closeDashboard, dashboardCwd, dashboardList, dashboardOpen, openDashboard } from './store'

// A sidebar group's dashboard button, beside its New session +: only for a project whose chats wrote a site (the desk list
// and the cloud list each draw one per group head; the sidebar keeps dashboardList fresh). A second click closes the page.
const props = defineProps<{ folder: string | null; label: string }>()
const shown = computed(() => !!props.folder && hasSite(dashboardList.value, props.folder))
const showing = computed(() => !!props.folder && showingDashboard(dashboardOpen.value, dashboardCwd.value, props.folder))
const tip = computed(() => `${showing.value ? 'Close' : 'Open'} the ${props.label} dashboard`)

function toggle(): void {
  if (showing.value) closeDashboard()
  else openDashboard(props.folder!)
}
</script>

<template>
  <Tip v-if="shown" :label="tip">
    <button type="button" :class="[HEADER_BTN, showing && 'bg-fill-hover text-text']" :aria-label="tip" :aria-pressed="showing" @click="toggle">
      <DashboardGlyph class="size-3.5" aria-hidden="true" />
    </button>
  </Tip>
</template>
