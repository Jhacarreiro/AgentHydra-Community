<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { AccountInfo, ChatSummary, ExternalSession } from '@shared/protocol'
import { icons, settingsIcons, shellGlyphs, shellIcons } from '@/lib/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { chatRow, elapsedLabel, glyphDotClass, resetClock, rowMenu, statusGlyph, type RowMenuItem } from '@/components/sidebar/logic'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR, focusFirstItem, runShortcut } from '@/components/sidebar/menuClasses'
import RowMenuList from '@/components/sidebar/RowMenuList.vue'
import { chatServices } from '@/components/sidebar/services'
import { resumable } from '@/components/external/logic'
import AccountSubmenu from './AccountSubmenu.vue'
import WorkspacePicker from './WorkspacePicker.vue'
import ConnectionsChip from '@/components/connectors/ConnectionsChip.vue'
import { connectorList } from '@/components/connectors/connections-api'
import { CONNECTIONS_LOGO_URL, showConnectionsChip } from '@/components/connectors/connections-logic'
import { ListTodo, PanelRightClose, PanelRightOpen, Search } from '@lucide/vue'
import { findAsk, findShown } from '@/components/session-header/state'
import { fourmanAvailable } from '@/components/fourman/store'
import { openDashboard } from '@/components/dashboard/store'
import { DashboardGlyph } from '@/components/dashboard/glyph'
import { useClock } from '@/lib/clock'
import { isMuted, toggleMuted } from '@/lib/chat-audio'

// The title bar inside the pane (h32): session title (click to rename), its menu, the folder pill,
// Hydra Desk's status cue, and on the right the 26px pane buttons. Hydra Desk 2: an outside session's
// title bar has one, the session header's fold (components/session-header).
export type RightPane = 'diff' | 'climayte' | 'servers' | 'connections' | 'todo'

const props = withDefaults(
  defineProps<{
    chat: ChatSummary | null
    /** Title of a view that is not a chat (CliMayte, Elsewhere, Settings); empty on the new-session screen. */
    title?: string
    pane?: RightPane | null
    /** Accounts for the chat menu's "Account" submenu. */
    accounts?: AccountInfo[]
    /** A session running elsewhere: read-only unless it is a Claude Code session. */
    external?: ExternalSession | null
    /** Its stand-in chat while the composer can carry it on: the "…" menu picks the account it continues on. */
    standIn?: ChatSummary | null
    /** View options: thinking blocks open in the transcript. */
    showThinking?: boolean
    /** The chat menu's Move to group names. */
    groups?: string[]
    /** The session rail is on screen, and how many background tasks run in the session. */
    railOpen?: boolean
    tasksRunning?: number
    /** A failed action to say in the title bar, left of its buttons; empty when there is none. */
    alert?: string
  }>(),
  { title: '', pane: null, accounts: () => [], external: null, standIn: null, showThinking: false, groups: () => [], railOpen: false, tasksRunning: 0, alert: '' }
)
const emit = defineEmits<{
  action: [item: RowMenuItem]
  rename: [title: string]
  'toggle-pane': [pane: RightPane]
  account: [id: string]
  'update:showThinking': [show: boolean]
  'toggle-rail': []
}>()

const menu = computed(() => (props.chat ? rowMenu({ ...chatRow(props.chat), muted: isMuted(props.chat.id) }, props.groups, null, null, chatServices.value) : []))
// The right block's floor: its buttons, 26px each and 4px apart, counted as they show (a floor short of them let the
// centred title run under Changes once the rail button joined them). An alert shrinks into whatever room is left beside them.
// The title group's hide points (@max-[553px] the folder pill, 462 the status text, 379 the glyph, 347 the Connections chip,
// 319 the smaller More button and the CliMayte count) are where its items stop fitting beside all six buttons (176px). The
// gap before the buttons never closes: an alert with no room left still sits in it.
const side = computed(() => {
  const n = props.chat ? 4 + Number(fourmanAvailable.value) + Number(connectionsShown.value) : props.external ? 1 : 0
  return `${n ? n * 26 + (n - 1) * 4 : 0}px`
})

