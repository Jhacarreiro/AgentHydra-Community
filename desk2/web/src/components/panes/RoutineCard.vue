<script setup lang="ts">
// One routine on the Routines list: a collapsed row (icon, name, status chip, last run, next run, what the last run did when
// it is described, and its own on/off switch) that opens into its schedule in words, its Describe runs switch, its history
// with each run's description, and its actions: Run now, Open chat for a prompt run's chat, and Edit (its Edit form).
import { computed, ref } from 'vue'
import { CalendarClock, ChartColumn, ChevronRight, CircleAlert, CircleCheck, CircleMinus, Clock, History, LoaderCircle, MessageSquare, Pencil, Repeat, Sparkles } from '@lucide/vue'
import type { Routine } from '@shared/routines'
import { useShellSource } from '@/components/shell/source'
import { useClock } from '@/lib/clock'
import { usePaneApi } from './api'
import { BUTTON } from './settings-styles'
import PaneSwitch from './PaneSwitch.vue'
import RoutineEditForm from './RoutineEditForm.vue'
import RoutineStatusChip from './RoutineStatusChip.vue'
import { counterLabel } from './routine-details'
import { lastRunText, localZone, nextRunText, outcomeKind, plainReason, routineStatus, scheduleSentence, spanOf } from './routine-view'

const props = defineProps<{
  /** The routine as the last look saw it (GET /api/routines). */
  routine: Routine
  /** Whether the routine manager is on: Run now waits for it. */
  enabled: boolean
}>()
/** A request was answered (run, paused, resumed, or refused): the parent re-reads the status. */
const emit = defineEmits<{ changed: []; details: [] }>()

const api = usePaneApi()
const src = useShellSource()
const busy = ref(false)
const error = ref('')
const open = ref(false)
const editing = ref(false)
const openRuns = ref<Set<number>>(new Set())

const canRun = computed(() => props.enabled && !busy.value && ['idle', 'due'].includes(props.routine.state) && props.routine.kind !== null)
const last = computed(() => props.routine.runs[0])
const status = computed(() => routineStatus(props.routine))
const now = useClock(30_000)
const lastShort = computed(() => lastRunText(props.routine, now.value))
const nextShort = computed(() => nextRunText(props.routine, now.value))
const lastOutcome = computed(() => (last.value ? outcomeKind(last.value.outcome) : null))
const KindIcon = computed(() => (props.routine.what === 'prompt' ? MessageSquare : props.routine.kind === 'windowsTask' ? CalendarClock : Repeat))
const scheduleText = computed(() => {
  const r = props.routine
  if (r.schedule !== null) return scheduleSentence(r.schedule, localZone())
  if (r.windowsTask !== null) return `Windows: ${r.windowsTask.replace(/^\\/, '')}`
  return 'its own pace'
})
const totalRows = computed(() => Object.entries(props.routine.totals ?? {}).map(([k, n]) => ({ label: counterLabel(k), value: n.toLocaleString('en-US') })))
const runsTotal = computed(() => Math.max(props.routine.runsTotal ?? 0, props.routine.runs.length))
const settingRows = computed(() => Object.entries(props.routine.settings ?? {}))
/** The session of a prompt run's chat: the one running now, else the last run's. */
const chatSession = computed(() => props.routine.running?.sessionId ?? last.value?.sessionId ?? null)
/** What the last run did, as its description says (owner, 2026-10-13: "an AI description of what they did"). */
const lastDescription = computed(() => (last.value?.description?.state === 'done' ? last.value.description.text : null))
/** Windows runs a windowsTask routine, so its output never reaches the manager to describe; a broken one has nothing to run. */
const describable = computed(() => props.routine.kind === 'schedule' || props.routine.kind === 'status')

const stamp = (ms: number) => new Date(ms).toLocaleString()
function toggleRun(at: number) {
  const s = new Set(openRuns.value)
  if (!s.delete(at)) s.add(at)
  openRuns.value = s
}

/** Opens a routine's chat the way the sidebar opens a session: a Desk chat that has it, else its transcript. */
function openChat(sessionId: string) {
  const chat = src.chats.value.find((c) => c.sessionId === sessionId)
  if (chat) src.select({ kind: 'chat', id: chat.id })
  else src.select({ kind: 'external', id: sessionId })
}

/** Sends one action; true when the server took it, else its reason is in `error`. */
async function act(body: Parameters<typeof api.routinesAct>[0]): Promise<boolean> {
  busy.value = true
  error.value = ''
  try {
    await api.routinesAct(body)
    return true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return false
  } finally {
    busy.value = false
    emit('changed')
  }
}

