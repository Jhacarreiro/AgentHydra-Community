<script setup lang="ts">
// The transcript: a windowed list (only the rows near the viewport are in the DOM, so a 3,000-item
// chat scrolls smoothly), auto-scroll that lets go when the owner scrolls up (a send, the down arrow's last step
// or scrolling back down takes it back to the bottom), and a Working row under the last item while the
// chat's turn runs.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, toRef, watch, type Directive } from 'vue'
import { LoaderCircle } from '@lucide/vue'
import { icons } from '@/lib/icons'
import type { ChatSummary, TranscriptIndex, TranscriptItem } from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import { watchTranscript } from '@/lib/chat-audio'
import { buildRows, estimateHeight } from './lib/rows'
import { newestBrowserCalls } from './lib/tools'
import { redesignState } from './lib/redesign'
import { groupRows, liveRow, rowGap, type DisplayRow } from './lib/groups'
import { prefixOffsets, rowAt, visibleRange } from './lib/window'
import { nextMessageStep, sentOverIndex, stepTarget } from './lib/steps'
import { provideTranscript } from './context'
import { revealTarget, type RevealTarget } from './lib/reveal'
import { COLLAPSE_MS } from './lib/motion'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuTrigger } from '@/components/ui/context-menu'
import { MENU_CONTENT, MENU_ITEM } from '@/components/sidebar/menuClasses'
import { Tip } from '@/components/ui/tooltip'
import TranscriptRow from './TranscriptRow.vue'
import WorkingFooter from './parts/WorkingFooter.vue'
import ToolGroup from './parts/ToolGroup.vue'
import TaskGroup from './parts/TaskGroup.vue'
import BrowserCard from './parts/BrowserCard.vue'
import MessagePeek from './parts/MessagePeek.vue'
import RunningTasksRow from '@/components/tasks/RunningTasksRow.vue'
import { CHAT_SENT_EVENT, sentHere, type ChatSentDetail } from '@/components/composer/api'
import './transcript.css'

const props = defineProps<{
  chatId: string
  items: TranscriptItem[]
  readOnly?: boolean
  /** The chat whose Working row is shown; defaults to the store's chat with chatId. */
  chat?: ChatSummary | null
  /** Rows or sections to start open (the Gallery uses it to show expanded states). */
  expandedIds?: string[]
  /** Hydra Desk 2's session header Find: every match marked, the active one (an item and which match in it) scrolled to. */
  find?: { query: string; active: { itemId: string; nth: number } | null } | null
  /** Tighter gaps between rows (the session header's Compact layout). */
  compact?: boolean
  /** Each thinking block keeps its own row; left out, they fold into the tool runs around them. Named so that left out is
   *  the default: Vue reads a boolean prop left out as false, so a `foldThinking` prop left out by the outside-session view
   *  drew every thinking block as a row (owner, 2026-10-08: "what happened to.... less of these?"). */
  unfoldThinking?: boolean
  /** The last turn is running somewhere else (an outside session working there): its latest reply is not its end yet. */
  running?: boolean
  /** How much of the top something lying over the transcript covers (Hydra Desk 2's session header): the first row starts below it. */
  insetTop?: number
  /** The history is not loaded yet; with `loadError`, the last try at it failed and another is coming. */
  loading?: boolean
  loadError?: string | null
  /** Items older than the first one given that the server still holds: their height is counted in the scrollbar at the average row height. */
  olderCount?: number
  /** The page above is being fetched: a spinner row shows at the top. */
  loadingOlder?: boolean
  /** The chat's index: the step arrows and the peek reach every message sent, loaded or not. */
  index?: TranscriptIndex | null
  /** One item by id, for the peek of a message that is not loaded. */
  fetchItem?: (id: string) => Promise<TranscriptItem | null>
}>()
const emit = defineEmits<{ loadOlder: [] }>()

const desk = useDesk()

// Right-click on a local file's video/picture or a file path in a reply: Desk's own small menu. Shift keeps the WebView's
// (Loop, Save video as, Picture in picture). The capture listener decides before the menu's own handler runs: for
// anything else it stops the event there, so the native menu shows.
const reveal = ref<RevealTarget | null>(null)
const revealNote = ref<string | null>(null)
let noteTimer: ReturnType<typeof setTimeout> | undefined
function onContextCapture(e: MouseEvent) {
  const target = e.shiftKey ? null : revealTarget(e.target as Element | null)
  reveal.value = target
  if (!target) e.stopPropagation()
}
function say(text: string) {
  revealNote.value = text
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => (revealNote.value = null), 5000)
}
function openInExplorer() {
  const t = reveal.value
  if (!t) return
  const body = t.path ? { path: t.path, cwd: chat.value?.cwd ?? undefined } : { media: t.media! }
  desk.revealFile(body).catch((err: unknown) => {
    // A media item with no known path: try the cached id once more as the fallback the server knows.
    if (t.path && t.media) return desk.revealFile({ media: t.media }).catch(() => say(`Could not open it in Explorer: ${err instanceof Error ? err.message : String(err)}`))
    say(`Could not open it in Explorer: ${err instanceof Error ? err.message : String(err)}`)
  })
}
function copyPath() {
  const p = reveal.value?.path
  if (p) void navigator.clipboard.writeText(p).catch(() => say('Could not copy the path'))
}
onBeforeUnmount(() => clearTimeout(noteTimer))
const chat = computed<ChatSummary | null>(() =>
  props.chat !== undefined ? props.chat : ((desk.chats.value as ChatSummary[]).find((c) => c.id === props.chatId) ?? null),
)
const rows = computed(() => buildRows(props.items))
const showWorking = computed(() => !!chat.value && ['working', 'starting', 'needs_you'].includes(chat.value.status))
// What is laid out: tool runs folded into status rows, end-of-turn replies marked.
// A turn still going has no end-of-turn actions under its latest reply, nor their room (owner, 2026-10-08: the last rows
// stood further apart than any other).
const display = computed(() => groupRows(rows.value.top, !props.unfoldThinking, !!props.running || showWorking.value))

