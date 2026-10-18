<script setup lang="ts">
// A run of tool calls folded into one status row, as the real app draws it: "Ran 3 commands, read
// screen-half.png" in muted 14px, targets in primary text, a 12px chevron. Open, it lists each call
// (a CliMayte call with its task and worker card) as the rows of one rounded box split by hairlines, as Claude
// Desktop draws a run's steps (owner, 2026-10-08: "contained in a rounded-edged table"); a step opens inside
// the box, under its row. A thinking block of the run is one of its steps: a run is every tool call and thinking
// block with nothing else between them (owner, 2026-10-08: seven status rows between two paragraphs became one).
// The pictures its calls returned (a Read of a screenshot) sit at the line's right end as thumbnails the line's
// height, as Claude Desktop draws them (owner, 2026-10-14: "I would like that working as well"); a click opens
// the viewer, which steps through the run's pictures.
import { computed } from 'vue'
import { useTranscript } from '../context'
import { toolSummary, type RunItem, type TaskItem } from '../lib/groups'
import { imageSrc, openViewerAt, tileKey, viewerItemFor } from '../lib/media'
import { toolFamily } from '../lib/tools'
import CliMayteCard from './CliMayteCard.vue'
import StatusRow from './StatusRow.vue'
import ThinkingRow from './ThinkingRow.vue'
import ToolRow from './ToolRow.vue'
import TaskGroup from './TaskGroup.vue'
import Collapse from './Collapse.vue'

const props = defineProps<{ id: string; items: RunItem[]; tasks?: TaskItem[] }>()
const ctx = useTranscript()
const open = computed(() => ctx.isOpen(props.id))
const sum = computed(() => toolSummary(props.items, ctx.cwd.value, props.tasks))
/** Running and the newest live row (ctx.shimmerId): the one line that shimmers. */
const shimmer = computed(() => sum.value.running && (ctx.shimmerId ? ctx.shimmerId.value === props.id : true))

/** Thumbnails on the line; past them, a count. */
const THUMBS = 3
const pictures = computed(() => props.items.flatMap((t) => (t.kind === 'thinking' ? [] : (t.result?.images ?? []).filter((img) => imageSrc(img)))))
const viewer = computed(() => pictures.value.map(viewerItemFor))
const more = computed(() => pictures.value.length - THUMBS)
</script>

<template>
  <div>
    <div :class="pictures.length ? 'flex min-w-0 items-center gap-2' : undefined">
      <StatusRow :open="open" :running="sum.running" @toggle="ctx.toggle(id)">
        <!-- one line: template whitespace would show as stray spaces -->
        <span class="min-w-0 truncate" :class="shimmer && 'tx-shimmer'"><template v-for="(p, i) in sum.phrases" :key="i">{{ i ? ', ' : '' }}{{ p.text }}{{ p.target ? ' ' : '' }}<span v-if="p.target" class="tx-target ms-0.75">{{ p.target }}</span>{{ p.after ? ' ' + p.after : '' }}</template></span>
        <template #after>
          <span v-if="sum.added || sum.removed" class="shrink-0 font-mono text-ui-sm tabular-nums">
            <span class="text-git-add">+{{ sum.added }}</span>
            <span v-if="sum.removed" class="ms-1 text-git-del">-{{ sum.removed }}</span>
          </span>
        </template>
      </StatusRow>
      <span v-if="pictures.length" class="ms-auto flex shrink-0 items-center gap-1" data-testid="run-thumbs">
        <button
          v-for="(img, k) in pictures.slice(0, THUMBS)"
          :key="k"
          type="button"
          class="block h-6 shrink-0 cursor-default overflow-hidden rounded-(--radius-4) border border-(--border) bg-(--bg-picture) outline-none transition-opacity duration-60 hover:opacity-80 focus-visible:shadow-(--focus-ring)"
          :aria-label="`Open ${img.name || 'picture'}`"
          @click="openViewerAt(viewer, k)"
          @keydown="tileKey($event, () => openViewerAt(viewer, k))"
          @keyup="tileKey($event, () => {})"
        >
          <img :src="imageSrc(img)!" alt="" loading="lazy" class="block h-full w-auto min-w-3.5 max-w-10 object-cover" />
        </button>
        <span v-if="more > 0" class="tnum text-ui-sm text-text-muted">+{{ more }}</span>
      </span>
    </div>
    <Collapse :open="open">
      <div class="tx-steps mb-1 mt-1.5">
        <template v-for="t in items" :key="t.id">
          <ThinkingRow v-if="t.kind === 'thinking'" :id="t.id" :text="t.text" :streaming="t.streaming" step />
          <CliMayteCard v-else-if="toolFamily(t.name) === 'climayte'" :item="t" step />
          <ToolRow v-else :item="t" step />
        </template>
        <TaskGroup v-if="tasks?.length" :id="`${id}:tasks`" :items="tasks" step />
      </div>
    </Collapse>
  </div>
</template>
