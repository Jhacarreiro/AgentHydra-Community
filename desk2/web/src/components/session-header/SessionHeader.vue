<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronUp, Coins, MessagesSquare, Monitor, Search, ShieldAlert, Sparkles, UserRound, X } from '@lucide/vue'
import type { SearchResult } from '@shared/find'
import type { ExternalSession, TranscriptItem } from '@shared/protocol'
import { actionError } from '@/lib/action-error'
import { icons, newSessionGlyphs, shellGlyphs } from '@/lib/icons'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR, focusFirstItem } from '@/components/sidebar/menuClasses'
import { folderLabel } from '@/components/sidebar/logic'
import { openDashboard } from '@/components/dashboard/store'
import { DashboardGlyph } from '@/components/dashboard/glyph'
import { modelName } from '@/components/cloud/logic'
import { useCloud } from '@/components/cloud/store'
import { useShellSource } from '@/components/shell/source'
import { showInstanceInHydra } from '@/components/hydra/api'
import { ah, settingsMissed } from './ah'
import { ahInstances, refreshAhInstances, setInstanceAccount } from './instances'
import {
  accountName,
  ahSource,
  displayFiltered,
  fileIsText,
  fileLocationText,
  findHits,
  hasFile,
  instanceFor,
  instanceName,
  instanceTarget,
  sourceName,
  turnCount,
  usageDetail,
  usageSummary,
  wrapIndex,
  type AhSecrets,
  type AhSessionRow,
  type AhUsage,
  type FindHit
} from './logic'
import { displayPrefs, findAsk, findShown, restartPeek } from './state'
import { RAIL_TARGETS, railTargets } from '@/components/rail/state'
import { RAIL_ICON, RAIL_ICON_BTN, RAIL_ROW, RAIL_ROW_BTN } from '@/components/rail/classes'

// Hydra Desk 2's session header for an outside session: what AgentHydra's Sessions tab said and offered
// about the open session, which this replaces (the other owner, 2026-10-04). Its facts, rows of a gray icon and the
// fact as Claude Desktop's rail draws them (the source with its short id, the account, the folder, the branch,
// the model; turns, tokens and cost, credentials it printed), and its actions (Find and the ⋯ menu: account,
// display, session file, terminal, migrate, close) are drawn into the session rail's
// Environment and Context cards (components/rail, owner 2026-10-14: the bar across the top became the rail)
// while the rail is on screen. The source row copies the id, the folder row opens the folder (its dashboard
// on hover), the account row shows that account in AgentHydra's Instances.
//
// The Find bar (Ctrl + F) lies over the top of the transcript; the transcript keeps its first row clear of
// it through the inset this reports (update:inset).
const props = defineProps<{
  sessionId: string
  session: ExternalSession | null
  /** Every item, for the turn count. */
  items: TranscriptItem[]
  /** What the transcript shows (the display filters applied): what Find searches. */
  shown: TranscriptItem[]
  /** Find over the whole transcript on the server (the items loaded are only its newest part); null when it cannot answer. */
  search?: (query: string) => Promise<SearchResult | null>
  /** Loads the page holding the item, so the transcript can scroll to it. */
  reveal?: (itemId: string) => Promise<void>
}>()
const emit = defineEmits<{
  'update:find': [find: { query: string; active: FindHit | null } | null]
  /** How much of the transcript's top the header and its Find bar cover now. */
  'update:inset': [px: number]
}>()

const src = useShellSource()
const cloud = useCloud()

// AgentHydra's row for the session, then its usage and credential scan; any of them may not answer
// (a CliMayte worker's session is not in its index), and the header says what it knows.
const row = ref<AhSessionRow | null>(null)
const usage = ref<AhUsage | null>(null)
const secrets = ref<AhSecrets | null>(null)
const instances = computed(() => ahInstances.value ?? [])

async function loadUsage(r: AhSessionRow) {
  usage.value = await ah.usage(r).catch(() => null)
}
async function load(id: string) {
  row.value = null
  usage.value = null
  secrets.value = null
  const cloudRow = cloud.sessions.value.find((s) => s.id === id)
  const r = await ah.session(id, ahSource(props.session?.source, cloudRow?.source)).catch(() => null)
  if (!r || id !== props.sessionId) return
  row.value = r
  restartPeek()
  void loadUsage(r)
  void ah.secrets(r).then((s) => row.value === r && (secrets.value = s), () => {})
}
watch(() => props.sessionId, load, { immediate: true })
// A turn that ends has added to the count.
watch(
  () => props.session?.status,
  (now, before) => {
    if (row.value && before && now !== before) void loadUsage(row.value)
  }
)
onMounted(() => void refreshAhInstances())

