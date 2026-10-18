<script setup lang="ts">
// The items of a project group header's right-click menu: a read-only stats block (loaded when the menu opens, a quiet
// "Loading..." until then), Open project folder, Collapse or Expand, Auto-categorize on a scratch group, and Hide.
// Rendered inside the header's ContextMenuContent; the sidebar owns the collapsed set and the hidden groups.
import { computed, onMounted, ref } from 'vue'
import type { ProjectStats } from '@shared/protocol'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { useShellSource } from '@/components/shell/source'
import { openDashboard } from '@/components/dashboard/store'
import { HIDE_TITLE } from './logic'
import { MENU_ITEM, MENU_SEPARATOR } from './menuClasses'
import { categorizing, fetchStats, isScratch, statsLines } from './projectStats'

const props = defineProps<{
  /** The project folder the group shows (its header's cwd). */
  folder: string
  /** The header's label (the folder's name). */
  label: string
  collapsed: boolean
  hidden: boolean
}>()
const emit = defineEmits<{ toggle: []; hide: [] }>()

const src = useShellSource()
/** undefined while loading; null when the stats cannot be read (nothing shows). */
const stats = ref<ProjectStats | null | undefined>(undefined)
const lines = computed(() => (stats.value ? statsLines(stats.value) : []))
const showStats = computed(() => stats.value === undefined || lines.value.length > 0)
const scratch = computed(() => isScratch(props.label))

onMounted(async () => {
  stats.value = await fetchStats(props.folder)
})

function openFolder(): void {
  src.revealFolder(props.folder).catch(() => {})
}
function categorize(): void {
  categorizing.value = props.folder
}
</script>

<template>
  <template v-if="showStats">
    <div v-if="stats === undefined" class="px-2 py-0.5 text-ui-sm leading-4.5 text-text-muted" role="status">Loading...</div>
    <div v-else class="px-2 py-0.5 text-ui-sm leading-4.5 text-text-muted" aria-label="Project stats">
      <div v-for="line in lines" :key="line">{{ line }}</div>
    </div>
    <div :class="MENU_SEPARATOR" />
  </template>
  <ContextMenuItem :class="MENU_ITEM" @select="openFolder">
    <span class="flex-1">Open project folder</span>
  </ContextMenuItem>
  <ContextMenuItem :class="MENU_ITEM" @select="openDashboard(folder)">
    <span class="flex-1">Open dashboard</span>
  </ContextMenuItem>
  <ContextMenuItem :class="MENU_ITEM" @select="emit('toggle')">
    <span class="flex-1">{{ collapsed ? 'Expand' : 'Collapse' }}</span>
  </ContextMenuItem>
  <ContextMenuItem v-if="scratch" :class="MENU_ITEM" @select="categorize">
    <span class="flex-1">Auto-categorize chats</span>
  </ContextMenuItem>
  <div :class="MENU_SEPARATOR" />
  <ContextMenuItem :class="MENU_ITEM" :title="hidden ? undefined : HIDE_TITLE" @select="emit('hide')">
    <span class="flex-1">{{ hidden ? 'Unhide' : 'Hide' }}</span>
  </ContextMenuItem>
</template>
