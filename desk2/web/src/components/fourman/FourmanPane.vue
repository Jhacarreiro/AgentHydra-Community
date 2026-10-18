<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { ChevronDown, RotateCw, X } from '@lucide/vue'
import type { FourmanBoard, FourmanScope, FourmanTier } from '@shared/fourman'
import { fourmanBoard } from './api'
import FourmanRow from './FourmanRow.vue'
import { forYou, folderName, projectChoices, projectKeysOf, tierSections, timeAgo, type ScopeChoice } from './logic'

// The To-do pane: the 4MAN board for this folder's project (or another one, or all), read only. The entry points show it
// only while 4MAN is installed (fourmanOn), so this page never has an empty or unavailable state of its own.
const props = defineProps<{ cwd: string }>()
const emit = defineEmits<{ close: [] }>()

const REFRESH_MS = 60_000
const scope = shallowRef<FourmanScope>({ kind: 'folder', cwd: props.cwd })
const board = shallowRef<FourmanBoard | null>(null)
const folderProject = ref<string | null>(null)
const projectKeys = ref<string[]>([])
const error = ref<string | null>(null)
const now = ref(Date.now())
const menuOpen = ref(false)
const openTiers = ref(new Set<FourmanTier>())
const openId = ref<string | null>(null)

const choices = computed<ScopeChoice[]>(() => projectChoices(props.cwd, folderProject.value, projectKeys.value))
const current = computed(() => choices.value.find((c) => sameScope(c.scope, scope.value))?.label ?? folderName(props.cwd))
const forYouRows = computed(() => (board.value ? forYou(board.value) : []))
const sections = computed(() => (board.value ? tierSections(board.value, openTiers.value) : []))
const ago = computed(() => (board.value ? timeAgo(board.value.fetchedAt, now.value) : ''))

function sameScope(a: FourmanScope, b: FourmanScope): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'folder' && b.kind === 'folder') return a.cwd === b.cwd
  if (a.kind === 'project' && b.kind === 'project') return a.key === b.key
  return true
}

async function load() {
  try {
    const next = await fourmanBoard(scope.value)
    board.value = next
    if (scope.value.kind === 'folder') folderProject.value = next.project
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  now.value = Date.now()
}

async function loadKeys() {
  try {
    projectKeys.value = projectKeysOf(await fourmanBoard({ kind: 'all' }))
  } catch {
    // The switcher keeps this folder's project and "All projects" until the list loads.
  }
}

function pick(choice: ScopeChoice) {
  menuOpen.value = false
  if (sameScope(choice.scope, scope.value)) return
  scope.value = choice.scope
  openId.value = null
  openTiers.value = new Set()
  void load()
}

const toggleRow = (id: string) => (openId.value = openId.value === id ? null : id)

const toggleTier = (tier: FourmanTier) => {
  const next = new Set(openTiers.value)
  if (next.has(tier)) next.delete(tier)
  else next.add(tier)
  openTiers.value = next
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void load()
  void loadKeys()
  timer = setInterval(() => void load(), REFRESH_MS)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <section class="flex min-h-0 w-full min-w-0 flex-col bg-(--bg-panel) text-text" aria-label="To-do">
    <header class="relative flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
      <button
        type="button"
        class="flex min-w-0 items-center gap-1 rounded-sm px-1 py-0.5 text-ui-sm font-medium text-text hover:bg-(--bg-popover)"
        aria-haspopup="listbox"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <span class="truncate">{{ current }}</span>
        <ChevronDown :size="12" class="shrink-0 text-text-muted" aria-hidden="true" />
      </button>
      <ul v-if="menuOpen" role="listbox" aria-label="Project" class="absolute start-2 top-8 z-20 max-h-72 min-w-44 overflow-y-auto rounded-md border border-border bg-(--bg-popover) py-1 shadow-lg">
        <li v-for="c in choices" :key="c.label + JSON.stringify(c.scope)" role="option" :aria-selected="sameScope(c.scope, scope)">
          <button type="button" class="w-full truncate px-2.5 py-1 text-start text-ui-sm text-text hover:bg-(--bg-panel)" @click="pick(c)">{{ c.label }}</button>
        </li>
      </ul>
      <div class="ms-auto flex min-w-0 items-center gap-1.5 text-2xs text-text-muted">
        <template v-if="board">
          <span class="inline-block size-1.5 shrink-0 rounded-full bg-(--success)" aria-hidden="true" />
          <span class="whitespace-nowrap">{{ board.readyCount }} ready</span>
          <span aria-hidden="true">·</span>
          <span class="whitespace-nowrap">{{ ago }}</span>
        </template>
        <button type="button" class="rounded-sm p-1 hover:bg-(--bg-popover)" aria-label="Refresh" @click="load()">
          <RotateCw :size="12" aria-hidden="true" />
        </button>
        <button type="button" class="rounded-sm p-1 hover:bg-(--bg-popover)" aria-label="Close" @click="emit('close')">
          <X :size="12" aria-hidden="true" />
        </button>
      </div>
    </header>

    <p v-if="error" class="px-2.5 py-2 text-ui-sm leading-4.5 text-danger-text">{{ error }}</p>

    <div class="min-h-0 flex-1 overflow-y-auto pb-3">
      <template v-if="board">
        <div v-if="forYouRows.length" class="mb-1">
          <div class="flex h-7 items-baseline gap-2 px-2.5 pt-2">
            <span class="text-3xs font-semibold tracking-wide text-(--accent-text) uppercase">For you</span>
            <span class="text-3xs text-text-muted">Human tasks</span>
            <span class="ms-auto font-mono text-3xs text-text-muted">{{ forYouRows.length }}</span>
          </div>
          <FourmanRow
            v-for="row in forYouRows"
            :key="row.kind + (row.kind === 'task' ? row.task.id : row.note.id)"
            :task="row.kind === 'task' ? row.task : undefined"
            :note="row.kind === 'note' ? row.note : undefined"
            for-you
            :open="row.kind === 'task' && openId === row.task.id"
            @toggle="row.kind === 'task' && toggleRow(row.task.id)"
          />
        </div>

        <div v-for="s in sections" :key="s.tier" class="mb-1">
          <div v-if="s.total" class="flex h-7 items-baseline gap-2 px-2.5 pt-2">
            <span class="text-3xs font-semibold tracking-wide text-text-2 uppercase">Tier {{ s.tier }}</span>
            <span class="text-3xs text-text-muted">{{ s.label }}</span>
            <span class="ms-auto font-mono text-3xs text-text-muted">{{ s.total }}</span>
          </div>
          <FourmanRow
            v-for="t in s.shown"
            :key="t.id"
            :task="t"
            :open="openId === t.id"
            @toggle="toggleRow(t.id)"
          />
          <button v-if="s.more" type="button" class="w-full px-2.5 py-1 text-start text-2xs text-accent-text hover:underline" @click="toggleTier(s.tier)">
            Show {{ s.more }} more
          </button>
        </div>

        <p v-if="!forYouRows.length && !board.ready.length" class="px-2.5 py-3 text-ui-sm text-text-muted">Nothing ready on this board.</p>
      </template>
      <p v-else-if="!error" class="px-2.5 py-3 text-ui-sm text-text-muted">Loading…</p>
    </div>
  </section>
</template>