// The account: Claude Desktop sessions only, resolved from the instance label (exactly one match).
const inst = computed(() => instanceFor(instances.value, row.value))
watch(inst, async (i) => {
  if (!i || i.account?.email) return
  const account = await ah.instanceAccount(i.dir).catch(() => null)
  if (account) setInstanceAccount(i.dir, account)
})
const account = computed(() => {
  const r = row.value
  if (!r?.instance || (r.source !== 'claude' && !r.instance_num)) return null
  const i = r.source === 'claude' ? inst.value : null
  return { name: r.source === 'claude' ? accountName(i, r.instance) : r.instance, email: i?.account?.email?.trim() || null, instance: i }
})
// The chip shows the account in AgentHydra's Instances, on its own row.
const target = computed(() => instanceTarget(row.value))
const accountTip = computed(() => {
  const a = account.value
  if (!a) return ''
  const who =
    a.email ??
    (a.instance || row.value?.source !== 'claude' ? 'No address resolved for this account yet. It may be signed out' : 'This account is not in the instance list right now')
  return target.value ? `${who}. Click to show it in AgentHydra's Instances` : who
})
function showAccount() {
  const t = target.value
  if (t) showInstanceInHydra(t.num, t.kind)
}
async function openFolder() {
  const path = cwd.value
  if (!path) return
  try {
    await src.revealFolder(path)
  } catch {
    say("Couldn't open the folder", true)
  }
}

const title = computed(() => row.value?.title || props.session?.title || 'Session')
const cwd = computed(() => row.value?.cwd || props.session?.cwd || null)
const shortId = computed(() => props.sessionId.slice(0, 8))
// Turns over the whole session as AgentHydra counts them (its tokens and cost are over the same file),
// else the prompts in the transcript shown: Desk reads only a long session file's last 8 MB.
const prompts = computed(() => turnCount(props.items))
const sessionTurns = computed(() => (usage.value?.status === 'ok' ? usage.value.tokens.turns : null))
const turns = computed(() => sessionTurns.value ?? prompts.value)
const turnsTip = computed(() => {
  const yours = `${prompts.value} of your ${prompts.value === 1 ? 'prompt is' : 'prompts are'} in the transcript shown here`
  return sessionTurns.value === null ? yours : `Claude's turns over the whole session, as AgentHydra counts them for tokens and cost. ${yours}.`
})
const usageText = computed(() => usageSummary(usage.value))
const usageTip = computed(() => usageDetail(usage.value))
const model = computed(() => [modelName(row.value?.model ?? props.session?.model), row.value?.effort].filter(Boolean).join(' · '))
const filtered = computed(() => displayFiltered(displayPrefs.value))

// A short line saying what an action did (Desk has no toasts), gone after a few seconds.
const note = ref<{ text: string; bad: boolean } | null>(null)
let noteTimer: ReturnType<typeof setTimeout> | null = null
function say(text: string, bad = false) {
  note.value = { text, bad }
  if (noteTimer) clearTimeout(noteTimer)
  noteTimer = setTimeout(() => (note.value = null), 3500)
}
watch(actionError, (text) => {
  if (text) say(text, true)
})
async function clip(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text)
    say(done)
  } catch {
    say("Couldn't reach the clipboard", true)
  }
}