const tctx = provideTranscript(
  {
    chatId: toRef(props, 'chatId'),
    readOnly: computed(() => !!props.readOnly),
    cwd: computed(() => chat.value?.cwd ?? null),
    children: computed(() => rows.value.children),
    items: computed(() => props.items),
    newestBrowser: computed(() => newestBrowserCalls(props.items)),
    redesign: computed(() => redesignState(props.items)),
    background: computed(() => ({
      count: chat.value?.climayteActive ?? 0,
      resultId: props.items.findLast((i) => i.kind === 'result' && !i.parentToolUseId)?.id ?? null,
    })),
    shimmerId: computed(() => liveRowId.value),
  },
  props.expandedIds,
)

/** What an empty transcript says: an unloaded one never claims to have no messages. */
const emptyText = computed(() => {
  if (!props.loading) return 'No messages yet'
  return props.loadError ? `Could not load this chat's messages: ${props.loadError.replace(/\.$/, '')}. Trying again…` : 'Loading messages…'
})

// Windowing: measured heights by item id, estimates until measured.
const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewHeight = ref(800)
const heights = new Map<string, number>()
const version = ref(0)

const indexById = computed(() => new Map(display.value.map((r, i) => [r.id, i])))
// One shimmer at a time (owner, 2026-10-10): the newest live row of the turn (lib/groups.ts liveRow); none, and the
// working line shimmers.
const liveRowId = computed(() => liveRow(display.value))
// Gaps and row heights together, once per change of the rows: a re-measure then only updates its own row's
// height and adds the heights up again.
const layout = computed(() => {
  const top = display.value
  const gaps: number[] = new Array(top.length)
  const h = new Float64Array(top.length)
  for (let i = 0; i < top.length; i++) {
    gaps[i] = props.compact ? Math.round(rowGap(top, i) * 0.4) : rowGap(top, i)
    h[i] = heights.get(top[i].id) ?? estimateRow(top[i]) + gaps[i]
  }
  return { gaps, h }
})
const gaps = computed(() => layout.value.gaps)
// Rows not loaded yet (props.olderCount) stand above the first one as blank height at the average row height, so the
// scrollbar's size is the whole transcript's. The average is taken when the rows are first given and again when rows are
// put in above (never as rows are measured), so the blank does not drift under someone reading.
const avgRow = ref(0)
watch(
  display,
  (now, before) => {
    if (avgRow.value && before?.length && now[0]?.id === before[0]?.id) return
    const h = layout.value.h
    let sum = 0
    for (let i = 0; i < h.length; i++) sum += h[i]
    avgRow.value = h.length ? sum / h.length : 0
  },
  { immediate: true },
)
const virtualTop = computed(() => Math.round((props.olderCount ?? 0) * avgRow.value))
const offsets = computed(() => {
  void version.value
  const out = prefixOffsets(layout.value.h)
  const v = virtualTop.value
  if (v) for (let i = 0; i < out.length; i++) out[i] += v
  return out
})
const range = computed(() => visibleRange(offsets.value, scrollTop.value, viewHeight.value, 800))
const visible = computed(() =>
  display.value.slice(range.value.start, range.value.end).map((r, k) => ({ r, gap: gaps.value[range.value.start + k] })),
)
const padTop = computed(() => offsets.value[range.value.start] ?? 0)
const padBottom = computed(() => {
  const o = offsets.value
  return Math.max(0, o[o.length - 1] - (o[range.value.end] ?? 0))
})

/** A first guess at a row's height until it is measured; messages add their 28px actions toolbar. */
function estimateRow(r: DisplayRow): number {
  if (r.kind === 'tools' || r.kind === 'tasks') return 24
  if (r.kind === 'browser') return 40
  const it = r.item
  return estimateHeight(it) + (it.kind === 'user' || r.endOfTurn ? 28 : 0)
}

// Auto-scroll: pinned to the bottom until the owner scrolls up by any means (wheel, touchpad, scrollbar, keys); only
// scrolling back down to the bottom, the down arrow's last step or a send re-pins. A reply growing never pulls him down.
const pinned = ref(true)
let lastTop = 0
/** How far the bottom is below the screen, for the down arrow. */
const fromBottom = ref(0)

const distanceOf = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight

// A jump to the bottom (the down arrow's last step, a send, another chat) is the transcript's move, not a hand's: for
// half a second after it, unless the person's own wheel, key or pointer comes first, a move up is the list settling,
// never a let-go. Rows that mount at the bottom with estimated heights make the list shorter for a frame, and the
// browser's clamp to it read as a scroll up: a jump let go of the bottom 141px short of it (scroll-follow e2e case 5,
// 2026-10-08; the clamp came 10ms after the click). The same holds for a mount and the first arrival of items, and each
// row measured for the first time while the settle still runs re-arms it, so a chat that opens with estimated rows is
// followed until they are measured (scroll-follow e2e case 11, 2026-10-09). Following a reply does not arm it: a drag or
// Page Up while it streams still lets go.
const SETTLE_MS = 500
let settleUntil = 0
const settling = () => performance.now() < settleUntil
const settle = () => (settleUntil = performance.now() + SETTLE_MS)
const userScrolls = () => (settleUntil = 0)

