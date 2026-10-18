<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { AppWindow, ArrowLeft, Copy, ExternalLink, RotateCw } from '@lucide/vue'
import type { Dashboard } from '@shared/dashboards'
import type { ProjectEntry } from '@shared/protocol'
import { useShellSource } from '@/components/shell/source'
import { Tip } from '@/components/ui/tooltip'
import { getDashboard } from './api'
import { DashboardGlyph } from './glyph'
import { EXAMPLE_PROMPT, timeAgo, workspaceKey } from './logic'
import { closeDashboard, openDashboardTab, refreshDashboards } from './store'

// The project dashboard, a page in the sliding track (DeskFrame). Its site is framed on the daemon's own origin, and the
// frame is re-keyed when the newest file changes, so a chat's write shows by itself. One read loop, every 3 seconds,
// only while the page is on screen.
const props = defineProps<{ cwd: string | null; active: boolean; padLeft: number }>()
const src = useShellSource()
const POLL_MS = 3000

const dash = shallowRef<Dashboard | null>(null)
const project = shallowRef<ProjectEntry | null>(null)
const problem = ref<string | null>(null)
const loaded = ref(false)
const now = ref(Date.now())
const reloads = ref(0)
const folderName = computed(() => (props.cwd ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '')
const title = computed(() => dash.value?.name || project.value?.name || folderName.value)
const hasSite = computed(() => (dash.value?.files ?? 0) > 0)
const frameKey = computed(() => `${dash.value?.updatedAt ?? ''}#${reloads.value}`)
const updated = computed(() => {
  const ago = timeAgo(dash.value?.updatedAt, now.value)
  if (!ago) return ''
  const by = dash.value?.updatedBy
  return by ? `Updated ${ago} by ${by}` : `Updated ${ago}`
})

let timer: ReturnType<typeof setInterval> | undefined
let seq = 0

async function load(): Promise<void> {
  const cwd = props.cwd
  if (!cwd) return
  const mine = ++seq
  try {
    const d = await getDashboard(cwd)
    if (mine !== seq) return
    dash.value = d
    problem.value = null
    void refreshDashboards()
  } catch (err) {
    if (mine !== seq) return
    problem.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (mine === seq) {
      loaded.value = true
      now.value = Date.now()
    }
  }
}

async function loadProject(cwd: string): Promise<void> {
  const res = await src.projects?.({ hidden: true }).catch(() => null)
  const key = workspaceKey(cwd)
  project.value = res?.projects.find((p) => workspaceKey(p.path) === key) ?? null
}

function start(): void {
  stop()
  void load()
  timer = setInterval(() => {
    now.value = Date.now()
    void load()
  }, POLL_MS)
}
function stop(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

watch(
  () => [props.active, props.cwd] as const,
  ([active, cwd], prev) => {
    if (cwd !== prev?.[1]) {
      dash.value = null
      loaded.value = false
      problem.value = null
      project.value = null
      if (cwd) void loadProject(cwd)
    }
    if (active && cwd) start()
    else if (!active) stop()
  },
  { immediate: true }
)
onBeforeUnmount(stop)

function reload(): void {
  reloads.value++
  void load()
}

// Its own tab: one in Desk's browser pane, or one in the person's web browser (the host hands a foreign address to it).
const openInTab = () => props.cwd && dash.value?.url && openDashboardTab(props.cwd, dash.value.url)
const openOutside = () => dash.value?.url && window.open(dash.value.url, '_blank', 'noopener')

const copied = ref(false)
function copyText(text: string): void {
  void navigator.clipboard.writeText(text).then(() => {
    copied.value = true
    setTimeout(() => (copied.value = false), 1400)
  })
}
const copyFolder = () => copyText(dash.value?.folder || props.cwd || '')
const copyPrompt = () => copyText(EXAMPLE_PROMPT)
</script>

<template>
  <section class="flex h-full min-w-0 flex-1 flex-col bg-(--bg-page)" data-testid="dashboard-page" :aria-label="`Dashboard for ${title}`">
    <!-- The window's title row when it draws its own (lib/host-window.ts): it drags the window, and keeps clear of its buttons.
         In a narrow row the Open buttons show only their icons, and their tooltips say which is which. -->
    <header class="@container title-drag flex h-10.25 shrink-0 items-center gap-2 pe-[calc(0.75rem+var(--caption-w))]" :style="{ paddingInlineStart: `${padLeft}px` }">
      <Tip label="Back to the chat">
        <button type="button" aria-label="Back to the chat" class="flex size-7 shrink-0 items-center justify-center rounded-(--radius-8) text-text-2 hover:bg-fill-hover hover:text-text" @click="closeDashboard()">
          <ArrowLeft class="size-4" aria-hidden="true" />
        </button>
      </Tip>
      <span class="flex size-6 shrink-0 items-center justify-center rounded-(--radius-6) bg-(--fill-secondary) text-text-2">
        <DashboardGlyph class="size-3.5" aria-hidden="true" />
      </span>
      <div class="flex min-w-0 flex-1 items-baseline gap-2">
        <h2 class="truncate text-[15px] leading-5 font-semibold text-text">{{ title }}</h2>
        <span v-if="updated" class="min-w-0 truncate text-2xs leading-4 text-text-muted">{{ updated }}</span>
      </div>
      <Tip label="Reload">
        <button type="button" aria-label="Reload dashboard" class="flex size-7 shrink-0 items-center justify-center rounded-(--radius-8) text-text-2 hover:bg-fill-hover hover:text-text" @click="reload">
          <RotateCw class="size-3.5" aria-hidden="true" />
        </button>
      </Tip>
      <template v-if="hasSite">
        <Tip label="Open in a tab of Desk's browser pane">
          <button type="button" class="flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-(--radius-8) text-ui-sm leading-4 text-text-2 hover:bg-fill-hover hover:text-text @2xl:px-2" @click="openInTab">
            <AppWindow class="size-3.5" aria-hidden="true" /><span class="sr-only @2xl:not-sr-only">Open in tab</span>
          </button>
        </Tip>
        <Tip label="Open in your web browser">
          <button type="button" class="flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-(--radius-8) text-ui-sm leading-4 text-text-2 hover:bg-fill-hover hover:text-text @2xl:px-2" @click="openOutside">
            <ExternalLink class="size-3.5" aria-hidden="true" /><span class="sr-only @2xl:not-sr-only">Open in browser</span>
          </button>
        </Tip>
      </template>
      <Tip :label="copied ? 'Copied' : 'Copy folder path'">
        <button type="button" aria-label="Copy folder path" class="flex size-7 shrink-0 items-center justify-center rounded-(--radius-8) text-text-2 hover:bg-fill-hover hover:text-text" @click="copyFolder">
          <Copy class="size-3.5" aria-hidden="true" />
        </button>
      </Tip>
    </header>

    <p v-if="problem" role="alert" class="shrink-0 px-6 pb-2 text-ui-sm leading-4 text-text-muted">
      Could not reach AgentHydra: <span class="text-danger">{{ problem }}</span>
    </p>

    <iframe
      v-if="dash && hasSite"
      :key="frameKey"
      :src="dash.url"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
      :title="`${title} dashboard`"
      class="min-h-0 w-full flex-1 border-0 bg-white"
    />

    <div v-else-if="loaded && !problem" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <h3 class="text-[15px] leading-5 font-semibold text-text">No dashboard yet</h3>
      <p class="max-w-md text-ui leading-5 text-text-muted">
        This project has no dashboard yet. A chat in it builds one: a page of any HTML, CSS, JavaScript or data, with whatever it wants on it. It writes the page with dashboard_write on the agenthydra MCP.
      </p>
      <div class="flex items-center gap-2 rounded-(--radius-8) bg-fill-5 py-1.5 ps-3 pe-1.5">
        <code class="text-ui-sm leading-4 text-text-2">{{ EXAMPLE_PROMPT }}</code>
        <button type="button" class="flex h-6 items-center gap-1 rounded-(--radius-5) bg-(--fill-secondary) px-2 text-ui-sm leading-4 text-text-2 hover:text-text" @click="copyPrompt">
          <Copy class="size-3" aria-hidden="true" />{{ copied ? 'Copied' : 'Copy' }}
        </button>
      </div>
    </div>
  </section>
</template>