function copyId() {
  void clip(props.sessionId, 'Copied the session id')
}
const copyingLocation = ref(false)
async function copyLocation(pathOnly = false) {
  const r = row.value
  if (!r || copyingLocation.value) return
  copyingLocation.value = true
  try {
    const { path } = await ah.fileLocation(r)
    void clip(pathOnly ? path : fileLocationText(path, title.value), pathOnly ? 'Copied the session file location' : 'Copied the prompt, the session name and its file location')
  } catch {
    say("Couldn't copy the session file location", true)
  } finally {
    copyingLocation.value = false
  }
}
async function openFile() {
  const r = row.value
  if (!r) return
  const ok = await ah.openFile(r).then((x) => x.ok, () => false)
  if (!ok) say("Couldn't open the session file", true)
}
const copyingFile = ref(false)
async function copyFile() {
  const r = row.value
  if (!r || copyingFile.value) return
  copyingFile.value = true
  try {
    const x = await ah.copyFile(r)
    if (x.ok) say(`Copied ${x.filename ?? 'the session file'} to the clipboard; paste it anywhere that takes a file`)
    else say(x.reason === 'unsupported' ? 'Copying a file to the clipboard needs Windows or macOS' : "Couldn't copy the session file to the clipboard", true)
  } catch {
    say("Couldn't copy the session file to the clipboard", true)
  } finally {
    copyingFile.value = false
  }
}
const resuming = ref(false)
async function resumeInTerminal() {
  const r = row.value
  if (!r || resuming.value) return
  resuming.value = true
  try {
    const x = await ah.resumeInTerminal(r)
    if (x.ok) say('Opened a terminal for this session')
    else {
      await navigator.clipboard.writeText(x.command).catch(() => {})
      say("Couldn't open a terminal, so the command is on your clipboard", true)
    }
  } catch {
    say("Couldn't reopen this session", true)
  } finally {
    resuming.value = false
  }
}
async function bringAccount() {
  const i = account.value?.instance
  if (!i) return
  const x = await (i.isRunning ? ah.focusInstance(i.dir) : ah.openInstance(i.dir)).catch(() => null)
  if (x?.ok) say(i.isRunning ? 'Instance focused' : 'Instance opened')
  else say(x?.message ?? (i.isRunning ? 'Failed to focus instance window' : 'Failed to open instance'), true)
}
function copyEmail() {
  const email = account.value?.email
  if (email) void clip(email, 'Copied the account this instance is signed into')
}

// Migrate: every other desktop instance, running ones first; a closed one is not started, the chat
// lands in its store for when it starts.
const targets = computed(() =>
  instances.value.map((i) => ({ ref: `desktop:${i.dir}`, name: instanceName(i), num: i.num, isRunning: i.isRunning, isCurrent: i.dir === inst.value?.dir }))
)
const migrating = ref(false)
async function migrateTo(t: { ref: string; name: string }) {
  const r = row.value
  if (!r || migrating.value) return
  migrating.value = true
  try {
    const x = await ah.migrate(r, t.ref)
    const missed = settingsMissed(x)
    if (!x.ok) say(x.error ?? "Couldn't migrate this chat", true)
    else if (x.sourceStillShown?.length) say(`Migrated to ${t.name}. An old account still lists it.${missed}`, true)
    else say(`Migrated to ${t.name}. The chat is in that desktop app now, ready to carry on.${missed}`, !!missed)
  } catch (err) {
    say(err instanceof Error ? err.message : "Couldn't migrate this chat", true)
  } finally {
    migrating.value = false
  }
}
function menuOpened(open: boolean) {
  // Running state moves while the header stays open.
  if (open) void refreshAhInstances(true)
}

function setDisplay(key: 'humanOnly' | 'showTools' | 'showThinking' | 'compact') {
  displayPrefs.value = { ...displayPrefs.value, [key]: !displayPrefs.value[key] }
}