function scrollToBottom() {
  const el = scroller.value
  if (!el) return
  setSlack(0)
  el.scrollTop = el.scrollHeight
  scrollTop.value = el.scrollTop
  lastTop = el.scrollTop
  fromBottom.value = 0
}

/** Keeps a pinned transcript at its bottom. A scroll up that onScroll has not seen yet (a scrollbar drag or a key in
 *  the same frame as a streamed line) lets go here instead of being overwritten. */
function follow() {
  const el = scroller.value
  if (!el || !pinned.value || held || glide) return
  if (!settling() && el.scrollTop < lastTop - 1 && distanceOf(el) > 1) return onScroll()
  scrollToBottom()
}

function onScroll() {
  const el = scroller.value
  if (!el) return
  const top = el.scrollTop
  const distance = distanceOf(el)
  // Any move up lets go, however small (the browser clamping a shrunk list at the very bottom is not a move); only a
  // move down to within 24px of the bottom takes hold again (a glide decides that where it lands).
  const up = top < lastTop - 1
  if (up && distance > 1 && !settling()) pinned.value = false
  else if (!up && distance <= 24 && !held && !glide) pinned.value = true
  lastTop = top
  scrollTop.value = top
  fromBottom.value = distance
  trimSlack()
}

// A click on what opens or closes a row (StatusRow and ToolHeader, marked data-expander) keeps the clicked line
// where it is on screen while the content under it slides (owner, 2026-10-08: "have it expand down ... move the
// content below it down instead of moving the link I clicked, up"). For that long the bottom is not followed and a
// row above re-measuring does not move the view on its own: each frame, and after each measure, the view moves by
// however far the line drifted. What opens past the bottom goes on below the fold, so a pinned view lets go then.
// A brand-new item arriving while pinned and nothing held is followed as before.
let held: { el: HTMLElement; top: number; until: number } | null = null
let heldFrame = 0
function holdRow(e: MouseEvent) {
  const el = (e.target as Element | null)?.closest<HTMLElement>('[data-expander]')
  if (!el || !scroller.value?.contains(el)) return
  dropHold()
  held = { el, top: el.getBoundingClientRect().top, until: performance.now() + COLLAPSE_MS + 100 }
  const tick = () => {
    if (!held) return
    keepHeld()
    if (performance.now() < held.until) heldFrame = requestAnimationFrame(tick)
    else releaseRow()
  }
  heldFrame = requestAnimationFrame(tick)
}
/** Lets go of a held line without deciding anything (a jump to the bottom or another chat takes over). */
function dropHold() {
  held = null
  cancelAnimationFrame(heldFrame)
  heldFrame = 0
}
function keepHeld() {
  const el = scroller.value
  if (!held || !el || !held.el.isConnected) return
  const drift = held.el.getBoundingClientRect().top - held.top
  if (Math.abs(drift) < 0.5) return
  const want = el.scrollTop + drift
  // Closing near the bottom leaves too little below to scroll to: room is added under the list (see setSlack).
  const room = el.scrollHeight - el.clientHeight
  if (want > room) setSlack(slack + want - room)
  el.scrollTop = want
  scrollTop.value = lastTop = el.scrollTop
  fromBottom.value = distanceOf(el)
}
function releaseRow() {
  keepHeld()
  dropHold()
  const el = scroller.value
  if (!el) return
  if (pinned.value && (slack > 0 || distanceOf(el) > 1)) pinned.value = false
  fromBottom.value = distanceOf(el)
}
onBeforeUnmount(dropHold)

// Room under the list that keeps a closed row's line still when there is no longer enough below it to scroll that
// far. It is only ever as tall as the view needs where it stands: scrolling up, or the list growing, takes it back,
// and going to the bottom drops it. Set on the element itself, so the next read of scrollHeight already counts it.
const slackEl = ref<HTMLElement | null>(null)
let slack = 0
function setSlack(px: number) {
  slack = Math.max(0, px)
  if (slackEl.value) slackEl.value.style.height = slack ? `${slack}px` : ''
}
function trimSlack() {
  const el = scroller.value
  if (!el || !slack) return
  const need = el.scrollTop + el.clientHeight - (el.scrollHeight - slack)
  if (need < slack) setSlack(need)
}

function onWheel(e: WheelEvent) {
  userScrolls()
  stopGlide()
  if (e.deltaY < 0) pinned.value = false
}
/** A press on the list (a row, the scrollbar) is the person's own scroll, and takes over from a glide. */
function onPointerDown() {
  userScrolls()
  stopGlide()
}

function jumpToLatest() {
  dropHold()
  stopGlide()
  settle()
  pinned.value = true
  scrollToBottom()
  // Rows near the bottom get measured after this render; follow them down.
  requestAnimationFrame(follow)
}

// Sending from this chat's composer goes to the bottom, even scrolled up, and stays pinned for the reply.
function onSent(e: Event) {
  if (sentHere((e as CustomEvent<ChatSentDetail>).detail, props.chatId)) jumpToLatest()
}

