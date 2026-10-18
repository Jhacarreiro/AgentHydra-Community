<script setup lang="ts">
import { computed, ref, shallowRef, watch, onUnmounted } from 'vue'
import type { ChatSummary, DesktopMessageRequest, DesktopMessageResult, DesktopStopResult, TranscriptItem } from '@shared/protocol'
import { useShellSource } from '@/components/shell/source'
import { usePaneApi } from '@/components/panes/api'
import { externalGlyph, glyphDotClass, sourceLabel } from '@/components/sidebar/logic'
import { useDesk } from '@/stores/desk'
import { outsideTasks } from '@/components/tasks/api'
import TranscriptView from '@/components/transcript/TranscriptView.vue'
import WorkingMark from '@/components/transcript/parts/WorkingMark.vue'
import RevealStep from '@/components/transcript/parts/RevealStep.vue'
import { nowDoing, runningFor } from '@/components/transcript/lib/now-doing'
import { useClock } from '@/lib/clock'
import { reportAtPaint } from '@/lib/timing'
import Composer from '@/components/composer/Composer.vue'
import { Tip } from '@/components/ui/tooltip'
import type { SearchResult } from '@shared/find'
import SessionHeader from '@/components/session-header/SessionHeader.vue'
import { displayItems, type FindHit } from '@/components/session-header/logic'
import { displayPrefs } from '@/components/session-header/state'
import { advanceCursor, cursorMoved, EXTERNAL_PAGE, externalIndexBySession, mergeRecent, prependPage, startCursor, unloadedCount, type OlderCursor } from './paging'
import { continueLine, externalChat, holderOf, knownResumeAccount, resumable, whereLabel } from './logic'

// A session running outside Hydra Desk, in the same column as a chat. A Claude Code session from Claude
// Desktop or a terminal opens like one of its own chats: idle there, the live composer, whose first
// message imports and resumes it (on the CLI instance that holds it, else as a copy under the account
// it lands on), a quiet line over it saying which; working there, a quiet line until it settles.
// Anything else (Codex, CliMayte workers) stays read-only: nothing here can resume it.
// Hydra Desk 2: AgentHydra's session header lies over the top of the transcript (components/session-header):
// it slides away and back on a transform, and the transcript keeps its first row clear of it with a top
// inset rather than shrinking, so folding it lays nothing out again. Its Display choices pick what the
// transcript shows.
const props = defineProps<{ sessionId: string; /** A page (AgentHydra, Dev servers) covers the view. */ paused?: boolean }>()

const src = useShellSource()
const desk = useDesk()
const api = usePaneApi()
// Replaced whole on each read, never edited in place: a shallow ref keeps a big transcript out of deep proxies.
// A long session comes in two parts (owner, 2026-10-11: a 56 MB session showed only its last 8 MiB, "It just stops"):
// `recent`, the newest part, which the polls read again, and `older`, the pages above it of 200, each fetched only when
// the transcript nears its top (paging.ts), joined to the recent part by id.
const recent = shallowRef<TranscriptItem[]>([])
const older = shallowRef<TranscriptItem[]>([])
let cursor: OlderCursor = startCursor(0)
const loadingOlder = ref(false)
const items = computed(() => mergeRecent(older.value, recent.value))
const olderCount = computed(() => unloadedCount(cursor0.value, externalIndexBySession.get(props.sessionId)?.total, items.value.length))
const cursor0 = shallowRef<OlderCursor>(cursor)
const loading = ref(true)
const error = ref<string | null>(null)
let pollInterval: ReturnType<typeof setInterval> | null = null