// Find: over what the transcript shows, as AgentHydra's did; Enter for the next, Shift + Enter the
// one before, Esc closes.
const findOpen = ref(false)
const query = ref('')
const index = ref(0)
const findInput = ref<HTMLInputElement | null>(null)
// The scan follows the typed query about 150 ms after the last keystroke; an emptied box answers at once.
const searched = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null
// The server's answer (the whole transcript) is used while the display filters hide nothing; else, or while it is
// out, the loaded items are scanned.
const served = ref<{ query: string; result: SearchResult } | null>(null)
const serverUsable = computed(() => !!props.search && props.shown.length === props.items.length)
const hits = computed<FindHit[]>(() => {
  if (!findOpen.value) return []
  if (serverUsable.value && served.value?.query === searched.value) return served.value.result.hits
  return findHits(props.shown, searched.value)
})
const total = computed(() => (serverUsable.value && served.value?.query === searched.value ? served.value.result.total : hits.value.length))
watch([searched, findOpen], async ([q, open]) => {
  served.value = null
  if (!open || !q.trim() || !props.search) return
  const result = await props.search(q).catch(() => null)
  if (result && searched.value === q) served.value = { query: q, result }
})
watch(query, (q) => {
  index.value = 0
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = null
  if (!q.trim()) searched.value = q
  else searchTimer = setTimeout(() => (searched.value = query.value), 150)
})
onBeforeUnmount(() => searchTimer && clearTimeout(searchTimer))
let revealing = 0
watch(
  [findOpen, searched, index, hits],
  async () => {
    const active = findOpen.value ? (hits.value[wrapIndex(index.value, hits.value.length)] ?? null) : null
    const mine = ++revealing
    if (active && props.reveal && !props.items.some((i) => i.id === active.itemId)) {
      // floor-ok: a reveal that throws still lets Find move on; the page it could not load is asked again near the top
      await props.reveal(active.itemId).catch(() => {})
      if (mine !== revealing) return
    }
    emit('update:find', findOpen.value ? { query: searched.value, active } : null)
  },
  { immediate: true }
)
function openFind() {
  findOpen.value = true
  void nextTick(() => {
    findInput.value?.focus()
    findInput.value?.select()
  })
}
function closeFind() {
  findOpen.value = false
  query.value = ''
  index.value = 0
}
function step(by: number) {
  if (hits.value.length) index.value = wrapIndex(index.value + by, hits.value.length)
}
function onFindKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    step(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeFind()
  }
}
function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    openFind()
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
// The title bar's search button (state.ts findAsk) opens and closes it, and shows it pressed while it is open.
watch(findAsk, () => (findOpen.value ? closeFind() : openFind()))
watch(findOpen, (open) => (findShown.value = open), { immediate: true })
onBeforeUnmount(() => {
  findShown.value = false
  window.removeEventListener('keydown', onKey)
  if (noteTimer) clearTimeout(noteTimer)
})

const secretsOpen = ref(false)
const close = () => src.select({ kind: 'new' })

// What the Find bar covers.
const findEl = ref<HTMLElement | null>(null)
const findH = ref(0)
let sizes: ResizeObserver | null = null
function measure() {
  findH.value = findEl.value?.offsetHeight ?? 0
}
onMounted(() => {
  sizes = new ResizeObserver(measure)
  measure()
})
watch(findEl, (el, old) => {
  if (old) sizes?.unobserve(old)
  if (el) sizes?.observe(el)
  measure()
})
onBeforeUnmount(() => sizes?.disconnect())
const inset = computed(() => (findOpen.value ? findH.value : 0))
watch(inset, (px) => emit('update:inset', px), { immediate: true })

// The colour is apart so the ⋯ button's blue (a display filter is on) replaces it rather than racing it.
const BTN_SHAPE =
  'flex size-[26px] shrink-0 items-center justify-center rounded-[var(--radius-6)] transition-colors duration-[60ms] hover:bg-fill-hover disabled:opacity-40 disabled:hover:bg-transparent aria-expanded:bg-fill-hover'
const BTN = `${BTN_SHAPE} text-text-2 hover:text-text aria-expanded:text-text`
</script>