// The step arrows (top right; owner, 2026-10-09: "a little floating arrow that when I click it, scrolls me up to my
// most recent message to the AI") walk the messages the person sent, read from the rows on the list, so one not
// rendered counts; a sub-agent's prompt and a message still queued are not theirs to step to. A step lands the message
// STEP_MARGIN px under the header's inset; a message already there is not a step. They are the transcript's only
// scroll buttons (owner, 2026-10-10: the bottom-right jump button went, "just have ... the ones on the top right be the
// ones that do it"): past the last message the person sent, the down arrow's step is the bottom.
const STEP_MARGIN = 8
const stepLine = computed(() => (props.insetTop ?? 0) + STEP_MARGIN)
/** Where row i's top sits in the scroller's content: the column's top padding (20px plus the inset) is above the first row, as in the template. */
const rowTop = (i: number) => 20 + (props.insetTop ?? 0) + (offsets.value[i] ?? 0)
/** The rows of the messages the person sent, in order: their ids, and their tops for nextMessageStep. */
const sent = computed(() => {
  const ids: string[] = []
  const tops: number[] = []
  display.value.forEach((r, i) => {
    if (r.kind !== 'item' || r.item.kind !== 'user' || r.item.parentToolUseId || r.item.queued) return
    ids.push(r.id)
    tops.push(rowTop(i))
  })
  return sentOverIndex({ ids, tops }, props.index?.userMessages, avgRow.value, 20 + (props.insetTop ?? 0))
})

// A step glides there by the transcript's own frames, not the browser's smooth scroll. The rows on the way start as
// height estimates and are measured as they come into view, and each measure of a row above the view moves scrollTop
// to keep what is on screen still; the browser ends a smooth scroll at the first scrollTop written under it, so the
// step stopped short (owner, 2026-10-10: it "sometimes just nudges the page up, like, a tiny bit"; scroll-follow e2e
// case 12 measured 107px short, then 22px, landing on the third click). Each frame reads where the message is now, by
// its row id, and covers the share of the way left that the easing gives that frame, so the measuring moves the
// landing spot and the glide with it. After the last frame it holds the spot until the rows under it stop moving.
const GLIDE_MS = 380
/** A glide: `to` is the row id it lands on, null for the bottom; `eased` how much of the way the last frame covered. */
type Glide = { to: string | null; t0: number; ms: number; eased: number; frame: number; last: number; still: number; after: number }
let glide: Glide | null = null
/** Where a glide is headed while one runs, so a second click steps on from there rather than to the message the first
 *  click is still gliding to. */
const heading = shallowRef<{ to: string | null } | null>(null)
const easeOut = (p: number) => 1 - (1 - p) ** 3

/** The scrollTop a glide to `to` ends on: the message on the step line, or the bottom; never past what the list scrolls. */
function glideTarget(to: string | null): number {
  const el = scroller.value
  if (!el) return 0
  const max = Math.max(0, el.scrollHeight - el.clientHeight)
  if (to === null) return max
  const i = indexById.value.get(to)
  return i === undefined ? el.scrollTop : Math.min(max, stepTarget(rowTop(i), stepLine.value))
}
const stepFrom = computed(() => (heading.value ? glideTarget(heading.value.to) : scrollTop.value))
const prevStep = computed(() => nextMessageStep(sent.value.tops, stepFrom.value, 'up', stepLine.value))
const nextStep = computed(() => nextMessageStep(sent.value.tops, stepFrom.value, 'down', stepLine.value))
const showStepDown = computed(() => fromBottom.value > 1)

// A step is the person's own move: it lets go of the bottom at once (a streamed line does not pull it back), and the
// view glides there. A wheel or a press on the list takes over from it.
function glideTo(to: string | null) {
  const el = scroller.value
  if (!el) return
  dropHold()
  stopGlide()
  userScrolls()
  pinned.value = false
  const ms = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : GLIDE_MS
  glide = { to, t0: performance.now(), ms, eased: 0, frame: 0, last: Number.NaN, still: 0, after: 0 }
  heading.value = { to }
  glide.frame = requestAnimationFrame(glideFrame)
}
function glideFrame(now: number) {
  const el = scroller.value
  const g = glide
  // No list under it any more: end the glide, or follow() and the re-pin stay off behind a glide with no frame.
  if (!el || !g) return stopGlide()
  const want = glideTarget(g.to)
  const p = g.ms ? Math.min(1, (now - g.t0) / g.ms) : 1
  const eased = easeOut(p)
  // What is left of the way shrinks by this frame's share; a measure since the last frame is already in scrollTop and want.
  const left = 1 - g.eased
  el.scrollTop = left > 0 ? want + (el.scrollTop - want) * ((1 - eased) / left) : want
  g.eased = eased
  scrollTop.value = lastTop = el.scrollTop
  fromBottom.value = distanceOf(el)
  // Landed: rows that came into view in the last frames are measured after them; hold the spot until it stays put
  // for three frames (half a second at most).
  if (p >= 1) {
    g.still = Math.abs(want - g.last) < 0.5 ? g.still + 1 : 0
    if (g.still >= 3 || ++g.after > 30) return landGlide()
  }
  g.last = want
  g.frame = requestAnimationFrame(glideFrame)
}
function landGlide() {
  const to = glide?.to
  stopGlide()
  const el = scroller.value
  if (!el || to === undefined) return
  // The bottom is followed again, as after a send; a message within 24px of it re-pins, as a hand's scroll there does.
  if (to === null) return jumpToLatest()
  if (distanceOf(el) <= 24) pinned.value = true
}
function stopGlide() {
  if (glide) cancelAnimationFrame(glide.frame)
  glide = null
  heading.value = null
}
onBeforeUnmount(stopGlide)
/** Asks for the page above until the row `id` is loaded; false when the pages ran out first. */
async function ensureLoaded(id: string): Promise<boolean> {
  for (let n = 0; n < 200 && !indexById.value.has(id); n++) {
    if ((props.olderCount ?? 0) <= 0 && !props.loadingOlder) return false
    const had = props.items.length
    if (!props.loadingOlder) emit('loadOlder')
    await nextTick()
    for (let ms = 0; ms < 15_000 && props.loadingOlder; ms += 25) await new Promise((r) => setTimeout(r, 25))
    await nextTick()
    if (props.items.length === had && !indexById.value.has(id)) return false
  }
  return indexById.value.has(id)
}
async function glideToMessage(id: string) {
  if (!indexById.value.has(id) && !(await ensureLoaded(id))) return
  glideTo(id)
}
function stepUp() {
  const i = prevStep.value
  if (i !== null) void glideToMessage(sent.value.ids[i]!)
}
function stepDown() {
  const i = nextStep.value
  if (i === null) glideTo(null)
  else void glideToMessage(sent.value.ids[i]!)
}

