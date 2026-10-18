<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ChatSummary, ProjectEntry } from '@shared/protocol'
import { Check, ChevronDown, Folder } from '@lucide/vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR } from '@/components/sidebar/menuClasses'
import { sameFolder } from '@/components/composer/folders'
import { useShellSource } from './source'
import { canMoveChat, folderMove, moveNote, pickerRows, stepIndex, workspaceLabel, workspaceOf } from './workspace-picker'

// The chat's workspace: its project's name in the title bar. Clicking it moves this chat to another project's folder
// (Desk's PATCH /api/chats/:id {cwd}); an outside session's chat keeps its label and cannot move here.
const props = defineProps<{ chat: ChatSummary }>()
const src = useShellSource()

const PILL =
  'ms-1 flex h-5 min-w-16 shrink-100 items-center @max-[553px]:hidden rounded-(--radius-6) bg-(--fill-secondary) px-1.25 text-ui-sm leading-4 text-text-2'

const projects = ref<ProjectEntry[]>(src.cachedProjects?.()?.projects ?? [])
const open = ref(false)
const query = ref('')
const active = ref(0)
const error = ref<string | null>(null)
const filter = ref<HTMLInputElement | null>(null)

const movable = computed(() => canMoveChat(props.chat.id))
const workspace = computed(() => workspaceOf(props.chat.cwd, projects.value))
const label = computed(() => workspaceLabel(props.chat.cwd, projects.value))
const rows = computed(() => pickerRows(projects.value, query.value, workspace.value))
const note = computed(() => moveNote(props.chat.status))
const chooseRow = computed(() => rows.value.length)

async function refresh() {
  if (!src.projects) return
  try {
    projects.value = (await src.projects()).projects
  } catch {
    // The list it has stays; the pill keeps the folder's name until one loads.
  }
}

onMounted(refresh)

watch(open, (o) => {
  if (!o) {
    query.value = ''
    error.value = null
    return
  }
  active.value = Math.max(rows.value.findIndex((r) => r.current), 0)
  void refresh()
  void nextTick(() => filter.value?.focus())
})

watch(query, () => (active.value = 0))

async function move(path: string) {
  error.value = null
  if (workspace.value && sameFolder(workspace.value.path, path)) {
    open.value = false
    return
  }
  try {
    await src.updateChat(props.chat.id, folderMove(path))
    open.value = false
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function chooseFolder() {
  error.value = null
  try {
    const path = await src.pickFolder?.()
    if (path) await move(path)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function activate(i: number) {
  if (i < 0) return
  if (i < rows.value.length) void move(rows.value[i]!.project.path)
  else if (i === chooseRow.value) void chooseFolder()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    active.value = stepIndex(active.value, e.key === 'ArrowDown' ? 1 : -1, rows.value.length + 1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    activate(active.value)
  }
}
</script>

<template>
  <span v-if="!movable" data-fit="folder" :class="PILL" :title="chat.cwd">
    <span class="truncate">{{ label }}</span>
  </span>
  <Popover v-else v-model:open="open">
    <PopoverTrigger as-child>
      <Tip :label="chat.cwd">
        <button
          type="button"
          data-fit="folder"
          :class="[PILL, 'cursor-default gap-0.5 transition-colors duration-[60ms] hover:bg-fill-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent data-[state=open]:bg-fill-hover data-[state=open]:text-text']"
          :aria-label="`Project ${label}, change project`"
        >
          <span class="truncate">{{ label }}</span>
          <ChevronDown class="size-3 shrink-0 text-text-muted" aria-hidden="true" />
        </button>
      </Tip>
    </PopoverTrigger>
    <PopoverContent align="start" :side-offset="4" :class="[MENU_CONTENT, 'w-72 border-0 ring-0']">
      <input
        ref="filter"
        v-model="query"
        type="text"
        placeholder="Filter projects"
        aria-label="Filter projects"
        class="h-6 w-full rounded-(--radius-6) bg-bg-deepest px-2 text-ui text-text outline-none placeholder:text-text-muted focus:ring-1 focus:ring-accent"
        @keydown="onKey"
      />
      <div role="listbox" aria-label="Projects" class="mt-1 flex max-h-72 flex-col overflow-y-auto">
        <button
          v-for="(r, i) in rows"
          :key="r.project.path"
          type="button"
          role="option"
          :aria-selected="r.current"
          :title="r.project.path"
          :class="[MENU_ITEM, 'w-full justify-start text-left', active === i && 'bg-fill-hover']"
          @mouseenter="active = i"
          @click="move(r.project.path)"
        >
          <img v-if="r.project.icon" :src="r.project.icon" alt="" class="size-4 shrink-0 rounded-sm" />
          <Folder v-else class="size-4 shrink-0 text-text-2" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate">{{ r.project.name }}</span>
          <Check v-if="r.current" class="size-3.5 shrink-0 text-text-2" aria-label="Current project" />
        </button>
        <p v-if="!rows.length" class="px-2 py-1 text-ui-sm text-text-muted">No project matches</p>
      </div>
      <div role="separator" :class="MENU_SEPARATOR" />
      <button
        type="button"
        :class="[MENU_ITEM, 'w-full justify-start text-left', active === chooseRow && 'bg-fill-hover']"
        @mouseenter="active = chooseRow"
        @click="chooseFolder"
      >
        Choose another folder…
      </button>
      <p v-if="error" role="alert" class="px-2 py-1 text-ui-sm leading-4 text-danger-text">{{ error }}</p>
      <p v-if="note" class="px-2 pt-1 text-ui-sm leading-4 text-text-muted">{{ note }}</p>
    </PopoverContent>
  </Popover>
</template>