// Hydra Desk status cue: only states the real app hides (idle and stopped show nothing). Only a working or
// limited chat's cue reads the clock, so the bar redraws on the tick only while its time moves.
const clock = useClock()
const cue = computed(() => {
  const c = props.chat
  if (!c) return null
  const g = statusGlyph(c)
  switch (c.status) {
    case 'starting':
      if (c.waiting) return { text: 'Waiting', tone: 'text-text-muted', dot: 'bg-[var(--status-working)] animate-dot-blink' }
      return { text: 'Starting', tone: 'text-text-muted', dot: 'bg-[var(--status-working)] animate-dot-blink' }
    case 'working': {
      const t = elapsedLabel(c.turnStartedAt, clock.value)
      return { text: t ? `Working · ${t}` : 'Working', tone: 'text-text-muted', dot: 'bg-[var(--status-working)] animate-dot-blink' }
    }
    case 'needs_you':
      return { text: 'Needs you', tone: 'text-warning-text', dot: 'bg-[var(--status-needs-you)] animate-dot-pulse' }
    case 'error':
      return { text: 'Error', tone: 'text-danger-text', dot: 'bg-[var(--status-error)]' }
    case 'limited': {
      const t = resetClock(c.limitResetsAt, clock.value)
      return { text: t ? `Limited · resets ${t}` : 'Limited', tone: 'text-[var(--status-limited-text)]', dot: glyphDotClass(g) }
    }
    case 'closed':
      return { text: g.label, tone: 'text-text-muted opacity-70', dot: '' }
    default:
      return null
  }
})

// Rename in place
const renaming = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)
function startRename() {
  if (!props.chat) return
  draft.value = props.chat.title
  renaming.value = true
  nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
}
function commitRename() {
  if (!renaming.value) return
  renaming.value = false
  const t = draft.value.trim()
  if (t && props.chat && t !== props.chat.title) emit('rename', t)
}
let renameAfterClose = false
function run(item: RowMenuItem) {
  if (item.action === 'mute' || item.action === 'unmute') {
    if (props.chat) toggleMuted(props.chat.id)
  } else if (item.action === 'rename') renameAfterClose = true
  else emit('action', item)
}
// The menu hands focus back to its trigger as it closes, which would blur the input at once: a rename stops that and starts
// on the next task, once the menu has finished closing (the "..." menu sits in the row and leaves with it as renaming starts).
function onMenuClosed(e: Event) {
  if (!renameAfterClose) return
  renameAfterClose = false
  e.preventDefault()
  setTimeout(startRename, 0)
}

const connectionsShown = computed(() => showConnectionsChip(connectorList.value))
const logoFailed = ref(false)

// The running-tasks count on Session details while the rail is shut (open, the rail says it): gray, not the accent (owner,
// 2026-10-08: "an annoying blue icon, make it grey"); a solid gray so the icon under its corner does not show through.
const COUNT_BADGE =
  'tnum absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--text-muted)_55%,var(--bg-page))] px-0.75 text-3xs font-medium leading-none text-text'

const DASHBOARD_BTN =
  'ms-0.5 flex size-5 shrink-0 items-center justify-center rounded-(--radius-6) text-text-2 transition-colors duration-[60ms] hover:bg-fill-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent @max-[553px]:hidden'

const PANE_BTN =
  'flex size-[26px] items-center justify-center rounded-[var(--radius-6)] text-text-2 transition-colors duration-[60ms] hover:bg-fill-hover hover:text-text aria-pressed:bg-fill-selected aria-pressed:text-text aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-expanded:bg-fill-hover aria-expanded:text-text'
</script>