// The peek under the arrows (parts/MessagePeek.vue): the message the up arrow would go to, shown in a tray over the
// top while the view stays put. A second press closes it.
const peekId = ref<string | null>(null)
const peekFetched = shallowRef<Extract<TranscriptItem, { kind: 'user' }> | null>(null)
const peekItem = computed(() => {
  const i = peekId.value === null ? undefined : indexById.value.get(peekId.value)
  const r = i === undefined ? undefined : display.value[i]
  if (r?.kind === 'item' && r.item.kind === 'user') return r.item
  return peekFetched.value && peekFetched.value.id === peekId.value ? peekFetched.value : null
})
// A message outside the loaded rows is fetched by its id for the tray.
watch(peekId, async (id) => {
  peekFetched.value = null
  if (!id || indexById.value.has(id) || !props.fetchItem) return
  try {
    const it = await props.fetchItem(id)
    if (it && it.kind === 'user' && peekId.value === id) peekFetched.value = it
  } catch {
    peekId.value = null // floor-ok: nothing to show; the tray closes
  }
})
function peek() {
  const i = prevStep.value
  peekId.value = peekId.value !== null || i === null ? null : sent.value.ids[i]!
}
function goToPeek() {
  const id = peekId.value
  peekId.value = null
  if (id) void glideToMessage(id)
}

let rowObserver: ResizeObserver | null = null
let viewObserver: ResizeObserver | null = null

// A row's height includes its gap (padding-bottom), which changes when a row is appended under it: watch the border box.
const vMeasure: Directive<HTMLElement> = {
  mounted: (el) => rowObserver?.observe(el, { box: 'border-box' }),
  beforeUnmount: (el) => rowObserver?.unobserve(el),
}

// The chat's videos make the chat audible in the sidebar, and its mute reaches them (lib/chat-audio.ts).
let stopAudio: (() => void) | null = null
const followAudio = () => {
  stopAudio?.()
  stopAudio = scroller.value && props.chatId ? watchTranscript(scroller.value, props.chatId) : null
}
watch(() => props.chatId, followAudio)
onBeforeUnmount(() => stopAudio?.())

onMounted(() => {
  followAudio()
  rowObserver = new ResizeObserver((entries) => {
    const el = scroller.value
    let changed = false
    let anchorDelta = 0
    const o = offsets.value
    const firstOnScreen = el ? rowAt(o, el.scrollTop) : 0
    for (const e of entries) {
      const target = e.target as HTMLElement
      const id = target.dataset.id
      if (!id) continue
      const h = e.borderBoxSize?.[0]?.blockSize ?? target.offsetHeight
      const idx = indexById.value.get(id)
      if (idx === undefined) continue
      const old = o[idx + 1] - o[idx]
      if (Math.abs(h - old) < 0.5 && heights.has(id)) continue
      if (!heights.has(id) && settling()) settle()
      heights.set(id, h)
      layout.value.h[idx] = h
      changed = true
      // A row above the viewport changed size: keep what the owner is reading where it is (a held row does that itself).
      if (!pinned.value && !held && idx < firstOnScreen) anchorDelta += h - old
    }
    if (!changed) return
    version.value++
    if (el && anchorDelta) {
      el.scrollTop += anchorDelta
      lastTop = el.scrollTop
      scrollTop.value = el.scrollTop
    }
    // Measured after layout and before paint: the held line is put back before it is ever drawn out of place.
    keepHeld()
  })
  viewObserver = new ResizeObserver(() => {
    if (!scroller.value) return
    viewHeight.value = scroller.value.clientHeight
    follow()
  })
  if (scroller.value) {
    viewObserver.observe(scroller.value)
    viewHeight.value = scroller.value.clientHeight
  }
  // The rows mounted before the observer existed.
  scroller.value?.querySelectorAll<HTMLElement>('[data-id]').forEach((el) => rowObserver!.observe(el, { box: 'border-box' }))
  settle()
  scrollToBottom()
  window.addEventListener(CHAT_SENT_EVENT, onSent)
  // A key (Page Up, the arrows) scrolls whatever has focus; a press on the scrollbar arrives as the scroller's own.
  window.addEventListener('keydown', userScrolls, true)
  scroller.value?.addEventListener('pointerdown', onPointerDown, true)
})