const session = computed(() => src.external.value.find((s) => s.id === props.sessionId))
const isWorking = computed(() => session.value?.status === 'working' || session.value?.status === 'needs_you')
const usable = computed(() => !!session.value && resumable(session.value))
const shown = computed(() => displayItems(items.value, displayPrefs.value))
const find = ref<{ query: string; active: FindHit | null } | null>(null)
/** How much of the top the session header (and its Find bar) covers right now. */
const inset = ref(0)
const standIn = computed(() =>
  session.value?.canResume ? externalChat(session.value, src.accounts.value, desk.externalPatch(session.value.id), desk.landingOf(session.value.id)) : null
)
// A chat at work elsewhere keeps its composer, as one here does (owner, 2026-10-14: "Codex should be exactly the same. I
// shouldn't be able to tell if I'm using Claude or Codex ... There should be input boxes"). A Claude Desktop chat's message
// goes into that chat (AgentHydra queues it there); a Codex or Claude Code chat's is held here and sent when the turn ends
// (desk.holdFor). Each runs when the turn ends, text only.
const holdsHere = computed(() => {
  const s = session.value
  return !!s && (s.source === 'cli' || (s.source === 'codex' && !!s.codexAccountId))
})
const workingChat = computed(() => {
  const s = session.value
  if (standIn.value || !s || !isWorking.value || !(s.source === 'desktop' || holdsHere.value)) return null
  return externalChat(s, src.accounts.value)
})
const INTO_WHY = 'Text only: a message into a working Claude Desktop chat has no pictures or voice.'
const HOLD_WHY = 'Text only: a message for a chat at work elsewhere is sent when its turn ends, with no pictures or voice.'
const into = computed(() =>
  holdsHere.value ? { send: (text: string) => desk.holdFor(props.sessionId, text), why: HOLD_WHY } : { send: sendInto, why: INTO_WHY, stop: stopInto }
)
const queuedLines = computed(() => (holdsHere.value ? desk.heldFor(props.sessionId) : queued.value))
const heldError = computed(() => desk.heldError(props.sessionId))
const composerChat = computed(() => standIn.value ?? workingChat.value)
// The chat at work, as the transcript's working line (WorkingFooter) reads a chat here: its status, what it does, since when.
const liveChat = computed<ChatSummary | null>(() =>
  workingChat.value
    ? {
        ...workingChat.value,
        status: session.value?.status === 'needs_you' ? 'needs_you' : 'working',
        activity: session.value?.activity ?? null,
        turnStartedAt: doing.value.since ?? null,
        queuedCount: queuedLines.value.length
      }
    : null
)
const queued = ref<{ id: number; text: string }[]>([])
let queuedId = 0
async function sendInto(text: string): Promise<void> {
  const res = await fetch(`/api/external/sessions/${encodeURIComponent(props.sessionId)}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text } satisfies DesktopMessageRequest)
  })
  const body = (await res.json().catch(() => null)) as (Partial<DesktopMessageResult> & { error?: string }) | null
  if (!res.ok || !body?.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  queued.value = [...queued.value, { id: ++queuedId, text }]
}
// Stop: Claude Desktop's own Stop for the turn, through AgentHydra's native stop (owner, 2026-10-14: a running chat showed
// only a send arrow). It answers once the app shows the turn stopping.
async function stopInto(): Promise<void> {
  const res = await fetch(`/api/external/sessions/${encodeURIComponent(props.sessionId)}/stop`, { method: 'POST' })
  const body = (await res.json().catch(() => null)) as (Partial<DesktopStopResult> & { error?: string }) | null
  if (!res.ok || !body?.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
}
// A queued message is shown as queued until the transcript shows it (once per matching message).
watch(items, (list) => {
  if (!queued.value.length) return
  const seen = list.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text.trim())
  queued.value = queued.value.filter((q) => {
    const at = seen.indexOf(q.text.trim())
    if (at < 0) return true
    seen.splice(at, 1)
    return false
  })
})
watch(() => props.sessionId, () => (queued.value = []))
const glyph = computed(() => (session.value ? externalGlyph(session.value) : null))
const where = computed(() => {
  const s = session.value
  if (!s) return ''
  return `${sourceLabel(s.source)}${s.instance ? ` ${s.instance}` : ''}`
})
const dotClass = computed(() => glyphDotClass(glyph.value ?? { shape: 'ring', tone: 'muted', motion: 'none' }))
// Working there, the window's orange working mark stands in for the blinking dot (owner, 2026-10-08: "a fun ...
// orange animation"); waiting on you keeps the amber dot, and anything else its own dot.
const working = computed(() => session.value?.status === 'working')
// Working there, the line under the transcript says what it is doing now, in a size a person reads, and how long since
// the person last wrote, as Claude Desktop's working line does (owner, 2026-10-08: "make the text a little larger ...
// dynamically change ... what task it's running right now" and "a timer for how long ... since the last human-written
// message"). Where it runs is in the tooltip.
const clock = useClock()
const doing = computed(() => nowDoing(items.value, session.value?.cwd))
const liveText = computed(() => {
  const s = session.value
  if (!s) return ''
  return s.status === 'needs_you' ? 'Waiting for you' : doing.value.text || s.activity || 'Working'
})
// Its ">" opens the step the words name, when the transcript shows it (Show tools or Show thinking off hide some).
const transcriptView = ref<InstanceType<typeof TranscriptView> | null>(null)
const liveStep = computed(() => {
  const id = isWorking.value && session.value?.status !== 'needs_you' && doing.value.text ? doing.value.step : null
  return id && shown.value.some((i) => i.id === id) ? id : null
})
const revealLive = () => liveStep.value && transcriptView.value?.revealStep(liveStep.value)
const liveFor = computed(() => (isWorking.value && doing.value.since ? runningFor(clock.value - doing.value.since) : ''))
const liveWhere = computed(() => (session.value ? `${session.value.status === 'needs_you' ? 'Waiting for you' : 'Working'} in ${whereLabel(session.value)}` : ''))
// Said before the first message: in place or as a copy, and on which account (the title bar's menu changes it).
const continueNote = computed(() => {
  const s = session.value
  if (!standIn.value || !s) return ''
  const picked = desk.externalPatch(s.id).accountId
  const account = knownResumeAccount(s, src.accounts.value, picked, desk.landingOf(s.id))
  return continueLine(s, account, !!account && account.id === picked)
})

/**
 * Whether a fresh read says nothing new: same length, same id and status on every item, the same last item
 * in full, and the same tasks and checklist in full (their notices change them where they stand).
 */
function sameItems(a: TranscriptItem[], b: TranscriptItem[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.id !== y.id || (x as { status?: string }).status !== (y as { status?: string }).status) return false
    if ((x.kind === 'task' || x.kind === 'todos') && JSON.stringify(x) !== JSON.stringify(y)) return false
  }
  return a.length === 0 || JSON.stringify(a[a.length - 1]) === JSON.stringify(b[b.length - 1])
}

async function loadItems(quiet = false) {
  try {
    if (!quiet) loading.value = true
    error.value = null
    const from = performance.now()
    const { items: next, olderBefore } = await api.externalItems(props.sessionId, session.value?.cwd)
    placeCursor(olderBefore)
    if (quiet && sameItems(recent.value, next)) return
    recent.value = next
    // The index on open, and again when a poll changed what is there (its total moves with the items).
    void loadIndex()
    // The open as the window draws it (polls are not opens).
    if (!quiet) reportAtPaint('open_to_paint', from, props.sessionId)
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load session items'
  } finally {
    loading.value = false
  }
}

/** The recent part begins at `before` in the file: when that is elsewhere than the pages held, they are dropped. */
function placeCursor(before: number) {
  if (cursorMoved(cursor, before)) {
    if (older.value.length) older.value = []
    cursor = startCursor(before)
    cursor0.value = cursor
  }
}

/** The page above the loaded items, asked for when the transcript nears its top. */
async function loadOlderPage() {
  const id = props.sessionId
  const at = cursor
  if (at.done || loadingOlder.value || !api.externalOlderPage) return
  loadingOlder.value = true
  try {
    const page = await api.externalOlderPage(id, at.before, EXTERNAL_PAGE, at.end, session.value?.cwd)
    if (id !== props.sessionId || cursor !== at) return
    const next = prependPage(older.value, page.items)
    const added = next.length - older.value.length
    older.value = next
    cursor = advanceCursor(at, page.above, added)
    cursor0.value = cursor
  } catch {
    // Asked again when the transcript nears the top again.
  } finally {
    loadingOlder.value = false
  }
}

const fetchItem = async (id: string): Promise<TranscriptItem | null> => {
  const cwd = session.value?.cwd
  const res = await fetch(`/api/external/sessions/${encodeURIComponent(props.sessionId)}/items/${encodeURIComponent(id)}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`)
  return res.ok ? ((await res.json()) as TranscriptItem) : null
}

/** Find over the whole session on the server. */
const searchSession = async (q: string): Promise<SearchResult | null> => {
  const cwd = session.value?.cwd
  const res = await fetch(`/api/external/sessions/${encodeURIComponent(props.sessionId)}/search?q=${encodeURIComponent(q)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`)
  return res.ok ? ((await res.json()) as SearchResult) : null
}
/** Pages in above the loaded items until the one with this id is among them. */
async function revealItem(itemId: string) {
  const id = props.sessionId
  for (let guard = 0; guard < 200 && id === props.sessionId; guard++) {
    if (items.value.some((i) => i.id === itemId) || cursor.done) return
    const before = older.value.length
    await loadOlderPage()
    if (older.value.length === before) return
  }
}

let indexAsked = false
async function loadIndex() {
  const id = props.sessionId
  if (indexAsked || !api.externalIndex) return
  indexAsked = true
  try {
    const idx = await api.externalIndex(id, session.value?.cwd)
    if (idx && Array.isArray(idx.userMessages)) externalIndexBySession.set(id, idx)
  } catch {
    // The index is a convenience: the pages still show.
  } finally {
    indexAsked = false
  }
}

function stopPolling() {
  if (pollInterval) clearInterval(pollInterval)
  pollInterval = null
}

watch(
  () => props.sessionId,
  () => {
    older.value = []
    cursor = startCursor(0)
    cursor0.value = cursor
    void loadItems()
  },
  { immediate: true }
)
// Where a session no signed-in CLI instance holds lands (the stand-in's account, the line over its
// composer), again when Settings' default changes or the accounts arrive: the named default is only
// found among them, and a holder's sign-in shows there.
watch(
  () =>
    [
      props.sessionId,
      session.value?.canResume,
      session.value?.accountId ?? null,
      src.settings.value?.defaultAccountId,
      src.accounts.value.map((a) => `${a.id}:${a.signedIn}`).join(',')
    ] as const,
  ([id, can, owner]) => {
    if (can && !holderOf({ accountId: owner }, src.accounts.value)) void desk.ensureLanding(id)
  },
  { immediate: true }
)
// The Background tasks panel reads this session's transcript from here.
watch(
  [items, () => props.sessionId],
  () => (outsideTasks.value = { sessionId: props.sessionId, items: items.value }),
  { immediate: true }
)
// A session sits idle while its background Bash runs, so a running task keeps a slower poll going
// until it finishes (owner, 2026-10-05: "there actually is one running and one finished").
const tasksRunning = computed(() => items.value.some((i) => i.kind === 'task' && i.status === 'running'))
let pollMs = 0
watch(
  () => [isWorking.value, tasksRunning.value] as const,
  ([working, running], before) => {
    const ms = working ? 3000 : running ? 10000 : 0
    if (ms !== pollMs) {
      stopPolling()
      // A hidden window, or a view a page covers, rests; it reads once on return (below).
      if (ms) pollInterval = setInterval(() => !document.hidden && !props.paused && loadItems(true), ms)
      pollMs = ms
    }
    if (!working && before?.[0]) void loadItems(true)
  },
  { immediate: true }
)
function onVisible() {
  if (!document.hidden && !props.paused && pollMs) void loadItems(true)
}
document.addEventListener('visibilitychange', onVisible)
watch(() => props.paused, onVisible)
onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisible)
  stopPolling()
  if (outsideTasks.value?.sessionId === props.sessionId) outsideTasks.value = null
})
</script>

<template>
  <div class="flex h-full flex-col bg-(--bg-page) text-ui leading-[19.5px] text-(--text)">
    <!-- The header is clipped here: folded, it slides up out of this box, never over the title bar. -->
    <div class="relative min-h-0 flex-1 overflow-hidden">
      <SessionHeader
        :session-id="sessionId"
        :session="session ?? null"
        :items="items"
        :shown="shown"
        :search="searchSession"
        :reveal="revealItem"
        @update:find="(f) => (find = f)"
        @update:inset="(h: number) => (inset = h)"
      />
      <div v-if="loading" class="flex h-full items-center justify-center text-(--text-muted)" :style="{ paddingTop: `${inset}px` }">Loading transcript…</div>
      <div
        v-else-if="error && !items.length"
        class="flex h-full flex-col items-center justify-center gap-1 px-6 text-center"
        :style="{ paddingTop: `${inset}px` }"
      >
        <div class="font-medium">Could not load this session</div>
        <div class="text-(--text-muted)">{{ error }}</div>
      </div>
      <TranscriptView
        v-else
        ref="transcriptView"
        :chat-id="sessionId"
        :items="shown"
        :read-only="!standIn"
        :chat="standIn ?? liveChat"
        :find="find"
        :compact="displayPrefs.compact"
        :inset-top="inset"
        :running="isWorking"
        :older-count="olderCount"
        :loading-older="loadingOlder"
        :index="externalIndexBySession.get(sessionId) ?? null"
        :fetch-item="fetchItem"
        @load-older="loadOlderPage"
      />
    </div>

    <!-- One composer whether the chat is idle there or at work, so the box never comes and goes (owner, 2026-10-14:
         "Codex should be exactly the same ... There should be input boxes"). At work, the working line is the
         transcript's own last row, as in a chat here. -->
    <template v-if="composerChat">
      <ul v-if="workingChat && queuedLines.length" class="mx-auto flex w-full max-w-3xl flex-col gap-0.5 px-6 pb-1 text-ui-sm leading-4 text-(--text-muted)" aria-label="Queued messages">
        <li v-for="q in queuedLines" :key="q.id" class="truncate" role="status">Queued, runs when this turn ends: {{ q.text }}</li>
      </ul>
      <!-- What was held for this chat while it worked and could not be sent: back in the box, and why. -->
      <p v-if="standIn && heldError" class="mx-auto w-full max-w-3xl px-6 pb-1 text-ui-sm text-(--danger-text)" role="alert">
        Not sent: {{ heldError }} It is back in the box.
      </p>
      <!-- Idle: in place or as a copy, and on which account (the info mark in the composer's toolbar says it on hover). -->
      <Composer :key="composerChat.id" :chat="composerChat" :note="standIn ? continueNote || undefined : undefined" :into="standIn ? undefined : into" />
    </template>

    <div v-else-if="session && usable" class="shrink-0 px-8 py-3">
      <p class="mx-auto flex h-10 w-full max-w-3xl items-center gap-1.25 px-2 text-(--text-muted)" role="status">
        <span class="flex size-6 shrink-0 items-center justify-center">
          <WorkingMark v-if="working" :label="glyph?.label ?? 'Working'" />
          <span v-else role="img" :aria-label="glyph?.label" class="size-1.5 rounded-full" :class="dotClass" />
        </span>
        <template v-if="isWorking">
          <Tip :label="liveWhere"><span class="min-w-0 truncate text-ui-lg leading-5" :class="working ? 'tx-shimmer' : 'text-warning-text'">{{ liveText }}</span></Tip>
          <RevealStep v-if="liveStep" @click="revealLive" />
          <span v-if="liveFor" class="ms-0.5 shrink-0 tabular-nums text-ui" aria-hidden="true">{{ liveFor }}</span>
          <span class="sr-only">{{ liveWhere }}</span>
        </template>
        <span v-else class="min-w-0 flex-1 truncate">{{ liveWhere }}</span>
      </p>
    </div>

    <div v-else-if="session" class="shrink-0 px-8 py-3">
      <div
        class="mx-auto flex h-10 w-full max-w-3xl items-center gap-1.25 rounded-(--radius-10) bg-(--fill-5) p-2"
        role="status"
      >
        <span class="flex size-6 shrink-0 items-center justify-center">
          <WorkingMark v-if="working" :label="glyph?.label ?? 'Working'" />
          <span v-else role="img" :aria-label="glyph?.label" class="size-1.5 rounded-full" :class="dotClass" />
        </span>
        <span class="min-w-0 flex-1 truncate text-(--text-2)">
          <span>{{ isWorking ? 'Running in' : 'Read-only from' }} {{ where }}</span>
          <span v-if="isWorking" class="text-(--text-muted)"> · {{ liveText }}</span>
        </span>
        <RevealStep v-if="liveStep" @click="revealLive" />
        <span v-if="liveFor" class="shrink-0 tabular-nums text-ui text-(--text-muted)" aria-hidden="true">{{ liveFor }}</span>
        <Tip v-if="error" :label="error"><span class="max-w-[40%] shrink truncate text-(--danger-text)">{{ error }}</span></Tip>
      </div>
    </div>
  </div>
</template>