<template>
  <!-- Three columns: the title in the middle one, centred on the pane (the other owner, 2026-10-04), with each side
       column at least as wide as the buttons on the right so a long title stops short of them. With the window's own
       title bar (lib/host-window.ts) this row is the title bar: its right end keeps clear of the window's buttons
       (--caption-w), so the pane buttons sit beside them (owner, 2026-10-08: "move these icons, here"). -->
  <header
    class="@container flex h-8 min-w-0 items-center gap-x-2 ps-1 pe-[calc(0.75rem+var(--caption-w))] text-ui leading-[19.5px]"
    :style="{ '--side': side }"
  >
    <span aria-hidden="true" class="min-w-0 flex-1" />
    <div class="flex min-w-0 flex-[0_1_auto] items-center overflow-hidden" :class="chat && '@max-[379px]:-ms-2'">
    <template v-if="chat">
      <span class="flex size-6 shrink-0 items-center justify-center text-text @max-[379px]:hidden" aria-hidden="true">
        <component :is="shellGlyphs.local" class="size-4" />
      </span>
      <input
        v-if="renaming"
        ref="input"
        v-model="draft"
        aria-label="Rename session"
        class="h-6 w-[320px] max-w-[40vw] rounded-(--radius-6) bg-bg-deepest px-1 text-ui font-medium text-text outline-none ring-1 ring-accent"
        @keydown.enter="commitRename"
        @keydown.escape="renaming = false"
        @blur="commitRename"
      />
      <Tip v-else label="Rename session">
        <button
          type="button"
          :aria-label="`${chat.title}, rename session`"
          class="flex h-6 min-w-16 shrink cursor-default items-center rounded-(--radius-6) px-1 font-medium text-text hover:bg-fill-hover"
          @click="startRename"
        >
          <span class="truncate">{{ chat.title }}</span>
        </button>
      </Tip>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            :aria-label="`More options for ${chat.title}`"
            class="-ms-1 flex size-6 shrink-0 items-center justify-center rounded-(--radius-6) text-text-2 hover:bg-fill-hover hover:text-text data-[state=open]:bg-fill-hover @max-[319px]:size-5"
          >
            <component :is="shellGlyphs.more" class="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem" @close-auto-focus="onMenuClosed" @keydown.capture="(e: KeyboardEvent) => runShortcut(e, menu)">
          <p class="max-w-72 truncate px-2 py-1 text-ui-sm leading-4 text-text-muted" :title="chat.cwd">{{ chat.cwd }}</p>
          <RowMenuList :entries="menu" kind="dropdown" @run="run" />
          <!-- A chat pinned to another service runs on its account there, so Claude's account is not offered. -->
          <template v-if="accounts.length && !chat.service">
            <DropdownMenuSeparator :class="MENU_SEPARATOR" />
            <AccountSubmenu :accounts="accounts" :current="chat.account.id" note="Applies at the chat's next start" @pick="(id: string) => emit('account', id)" />
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
      <WorkspacePicker :chat="chat" />
      <Tip v-if="chat" label="Project dashboard">
        <button type="button" data-fit="dashboard" :class="DASHBOARD_BTN" aria-label="Project dashboard" @click="openDashboard(chat.cwd)">
          <DashboardGlyph class="size-3.5" aria-hidden="true" />
        </button>
      </Tip>

      <!-- Hydra Desk extras -->
      <span v-if="cue" data-fit="status" class="ms-1 flex h-5 shrink-0 items-center gap-1.5 text-ui-sm leading-4 @max-[319px]:ms-0" :class="cue.tone" role="status" :aria-label="cue.text">
        <span v-if="cue.dot" class="size-1.5 shrink-0 rounded-full" :class="cue.dot" />
        <span class="tnum @max-[462px]:hidden">{{ cue.text }}</span>
      </span>
      <Tip v-if="chat.climayteActive > 0" label="CliMayte workers">
        <button
          type="button"
          class="ms-1 flex h-5 shrink-0 cursor-default items-center gap-1 rounded-(--radius-6) px-1.25 text-ui-sm leading-4 text-text-2 hover:bg-fill-hover @max-[319px]:hidden"
          :aria-label="`${chat.climayteActive} CliMayte ${chat.climayteActive === 1 ? 'worker' : 'workers'} active`"
          :aria-pressed="pane === 'climayte'"
          @click="emit('toggle-pane', 'climayte')"
        >
          <component :is="shellIcons.climayte" class="size-3.5" />
          <span class="tnum">{{ chat.climayteActive }}</span>
        </button>
      </Tip>
      <div class="contents @max-[347px]:hidden"><ConnectionsChip :chat="chat" /></div>
    </template>
    <template v-else-if="external">
      <span class="truncate px-1 font-medium text-text">{{ external.title }}</span>
      <span v-if="!resumable(external)" class="ms-1 shrink-0 text-ui-sm leading-4 text-text-muted">read-only</span>
      <DropdownMenu v-else-if="standIn && accounts.length">
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            :aria-label="`More options for ${external.title}`"
            class="-ms-1 flex size-6 shrink-0 items-center justify-center rounded-(--radius-6) text-text-2 hover:bg-fill-hover hover:text-text data-[state=open]:bg-fill-hover"
          >
            <component :is="shellGlyphs.more" class="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
          <AccountSubmenu :accounts="accounts" :current="standIn.account.id" note="Where its next message continues it" @pick="(id: string) => emit('account', id)" />
        </DropdownMenuContent>
      </DropdownMenu>
    </template>
    <span v-else-if="title" class="truncate px-1 font-medium text-text">{{ title }}</span>
    </div>

    <!-- The right column has a fixed minimum, so the alert truncates inside it and never moves the centred title. -->
    <div class="flex min-w-(--side) flex-1 shrink-0 items-center justify-end gap-1">
    <Tip v-if="alert" :label="alert"><p role="alert" data-fit="alert" class="min-w-0 truncate pe-1 text-ui-sm leading-4 text-danger-text @max-[286px]:sr-only">{{ alert }}</p></Tip>
    <div v-if="chat" class="flex shrink-0 items-center gap-1">
      <Tip label="Changes">
        <button type="button" :class="PANE_BTN" aria-label="Changes" :aria-pressed="pane === 'diff'" @click="emit('toggle-pane', 'diff')">
          <component :is="shellGlyphs.changes" class="size-4" />
        </button>
      </Tip>
      <Tip label="Browser and servers">
        <button type="button" :class="PANE_BTN" aria-label="Browser and servers" :aria-pressed="pane === 'servers'" @click="emit('toggle-pane', 'servers')">
          <component :is="shellGlyphs.browser" class="size-4" />
        </button>
      </Tip>
      <Tip v-if="fourmanAvailable" label="To-do">
        <button type="button" :class="PANE_BTN" aria-label="To-do" :aria-pressed="pane === 'todo'" @click="emit('toggle-pane', 'todo')">
          <ListTodo class="size-4" />
        </button>
      </Tip>
      <Tip v-if="connectionsShown" label="Connections">
        <button type="button" :class="PANE_BTN" aria-label="Connections" :aria-pressed="pane === 'connections'" @click="emit('toggle-pane', 'connections')">
          <img v-if="!logoFailed" :src="CONNECTIONS_LOGO_URL" alt="" class="size-4" @error="logoFailed = true" />
          <component :is="settingsIcons.connections" v-else class="size-4" />
        </button>
      </Tip>
      <Tip label="View options">
        <span class="inline-flex">
      <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button type="button" :class="PANE_BTN" aria-label="View options">
              <component :is="shellGlyphs.viewOptionsDots" class="size-4" />
            </button>
          </DropdownMenuTrigger>
        <DropdownMenuContent align="end" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
          <DropdownMenuItem role="menuitemcheckbox" :aria-checked="showThinking" :class="MENU_ITEM" @select="emit('update:showThinking', !showThinking)">
            <span class="flex-1">Show thinking</span>
            <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="showThinking" /></span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
        </span>
      </Tip>
    </div>
    <!-- Find in an outside session, beside Session details whether the rail is open or shut (owner, 2026-10-14: "move the
         search here"); the session header holds the Find bar (session-header/state.ts findAsk). -->
    <Tip v-if="external" label="Find in session (Ctrl + F)">
      <button type="button" :class="PANE_BTN" class="shrink-0" aria-label="Find in session" :aria-pressed="findShown" @click="findAsk++">
        <Search class="size-4" />
      </button>
    </Tip>
    <!-- The session rail (components/rail, owner 2026-10-14), at the end as Claude Desktop has it: Background tasks are in it. -->
    <Tip v-if="chat || external" :label="railOpen ? 'Hide session details' : 'Show session details'">
      <button
        type="button"
        :class="PANE_BTN"
        class="relative shrink-0"
        :aria-label="railOpen ? 'Hide session details' : 'Show session details'"
        :aria-description="tasksRunning ? `${tasksRunning} background ${tasksRunning === 1 ? 'task' : 'tasks'} running` : undefined"
        @click="emit('toggle-rail')"
      >
        <component :is="railOpen ? PanelRightClose : PanelRightOpen" class="size-4" />
        <span v-if="tasksRunning && !railOpen" :class="COUNT_BADGE">{{ tasksRunning }}</span>
      </button>
    </Tip>
    </div>
  </header>
</template>