onBeforeUnmount(() => {
  window.removeEventListener(CHAT_SENT_EVENT, onSent)
  window.removeEventListener('keydown', userScrolls, true)
  rowObserver?.disconnect()
  viewObserver?.disconnect()
  clearFind()
})

// Follow new items, streaming growth and re-measured rows while pinned; scrolled up, they only tell the jump button how far down the bottom is.
// The window moving follows too: a jump to the bottom is written against the rows on screen before it, and when those
// were estimated taller than they render the browser stops short; the rows that replace them at the bottom are already
// measured, so no offset changes and nothing else would take it the rest of the way (a chat whose history loaded again
// under it sat 185px above its bottom, 2026-10-14).
function onListChange() {
  if (pinned.value) return void nextTick(follow)
  trimSlack()
  if (scroller.value) fromBottom.value = distanceOf(scroller.value)
}
watch([offsets, showWorking, () => props.items[props.items.length - 1]], onListChange, { flush: 'post' })
// Once a frame: rows not measured yet land each jump on another window, and following every one of those without a
// frame between never lets them be measured (the lazy parity scene's page hung there, 2026-10-14).
let windowFollowed = false
watch(
  () => range.value.start,
  () => {
    if (windowFollowed) return
    windowFollowed = true
    requestAnimationFrame(() => (windowFollowed = false))
    onListChange()
  },
  { flush: 'post' },
)

// Find: the matches in the rows on screen are marked with the CSS Custom Highlight API, so no row
// renders again; marked again as rows come into view. The active match's row is scrolled to first (it
// may not be in the DOM yet), then the match itself, a third of the way down.
const highlights = typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null
let activeRange: Range | null = null
function clearFind() {
  highlights?.delete('desk-find')
  highlights?.delete('desk-find-active')
  activeRange = null
}
function paintFind() {
  clearFind()
  const q = props.find?.query.trim().toLowerCase()
  const el = scroller.value
  if (!highlights || !q || !el) return
  const act = props.find?.active ?? null
  const all: Range[] = []
  for (const row of el.querySelectorAll<HTMLElement>('[data-id]')) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    let nth = 0
    let first: Range | null = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue?.toLowerCase() ?? ''
      for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length)) {
        const r = new Range()
        r.setStart(n, at)
        r.setEnd(n, at + q.length)
        all.push(r)
        first ??= r
        if (act && row.dataset.id === act.itemId && nth === act.nth) activeRange = r
        nth++
      }
    }
    // The rendered text can count differently from the item's own (markdown): its first match stands in.
    if (act && row.dataset.id === act.itemId && !activeRange) activeRange = first
  }
  if (all.length) highlights.set('desk-find', new Highlight(...all))
  if (activeRange) highlights.set('desk-find-active', new Highlight(activeRange))
}
function revealActive() {
  const el = scroller.value
  if (!el || !activeRange) return
  const box = activeRange.getBoundingClientRect()
  const view = el.getBoundingClientRect()
  // The session header and its Find bar lie over the top: a match under them is not in view.
  const inset = props.insetTop ?? 0
  const top = view.top + inset
  if (box.top >= top + 48 && box.bottom <= view.bottom - 48) return
  el.scrollTop += box.top - top - (el.clientHeight - inset) / 3
  scrollTop.value = lastTop = el.scrollTop
}
// Keyed by value: the header hands a fresh object whenever the items poll in, and that must not scroll.
const activeKey = computed(() => (props.find?.active ? `${props.find.active.nth}:${props.find.active.itemId}` : ''))
watch(activeKey, () => {
  const act = props.find?.active
  const el = scroller.value
  const idx = act ? indexById.value.get(act.itemId) : undefined
  if (!el || idx === undefined) return
  stopGlide()
  pinned.value = false
  el.scrollTop = Math.max(0, offsets.value[idx] - el.clientHeight / 3)
  scrollTop.value = lastTop = el.scrollTop
  nextTick(() =>
    requestAnimationFrame(() => {
      paintFind()
      revealActive()
    }),
  )
})
/** The working line's ">" (owner, 2026-10-08, after Claude Desktop's): the step the line names opens, with the run it
 *  is folded into, and comes into view, as Find brings a match. Also asked from outside (ExternalSessionView's line). */