/** Saves the Edit form's changes; it closes once the server has them. */
async function saveEdit(set: Record<string, unknown>) {
  if (await act({ edit: { id: props.routine.id, set } })) editing.value = false
}

function toggleEdit() {
  error.value = ''
  editing.value = !editing.value
}
</script>

<template>
  <div class="mt-2 rounded-[var(--radius-6)] bg-fill-5 shadow-[inset_0_0_0_1px_var(--border)]">
    <div class="flex items-center gap-1 pe-3">
      <button
        type="button"
        class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-6)] p-3 text-start hover:bg-fill-5 focus-visible:outline-2 focus-visible:outline-accent"
        :aria-expanded="open"
        @click="open = !open"
      >
        <ChevronRight class="size-4 shrink-0 text-text-muted transition-transform" :class="open ? 'rotate-90' : ''" aria-hidden="true" />
        <component :is="KindIcon" class="size-4 shrink-0 text-text-2" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate text-ui leading-5 text-text">{{ routine.name }}</span>
        <RoutineStatusChip :status="status" />
        <span class="flex basis-full flex-wrap items-center gap-x-4 gap-y-0.5 ps-12 text-ui-sm leading-4.5 text-text-muted">
          <span class="inline-flex items-center gap-1" :title="last ? stamp(last.endedAt) : 'never run'">
            <CircleCheck v-if="lastOutcome === 'ok'" class="size-3.5 text-success" aria-hidden="true" />
            <CircleAlert v-else-if="lastOutcome === 'failed'" class="size-3.5 text-danger-text" aria-hidden="true" />
            <CircleMinus v-else-if="lastOutcome === 'busy'" class="size-3.5" aria-hidden="true" />
            <History v-else class="size-3.5" aria-hidden="true" />
            Last run {{ lastShort ?? 'never' }}
          </span>
          <span class="inline-flex items-center gap-1" :title="routine.nextRunAt !== null ? stamp(routine.nextRunAt) : routine.reason">
            <Clock class="size-3.5" aria-hidden="true" />
            Next {{ nextShort }}
          </span>
        </span>
        <span v-if="routine.describe && lastDescription" class="line-clamp-2 basis-full ps-12 text-ui-sm leading-4.5 text-text-2" :title="lastDescription">{{ lastDescription }}</span>
      </button>
      <!-- Its own on/off (owner, 2026-10-12: "each toggle"): on runs it on its schedule, off pauses it. The Routines switch
           above is the manager's, for all of them. A routine with no kind (a file that does not check out) has nothing to pause. -->
      <PaneSwitch
        :model-value="!routine.paused"
        :label="`Run ${routine.name} on its schedule`"
        :disabled="busy || routine.kind === null"
        @update:model-value="(on: boolean) => act(on ? { resume: routine.id } : { pause: routine.id })"
      />
    </div>
    <div v-if="open" class="border-t border-[var(--border)] p-3 pt-2">
      <div class="flex items-start gap-1.5 text-ui-sm leading-4.5 text-text-2">
        <CalendarClock class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span class="wrap-break-word">{{ scheduleText }}<template v-if="routine.until"> · until {{ routine.until }}</template></span>
      </div>
      <div class="mt-0.5 wrap-break-word ps-5 text-ui-sm leading-4.5 text-text-muted">{{ routine.headline ?? plainReason(routine.reason, localZone()) }}</div>
      <div v-if="routine.askedBy" class="mt-0.5 wrap-break-word ps-5 text-ui-sm leading-4.5 text-text-muted">Asked for by {{ routine.askedBy }}</div>
      <dl v-if="totalRows.length" class="mt-2 flex flex-wrap gap-1.5 ps-5">
        <div v-for="t in totalRows" :key="t.label" class="rounded-[var(--radius-6)] bg-fill-5 px-2 py-1 shadow-[inset_0_0_0_1px_var(--border)]">
          <dt class="text-ui-sm leading-4 text-text-muted">{{ t.label }}</dt>
          <dd class="tnum text-ui leading-5 text-text">{{ t.value }}</dd>
        </div>
      </dl>
      <div v-if="routine.what === 'prompt' && routine.cwd" class="mt-0.5 wrap-break-word ps-5 text-ui-sm leading-4.5 text-text-muted">An AI prompt in {{ routine.cwd }}</div>
      <dl v-if="settingRows.length" class="mt-2 grid gap-1">
        <div v-for="[k, v] in settingRows" :key="k" class="flex items-baseline justify-between gap-4 text-ui-sm leading-4.5">
          <dt class="text-text-muted">{{ k }}</dt>
          <dd class="tnum truncate text-text-2">{{ String(v) }}</dd>
        </div>
      </dl>
      <!-- Its file's `describe` (owner, 2026-10-13: "have a toggle that says... run description"): on, an AI writes what each
           run did once it ends. -->
      <div v-if="describable" class="mt-2 flex items-center gap-2 text-ui-sm leading-4.5">
        <Sparkles class="size-3.5 shrink-0 text-text-2" aria-hidden="true" />
        <span class="text-text-2">Describe each run</span>
        <span class="min-w-0 flex-1 truncate text-text-muted">AI writes what it did</span>
        <PaneSwitch
          :model-value="routine.describe"
          :label="`Describe each run of ${routine.name}`"
          :disabled="busy"
          @update:model-value="(on: boolean) => act({ edit: { id: routine.id, set: { describe: on } } })"
        />
      </div>
      <div class="mt-3 flex items-center gap-2 text-ui-sm leading-4.5 text-text-2">
        <span class="tnum">{{ runsTotal > 8 ? `Latest 8 of ${runsTotal} runs` : runsTotal === 1 ? '1 run' : `${runsTotal} runs` }}</span>
        <button v-if="runsTotal" type="button" :class="[BUTTON, 'ms-auto gap-1.5']" @click="emit('details')">
          <ChartColumn class="size-3.5" aria-hidden="true" />All runs &amp; stats
        </button>
      </div>
      <div v-if="!routine.runs.length" class="text-ui-sm leading-4.5 text-text-muted">No runs yet.</div>
      <ul v-else class="mt-1 grid gap-0.5">
        <li v-for="r in routine.runs.slice(0, 8)" :key="r.startedAt">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-[var(--radius-6)] px-1.5 py-1 text-start text-ui-sm leading-4.5 hover:bg-fill-5 disabled:hover:bg-transparent"
            :aria-expanded="openRuns.has(r.startedAt)"
            :disabled="!r.lastLine && r.description?.state !== 'failed'"
            @click="toggleRun(r.startedAt)"
          >
            <CircleCheck v-if="outcomeKind(r.outcome) === 'ok'" class="size-3.5 shrink-0 text-success" aria-hidden="true" />
            <CircleAlert v-else-if="outcomeKind(r.outcome) === 'failed'" class="size-3.5 shrink-0 text-danger-text" aria-hidden="true" />
            <CircleMinus v-else class="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
            <span class="text-text-2">{{ stamp(r.startedAt) }}</span>
            <span class="tnum text-text-muted">{{ spanOf(r.endedAt - r.startedAt) }} · {{ r.outcome }}</span>
            <LoaderCircle v-if="r.description?.state === 'pending'" class="size-3.5 shrink-0 animate-spin text-text-muted" aria-label="Describing the run" />
            <ChevronRight v-if="r.lastLine || r.description?.state === 'failed'" class="ms-auto size-3.5 shrink-0 text-text-muted transition-transform" :class="openRuns.has(r.startedAt) ? 'rotate-90' : ''" aria-hidden="true" />
          </button>
          <div v-if="r.description?.state === 'done'" class="wrap-break-word ps-7 text-ui-sm leading-4.5 text-text-2">{{ r.description.text }}</div>
          <template v-if="openRuns.has(r.startedAt)">
            <div v-if="r.lastLine" class="wrap-break-word ps-7 font-mono text-ui-sm leading-4.5 text-text-muted">{{ r.lastLine }}</div>
            <div v-if="r.description?.state === 'failed'" class="wrap-break-word ps-7 text-ui-sm leading-4.5 text-text-muted">Not described: {{ r.description.text }}</div>
          </template>
        </li>
      </ul>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" :class="BUTTON" :disabled="!canRun" @click="act({ run: routine.id })">Run now</button>
        <button v-if="chatSession" type="button" :class="BUTTON" @click="openChat(chatSession)">Open chat</button>
        <button v-if="routine.kind !== null" type="button" :class="[BUTTON, 'gap-1.5']" :aria-expanded="editing" @click="toggleEdit">
          <Pencil class="size-3.5" aria-hidden="true" />Edit
        </button>
      </div>
      <RoutineEditForm v-if="editing" :routine="routine" :busy="busy" :error="error" @save="saveEdit" @cancel="toggleEdit" />
    </div>
    <!-- Under the card, open or not: the row's own switch fails here too, and a closed card would hide it. The Edit form
         shows its own. -->
    <div v-if="error && !(open && editing)" role="alert" class="wrap-break-word px-3 pb-2 text-ui-sm leading-4.5 text-danger-text">{{ error }}</div>
  </div>
</template>