<template>
  <!-- Over the top of the transcript (ExternalSessionView clips it): the Find bar. -->
  <div class="pointer-events-none absolute inset-x-0 top-0 z-10">
    <div v-if="findOpen" ref="findEl" class="pointer-events-auto border-b border-border bg-bg-page py-1 ps-3 pe-2" role="search">
      <div class="flex w-full items-center gap-1 text-ui-sm leading-4">
        <Search class="size-3.5 shrink-0 text-text-muted" />
        <input
          ref="findInput"
          v-model="query"
          aria-label="Find in this session"
          placeholder="Find in this session…"
          class="h-6 min-w-0 flex-1 bg-transparent px-1 text-ui text-text outline-none placeholder:text-text-muted"
          @keydown="onFindKey"
        />
        <span class="shrink-0 tnum text-text-muted" role="status">{{ searched.trim() ? (hits.length ? `${wrapIndex(index, hits.length) + 1} of ${total}` : 'No matches') : '' }}</span>
        <Tip label="Previous match (Shift + Enter)">
          <button type="button" :class="BTN" aria-label="Previous match" :disabled="!hits.length" @click="step(-1)"><ChevronUp class="size-4" /></button>
        </Tip>
        <Tip label="Next match (Enter)">
          <button type="button" :class="BTN" aria-label="Next match" :disabled="!hits.length" @click="step(1)"><ChevronDown class="size-4" /></button>
        </Tip>
        <Tip label="Close find (Esc)">
          <button type="button" :class="BTN" aria-label="Close find" @click="closeFind"><X class="size-4" /></button>
        </Tip>
      </div>
    </div>

    <!-- In the session rail's cards while it is on screen (RAIL_TARGETS); the rail sets railTargets once they are in the page. -->
    <template v-if="railTargets">
      <Teleport defer :to="`#${RAIL_TARGETS.actions}`">
        <Tip :label="filtered ? 'Part of this transcript is hidden by a display filter' : 'More actions'">
          <span class="inline-flex">
            <DropdownMenu @update:open="menuOpened">
              <DropdownMenuTrigger as-child>
                <button type="button" :class="filtered ? `${BTN_SHAPE} text-accent-text` : BTN" aria-label="More actions">
                  <component :is="shellGlyphs.rowMore" class="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" :class="MENU_CONTENT" class="min-w-56" @open-auto-focus="focusFirstItem">
                <template v-if="account || target">
                  <DropdownMenuItem v-if="target" :class="MENU_ITEM" @select="showAccount">Show this account in Instances</DropdownMenuItem>
                  <DropdownMenuItem v-if="account?.instance" :class="MENU_ITEM" @select="bringAccount">
                    {{ account.instance.isRunning ? 'Bring this account to the front' : 'Open this account' }}
                  </DropdownMenuItem>
                  <DropdownMenuItem v-if="account" :class="MENU_ITEM" :disabled="!account.email" @select="copyEmail">Copy the account address</DropdownMenuItem>
                  <DropdownMenuSeparator :class="MENU_SEPARATOR" />
                </template>
                <DropdownMenuItem v-if="cwd" :class="MENU_ITEM" @select="openFolder">Open the folder</DropdownMenuItem>
                <DropdownMenuSeparator v-if="cwd" :class="MENU_SEPARATOR" />

                <DropdownMenuLabel class="flex h-5.75 items-center px-2 py-0 text-ui-sm font-medium text-text-muted">Display</DropdownMenuLabel>
                <DropdownMenuItem role="menuitemcheckbox" :aria-checked="displayPrefs.humanOnly" :class="MENU_ITEM" @select="setDisplay('humanOnly')">
                  <span class="flex-1">Only what I typed</span>
                  <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="displayPrefs.humanOnly" /></span>
                </DropdownMenuItem>
                <DropdownMenuItem role="menuitemcheckbox" :aria-checked="displayPrefs.showTools" :disabled="displayPrefs.humanOnly" :class="MENU_ITEM" @select="setDisplay('showTools')">
                  <span class="flex-1">Show tool activity</span>
                  <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="displayPrefs.showTools" /></span>
                </DropdownMenuItem>
                <DropdownMenuItem role="menuitemcheckbox" :aria-checked="displayPrefs.showThinking" :disabled="displayPrefs.humanOnly" :class="MENU_ITEM" @select="setDisplay('showThinking')">
                  <span class="flex-1">Show reasoning</span>
                  <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="displayPrefs.showThinking" /></span>
                </DropdownMenuItem>
                <DropdownMenuItem role="menuitemcheckbox" :aria-checked="displayPrefs.compact" :class="MENU_ITEM" @select="setDisplay('compact')">
                  <span class="flex-1">Compact layout</span>
                  <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="displayPrefs.compact" /></span>
                </DropdownMenuItem>

                <template v-if="row && hasFile(row.source)">
                  <DropdownMenuSeparator :class="MENU_SEPARATOR" />
                  <DropdownMenuLabel class="flex h-5.75 items-center px-2 py-0 text-ui-sm font-medium text-text-muted">Session file</DropdownMenuLabel>
                  <DropdownMenuItem v-if="fileIsText(row.source)" :class="MENU_ITEM" @select="openFile">Open session file</DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger :class="MENU_ITEM">Save copy of session file</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent :class="MENU_CONTENT">
                      <DropdownMenuItem as-child :class="MENU_ITEM"><a :href="ah.exportUrl(row, 'markdown')" download>Save as Markdown</a></DropdownMenuItem>
                      <DropdownMenuItem as-child :class="MENU_ITEM"><a :href="ah.exportUrl(row, 'html')" download>Save as a web page</a></DropdownMenuItem>
                      <DropdownMenuItem as-child :class="MENU_ITEM"><a :href="ah.fileUrl(row)" download>Save the raw .jsonl</a></DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuItem :class="MENU_ITEM" :disabled="copyingFile" @select="copyFile">Copy session file to clipboard</DropdownMenuItem>
                  <DropdownMenuItem :class="MENU_ITEM" @select="copyLocation(true)">Copy the file location only</DropdownMenuItem>
                </template>

                <template v-if="row?.source === 'claude'">
                  <DropdownMenuSeparator :class="MENU_SEPARATOR" />
                  <DropdownMenuItem :class="MENU_ITEM" :disabled="resuming" @select="resumeInTerminal">Reopen in a terminal</DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger :class="MENU_ITEM" :disabled="migrating">Migrate to another account</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent :class="MENU_CONTENT" class="max-h-[60vh] overflow-y-auto">
                      <DropdownMenuItem v-if="!targets.length" :class="MENU_ITEM" disabled>No other instances</DropdownMenuItem>
                      <template v-if="targets.some((t) => t.isRunning)">
                        <DropdownMenuLabel class="px-2 py-1 text-ui-sm font-medium text-text-muted">Running</DropdownMenuLabel>
                        <DropdownMenuItem
                          v-for="t in targets.filter((x) => x.isRunning)"
                          :key="t.ref"
                          :class="MENU_ITEM"
                          :disabled="t.isCurrent || migrating"
                          @select="migrateTo(t)"
                        >
                          <span class="tnum text-text-muted">#{{ t.num }}</span><span class="flex-1 truncate">{{ t.name }}</span>
                        </DropdownMenuItem>
                      </template>
                      <template v-if="targets.some((t) => !t.isRunning)">
                        <DropdownMenuLabel class="max-w-64 px-2 py-1 text-ui-sm font-medium text-text-muted">Not running: lands in its store, ready when it starts</DropdownMenuLabel>
                        <DropdownMenuItem
                          v-for="t in targets.filter((x) => !x.isRunning)"
                          :key="t.ref"
                          :class="MENU_ITEM"
                          :disabled="t.isCurrent || migrating"
                          @select="migrateTo(t)"
                        >
                          <span class="tnum text-text-muted">#{{ t.num }}</span><span class="flex-1 truncate">Move to {{ t.name }}</span>
                        </DropdownMenuItem>
                      </template>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </template>

                <DropdownMenuSeparator :class="MENU_SEPARATOR" />
                <DropdownMenuItem :class="MENU_ITEM" @select="close">Close this session</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </Tip>
      </Teleport>
      <Teleport defer :to="`#${RAIL_TARGETS.environment}`">
        <ul class="flex flex-col">
          <li v-if="row">
            <Tip label="Copy session id">
              <button type="button" :class="RAIL_ROW_BTN" :aria-label="`${sourceName(row)} session ${sessionId}, copy id`" @click="copyId">
                <Monitor :class="RAIL_ICON" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate text-text">{{ sourceName(row) }}</span>
                <span class="font-mono text-ui-sm text-text-muted">{{ shortId }}</span>
              </button>
            </Tip>
          </li>
          <li v-if="account || target">
            <Tip :label="account ? accountTip : 'Show this account in AgentHydra\'s Instances'">
              <button
                v-if="target"
                type="button"
                :class="RAIL_ROW_BTN"
                :aria-label="account ? `Account ${account.name}, show it in AgentHydra's Instances` : `Instance #${target.num}, show it in AgentHydra's Instances`"
                @click="showAccount"
              >
                <UserRound :class="RAIL_ICON" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate text-text">{{ account?.name ?? `Instance #${target.num}` }}</span>
                <span v-if="account && row?.instance_num" class="tnum text-ui-sm text-text-muted">#{{ row.instance_num }}</span>
              </button>
              <span v-else :class="RAIL_ROW" tabindex="0">
                <UserRound :class="RAIL_ICON" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate text-text">{{ account?.name }}</span>
              </span>
            </Tip>
          </li>
          <li v-if="cwd" class="group/row relative">
            <Tip :label="`Open ${cwd}`">
              <button type="button" :class="RAIL_ROW_BTN" class="pe-8" :aria-label="`Folder ${folderLabel(cwd)}, open it`" @click="openFolder">
                <component :is="newSessionGlyphs.folder" :class="RAIL_ICON" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate text-text">{{ folderLabel(cwd) }}</span>
              </button>
            </Tip>
            <span class="absolute inset-y-0 right-0.5 flex items-center opacity-0 transition-opacity duration-60 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
              <Tip label="Project dashboard">
                <button type="button" :class="RAIL_ICON_BTN" aria-label="Project dashboard" @click="openDashboard(cwd)">
                  <DashboardGlyph class="size-3.5" aria-hidden="true" />
                </button>
              </Tip>
            </span>
          </li>
          <li v-if="row?.git_branch && row.git_branch !== 'HEAD'" :class="RAIL_ROW">
            <component :is="newSessionGlyphs.branch" :class="RAIL_ICON" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate text-text">{{ row.git_branch }}</span>
          </li>
          <li v-if="model" :class="RAIL_ROW">
            <Sparkles :class="RAIL_ICON" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate text-text">{{ model }}</span>
          </li>
        </ul>
      </Teleport>
      <Teleport defer :to="`#${RAIL_TARGETS.context}`">
        <ul class="flex flex-col">
          <li>
            <Tip :label="turnsTip">
              <span :class="RAIL_ROW" tabindex="0">
                <MessagesSquare :class="RAIL_ICON" aria-hidden="true" />
                <span class="tnum min-w-0 flex-1 truncate text-text">{{ turns.toLocaleString() }} {{ turns === 1 ? 'turn' : 'turns' }}</span>
              </span>
            </Tip>
          </li>
          <li v-if="usageText">
            <Tip :label="usageTip">
              <span :class="RAIL_ROW" tabindex="0" aria-label="Tokens and cost">
                <Coins :class="RAIL_ICON" aria-hidden="true" />
                <span class="tnum min-w-0 flex-1 truncate text-text">{{ usageText }}</span>
              </span>
            </Tip>
          </li>
          <li v-if="secrets && secrets.count > 0">
            <Tip :label="`This session printed ${secrets.count} thing${secrets.count === 1 ? '' : 's'} that look like credentials. Click for the list.`">
              <button type="button" :class="RAIL_ROW_BTN" @click="secretsOpen = true">
                <ShieldAlert class="size-4 shrink-0 text-warning-text" aria-hidden="true" />
                <span class="tnum min-w-0 flex-1 truncate text-warning-text">{{ secrets.count }} {{ secrets.count === 1 ? 'secret' : 'secrets' }} printed</span>
              </button>
            </Tip>
          </li>
        </ul>
      </Teleport>
    </template>

    <Transition enter-from-class="opacity-0" leave-to-class="opacity-0" enter-active-class="transition duration-150" leave-active-class="transition duration-300">
      <p
        v-if="note"
        role="status"
        class="pointer-events-auto absolute right-3 max-w-[70%] truncate rounded-(--radius-10) bg-bg-popover px-2.5 py-1 text-ui-sm leading-4 shadow-(--shadow-menu-ringed)"
        :class="note.bad ? 'text-danger-text' : 'text-text-2'"
        :style="{ top: `${inset + 6}px` }"
      >
        {{ note.text }}
      </p>
    </Transition>

    <Dialog :open="secretsOpen" @update:open="(o: boolean) => (secretsOpen = o)">
      <DialogContent class="gap-3 rounded-(--radius-12) p-4 shadow-(--shadow-popover) ring-0 sm:max-w-120">
        <DialogTitle class="text-ui-lg font-semibold leading-5 text-text">Credentials found in this transcript</DialogTitle>
        <DialogDescription class="text-ui-sm leading-4 text-text-muted">
          Shown redacted, and never revealed here. Only unmistakable formats are matched, so this is a prompt to go and rotate something, not a clean bill of health.
        </DialogDescription>
        <ul class="flex max-h-[50vh] flex-col gap-1 overflow-y-auto text-ui-sm leading-4">
          <li v-for="(f, i) in secrets?.findings ?? []" :key="i" class="flex items-center gap-2">
            <span class="shrink-0 rounded-(--radius-6) border border-border px-1.5 text-text-2">{{ f.kind }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-text">{{ f.redacted }}</span>
            <span class="shrink-0 tnum text-text-muted">turn {{ f.turn + 1 }}</span>
          </li>
        </ul>
        <p v-if="secrets?.truncated" class="text-ui-sm text-text-muted">Showing the first findings of {{ secrets.count }}.</p>
      </DialogContent>
    </Dialog>
  </div>
</template>