function revealStep(id: string) {
  const el = scroller.value
  const idx = display.value.findIndex((r) => r.id === id || (r.kind !== 'item' && r.items.some((i) => i.id === id)))
  if (!el || idx < 0) return
  const row = display.value[idx]
  if (row.kind !== 'item') tctx.show(row.id)
  tctx.show(id)
  dropHold()
  stopGlide()
  pinned.value = false
  el.scrollTop = Math.max(0, offsets.value[idx] - el.clientHeight / 3)
  scrollTop.value = lastTop = el.scrollTop
  // Once the row is drawn and has slid open: the step itself in the middle (a long run's newest call sits far down in it).
  const step = `[data-step="${CSS.escape(id)}"]`
  nextTick(() => setTimeout(() => (el.querySelector(step) ?? el.querySelector(`[data-id="${CSS.escape(row.id)}"]`))?.scrollIntoView({ block: 'center' }), COLLAPSE_MS + 20))
}
defineExpose({ revealStep })
// Without a query there is nothing to mark, so the rows scrolling or measuring do not ask the DOM anything.
// Each source is a primitive or a stable ref, so a scroll that keeps the same rendered range does not repaint.
watch(
  [() => (props.find?.query ? range.value.start : null), () => (props.find?.query ? range.value.end : null), () => (props.find?.query ? display.value : null), () => props.find?.query, activeKey],
  () => nextTick(paintFind),
  { flush: 'post' },
)
// Content that changes inside the rendered range (a tool group opening, markdown re-rendering) moves the
// text under the marks: while a query is set, one repaint per frame follows the rendered DOM.
let findMutations: MutationObserver | null = null
let findFrame = 0
function watchFindDom(on: boolean) {
  findMutations?.disconnect()
  findMutations = null
  if (findFrame) cancelAnimationFrame(findFrame)
  findFrame = 0
  const el = scroller.value
  if (!on || !el || !highlights) return
  // Only changes in a row (or rows coming and going) move the marks: the working clock under the rows ticks every second.
  const inRow = (m: MutationRecord) => {
    const t = m.target
    if ((t instanceof Element ? t : t.parentElement)?.closest('[data-id]')) return true
    return m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].some((n) => n instanceof Element && (n.matches('[data-id]') || !!n.querySelector('[data-id]')))
  }
  findMutations = new MutationObserver((records) => {
    if (findFrame || !records.some(inRow)) return
    findFrame = requestAnimationFrame(() => {
      findFrame = 0
      paintFind() // the marks are highlights, not elements: painting adds no mutation
    })
  })
  findMutations.observe(el, { childList: true, subtree: true, characterData: true })
}
watch(() => !!props.find?.query && !!scroller.value, watchFindDom, { immediate: true, flush: 'post' })
onBeforeUnmount(() => watchFindDom(false))

// The header over the top folding or unfolding changes the inset: what is on screen stays where it is
// (the header slides over it or off it) unless the list is at its top, where the first row follows it.
// Pinned to the bottom, the bottom stays.
watch(
  () => props.insetTop ?? 0,
  (now, before) => {
    const el = scroller.value
    if (!el || now === before) return
    if (pinned.value) return follow()
    if (el.scrollTop <= 0 && now > before) return
    el.scrollTop += now - before
    scrollTop.value = lastTop = el.scrollTop
  },
  { flush: 'post' },
)

// Within about two screens of the first loaded row, with more above: ask for the page above (the parent fetches it and
// puts the rows in front; the anchor below keeps the row on screen still). Asked again as long as it stays near.
const nearTop = computed(() => scrollTop.value - virtualTop.value < viewHeight.value * 2)
watch(
  [nearTop, () => props.olderCount, () => props.loadingOlder, () => props.items.length],
  () => {
    if (nearTop.value && (props.olderCount ?? 0) > 0 && !props.loadingOlder && props.items.length) emit('loadOlder')
  },
  { flush: 'post', immediate: true },
)

// Rows put in above what is on screen (a long outside session's older part, read behind its newest): scrolled up, the
// row at the top of the view stays where it is, as for a row above re-measuring; pinned, the bottom is followed as for
// any change. It is found again by an item it holds, not its row id: a run of tool calls the new rows go on from
// takes a new id (the probe of 2026-10-11 jumped 100,000px that way).
let anchor: { item: string; y: number } | null = null
const lastItemOf = (r: DisplayRow) => (r.kind === 'item' ? r.id : r.items[r.items.length - 1]?.id)
watch(display, (_now, before) => {
  anchor = null
  const el = scroller.value
  if (!el || pinned.value || !before?.length) return
  const view = el.getBoundingClientRect()
  for (const row of el.querySelectorAll<HTMLElement>('[data-id]')) {
    const box = row.getBoundingClientRect()
    if (box.bottom <= view.top + (props.insetTop ?? 0)) continue
    const r = before.find((x) => x.id === row.dataset.id)
    const item = r && lastItemOf(r)
    if (item) anchor = { item, y: box.top - view.top }
    return
  }
})
watch(
  display,
  () => {
    const a = anchor
    anchor = null
    const el = scroller.value
    if (!a || !el || pinned.value) return
    const i = display.value.findIndex((r) => (r.kind === 'item' ? r.id === a.item : r.items.some((x) => x.id === a.item)))
    if (i < 0) return
    const want = rowTop(i) - a.y
    if (Math.abs(want - el.scrollTop) < 1) return
    el.scrollTop = want
    scrollTop.value = lastTop = el.scrollTop
    fromBottom.value = distanceOf(el)
  },
  { flush: 'post' },
)

// A chat whose items arrive after it mounted (a load) starts at its bottom, as on mount.
watch(
  () => props.items.length > 0,
  (has, had) => {
    if (!has || had) return
    settle()
    pinned.value = true
    nextTick(follow)
  },
)

// A different chat starts at its bottom.
watch(
  () => props.chatId,
  () => {
    dropHold()
    stopGlide()
    peekId.value = null
    heights.clear()
    version.value++
    settle()
    pinned.value = true
    nextTick(scrollToBottom)
  },
)
</script>

<template>
  <div class="relative h-full min-h-0 bg-bg-page">
    <ContextMenu>
    <ContextMenuTrigger as-child>
    <div
      ref="scroller"
      class="@container h-full overflow-y-auto overflow-x-hidden [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
      role="feed"
      aria-label="Chat messages"
      data-transcript-scroller
      @scroll.passive="onScroll"
      @wheel.passive="onWheel"
      @click.capture="holdRow"
      @contextmenu.capture="onContextCapture"
    >
      <!-- The real column: 840 wide; text 768 at x 1151-1919 in whole-window.png, so 36px gutters (16 under a 560px pane).
           The right one is 48 once the pane is too narrow to centre the text 48 clear of its edge: the step arrows' lane
           (12px in, 24 wide, 12 clear of the text; owner, 2026-10-14: they sat on a right-hand message's picture).
           Scrolled to the bottom, the last row stands 150px over the composer (owner, 2026-10-10: "when scrolled to the
           bottom, have the bottom spacing be gapped like 150px"; on 2026-10-08 the 20px under it was a turn's gap). -->
      <div class="mx-auto w-full max-w-210 px-9 pb-[150px] @max-[864px]:pr-12 @max-[560px]:pl-4" :style="{ paddingTop: `${20 + (insetTop ?? 0)}px` }">
        <div v-if="!items.length && !showWorking" class="py-16 text-center text-ui-lg text-text-muted">{{ emptyText }}</div>
        <div class="relative" :style="{ height: `${padTop}px` }">
          <div v-if="loadingOlder" class="absolute inset-x-0 bottom-0 flex justify-center py-3 text-text-muted" role="status" aria-label="Loading earlier messages" data-testid="older-spinner">
            <LoaderCircle class="size-4 animate-spin" />
          </div>
        </div>
        <div v-for="({ r, gap }, k) in visible" :key="r.id" v-measure :data-id="r.id" :style="{ paddingBottom: `${gap}px` }">
          <ToolGroup v-if="r.kind === 'tools'" :id="r.id" :items="r.items" :tasks="r.tasks" />
          <TaskGroup v-else-if="r.kind === 'tasks'" :id="r.id" :items="r.items" />
          <BrowserCard v-else-if="r.kind === 'browser'" :item="r.items[r.items.length - 1]" :run="r.items" />
          <TranscriptRow v-else :item="r.item" :end-of-turn="r.endOfTurn" :prompt="r.prompt" :overlay-actions="display[range.start + k + 1]?.kind === 'tasks'" />
        </div>
        <div :style="{ height: `${padBottom}px` }" />
        <WorkingFooter v-if="showWorking && chat" :chat="chat" :items="items" :shimmer="liveRowId === null" class="mt-4" @reveal="revealStep" />
        <RunningTasksRow v-if="chat && !readOnly" :chat="chat" :items="items" />
        <div ref="slackEl" aria-hidden="true" />
      </div>
    </div>
    </ContextMenuTrigger>
    <ContextMenuContent :class="MENU_CONTENT">
      <ContextMenuItem :class="MENU_ITEM" @select="openInExplorer">
        <icons.folder />Open in Explorer
      </ContextMenuItem>
      <ContextMenuItem :class="MENU_ITEM" :disabled="!reveal?.path" @select="copyPath">
        <icons.copy />Copy path
      </ContextMenuItem>
      <ContextMenuLabel v-if="reveal?.media" class="px-2 py-1 text-ui-sm font-normal leading-4 text-text-muted">
        Shift + right-click for the browser menu (Loop, Save video as, Picture in picture)
      </ContextMenuLabel>
    </ContextMenuContent>
    </ContextMenu>
    <div
      v-if="revealNote"
      role="status"
      class="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-(--radius-10) bg-bg-popover px-3 py-1.5 text-ui text-text-2 shadow-(--shadow-menu-ringed)"
    >{{ revealNote }}</div>
    <MessagePeek :item="peekItem" :top="insetTop ?? 0" @close="peekId = null" @go="goToPeek" />
    <!-- Each button keeps its own slot, so the down arrow never moves up under the pointer when the up arrow goes. The peek
         sits right under the up arrow (owner, 2026-10-10, pointing there: "I thought there was supposed to be one here";
         under the down arrow it sat a slot lower at the bottom of a chat): it shows whenever the up arrow does, so no gap
         opens between them. -->
    <div
      v-if="prevStep !== null || showStepDown || peekItem"
      class="pointer-events-none absolute z-[9] flex flex-col gap-1 transition-[right] duration-(--dur-slow) ease-(--ease-snap) motion-reduce:transition-none"
      :style="{ top: `${(insetTop ?? 0) + 12}px`, right: 'calc(var(--rail-over, 0px) + 0.75rem)' }"
    >
      <span class="flex size-6">
        <Tip v-if="prevStep !== null" label="Previous message you sent" side="left">
          <button type="button" aria-label="Previous message you sent" class="tx-step" @click="stepUp">
            <icons.prevUserMessage class="size-4" />
          </button>
        </Tip>
      </span>
      <span class="flex size-6">
        <Tip v-if="prevStep !== null || peekItem" :label="peekItem ? 'Close the peek' : 'Peek at the previous message you sent'" side="left">
          <button
            type="button"
            :aria-label="peekItem ? 'Close the peek' : 'Peek at the previous message you sent'"
            :aria-pressed="!!peekItem"
            class="tx-step"
            data-testid="peek-step"
            @click="peek"
          >
            <icons.peekUserMessage class="size-4" />
          </button>
        </Tip>
      </span>
      <span class="flex size-6">
        <Tip v-if="showStepDown" :label="nextStep === null ? 'Back to the latest' : 'Next message you sent'" side="left">
          <button
            type="button"
            :aria-label="nextStep === null ? 'Back to the latest' : 'Next message you sent'"
            class="tx-step"
            @click="stepDown"
          >
            <icons.nextUserMessage class="size-4" />
          </button>
        </Tip>
      </span>
    </div>
  </div>
</template>
