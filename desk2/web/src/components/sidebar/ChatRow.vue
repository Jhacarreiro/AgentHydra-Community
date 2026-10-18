<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { ChatSummary } from '@shared/protocol'
import { StickyNote } from '@lucide/vue'
import { shellGlyphs } from '@/lib/icons'
import { useClock } from '@/lib/clock'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { chatRow, elapsedLabel, glyphDotClass, resetClock, rowMenu, rowTooltip, SERVICE_WORDS, statusGlyph, type RowMenuEntry, type RowMenuItem, type StatusGlyph } from './logic'
import { chatServices } from './services'
import ProjectRing from './ProjectRing.vue'
import { Tip } from '@/components/ui/tooltip'
import { createReusableTemplate } from '@vueuse/core'
import { useFirstInterest } from '@/lib/first-interest'
import RowMenuList from './RowMenuList.vue'
import AudioButton from './AudioButton.vue'
import { isAudible, isMuted, toggleMuted } from '@/lib/chat-audio'
import { cleanSidebar } from './clean'
import { dimText } from './rowClasses'
import RowAge from '@/lib/RowAge.vue'
import { MENU_CONTENT, focusFirstItem, runShortcut } from './menuClasses'
import ManagerAvatar from './ManagerAvatar.vue'

// One session row: 26px, r6, status dot in a 24px leading slot, the manager's avatar, title with a right fade, and on hover
// the "More options" button. The three-dot menu and the right-click menu are the same list.
const props = withDefaults(defineProps<{ chat: ChatSummary; selected?: boolean; /** Move to group's names. */ groups?: string[]; /** Compact sidebar: the project icon in a ring replaces the dot (compact.ts). */ compact?: boolean; /** That project's icon, null for none. */ icon?: string | null; /** The dot in place of the chat's own: Sidebar.vue's, with the row's running sub-tasks counted. */ dot?: StatusGlyph; /** While rows are picked together (picked.ts): whether this one is, drawn as selected in place of the open row; null while none are. */ picked?: boolean | null; /** The menu in place of the chat's own: the picked rows' (bulkMenu). */ entries?: RowMenuEntry[] }>(), {
  selected: false,
  groups: () => [],
  compact: false,
  icon: null,
  dot: undefined,
  picked: null,
  entries: undefined
})
/** `select` carries the click or key press, whose Ctrl or Shift picks rows instead of opening this one. */
const emit = defineEmits<{ select: [e: MouseEvent | KeyboardEvent]; action: [item: RowMenuItem]; rename: [title: string] }>()

/** Drawn as selected: the picked rows while there are any, else the open row. */
const lit = computed(() => props.picked ?? props.selected)
const glyph = computed(() => props.dot ?? statusGlyph(props.chat))
const speaker = computed(() => isMuted(props.chat.id) || isAudible(props.chat.id))
/** Room at the row's right end: for the three dots (and the speaker) on hover in compact mode; always otherwise, where the status dot sits. */
const extrasPad = computed(() =>
  speaker.value ? [menuOpen.value ? 'pe-11' : 'pe-6', 'group-hover/row:pe-11'] : props.compact ? ['pe-1 group-hover/row:pe-6', { 'pe-6': menuOpen.value }] : 'pe-6'
)
const menu = computed(() => props.entries ?? rowMenu({ ...chatRow(props.chat), muted: isMuted(props.chat.id) }, props.groups, null, null, chatServices.value))
// The service a pinned chat runs on, as its word (Codex, ChatGPT); Claude, the default, is not named.
const serviceWord = computed(() => (props.chat.service ? SERVICE_WORDS[props.chat.service] : null))
// The clock is read only while the row shows a time that moves (a working chat's elapsed time, a limited
// one's reset), so an idle row never redraws on the tick.
const clock = useClock()
const timed = computed(() => props.chat.status === 'working' || props.chat.status === 'starting' || props.chat.status === 'limited')
const tooltip = computed(() => rowTooltip(props.chat, timed.value ? clock.value : Date.now()))
const menuOpen = ref(false)
// The manager's card (ManagerAvatar.vue): the row's own tooltip stays hidden while it is open.
const cardOpen = ref(false)
// A row nobody touched draws its content and its trigger buttons only; its context menu and dropdown menu mount on the
// first hover or focus and stay (lib/first-interest.ts). Both menus share one row body, so it is written once.
const { seen, listeners } = useFirstInterest()
const [DefineBody, ReuseBody] = createReusableTemplate()

const dotClass = computed(() => glyphDotClass(glyph.value))

// Clean sidebar (clean.ts) leaves a working chat's elapsed time out; its pulsing dot still says it works.
const elapsed = computed(() =>
  !cleanSidebar.value && (props.chat.status === 'working' || props.chat.status === 'starting') ? elapsedLabel(props.chat.turnStartedAt, clock.value) : ''
)
const resets = computed(() => (props.chat.status === 'limited' ? resetClock(props.chat.limitResetsAt, clock.value) : ''))
// The account number and the age since its last activity, as the cloud list draws them (owner, 2026-10-07: they show
// without Cloud on, and Clean sidebar hides them). A working chat's elapsed time takes the age's place, and a limited
// one's reset time does.
const account = computed(() => (cleanSidebar.value ? null : (props.chat.account.number ?? null)))
const aged = computed(() => !cleanSidebar.value && !elapsed.value && !resets.value)

// Inline rename
const renaming = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)
function startRename() {
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
  const title = draft.value.trim()
  if (title && title !== props.chat.title) emit('rename', title)
}
let renameAfterClose = false
function run(item: RowMenuItem) {
  if (item.action === 'mute' || item.action === 'unmute') return toggleMuted(props.chat.id)
  if (item.action === 'rename') {
    renameAfterClose = true
    return
  }
  emit('action', item)
}
// The menu hands focus back to its trigger as it closes, which would blur the input at once: a rename stops that and starts
// on the next task, once the menu has finished closing (the "..." menu sits in the row and leaves with it as renaming starts).
function onMenuClosed(e: Event) {
  if (!renameAfterClose) return
  renameAfterClose = false
  e.preventDefault()
  setTimeout(startRename, 0)
}
defineExpose({ startRename })
</script>

<template>
  <!-- The Tip wraps the whole context menu from outside: a Tip between the menu root and its trigger leaves the menu's popper unplaced (it opens off-screen). -->
  <Tip :label="renaming || menuOpen || cardOpen ? '' : tooltip" side="right" align="start">
    <span class="block" v-on="listeners">
      <DefineBody>
          <!-- Compact: the project icon in its ring leads the row. Otherwise the status dot sits at the row's right end, where
               the three dots come on hover and cover it (owner, 2026-10-14, as Claude's sidebar draws it). -->
          <span v-if="compact" class="flex size-6 shrink-0 items-center justify-center">
            <ProjectRing :glyph="glyph" :icon="icon" :selected="lit" />
          </span>
          <span v-else class="w-0.5 shrink-0" aria-hidden="true" />
          <span
            v-if="!compact && !renaming"
            class="pointer-events-none absolute right-0.75 top-0.75 flex size-5 items-center justify-center transition-opacity duration-(--dur-fast) group-hover/row:opacity-0"
            :class="menuOpen && 'opacity-0'"
          >
            <span role="img" :aria-label="glyph.label" class="size-1.5 rounded-full" :class="dotClass" />
          </span>
          <!-- The manager the chat is on, left of its title (owner, 2026-10-13): its photo or initial; a click opens its card, not the chat. -->
          <ManagerAvatar v-if="chat.manager" v-model:open="cardOpen" :manager="chat.manager" />

          <input
            v-if="renaming"
            ref="input"
            v-model="draft"
            aria-label="Rename session"
            class="h-5 min-w-0 flex-1 rounded-sm bg-bg-deepest px-1 text-ui text-text outline-none ring-1 ring-accent"
            @click.stop
            @keydown.enter.stop="commitRename"
            @keydown.escape.stop="renaming = false"
            @blur="commitRename"
          />
          <span v-else class="row-title min-w-0 flex-1 overflow-hidden whitespace-nowrap" :class="{ 'row-title-open': menuOpen, 'row-title-audio': speaker }">{{ chat.title }}</span>
          <!-- A note on the chat (Add note…): its mark here, its text in the row's tooltip. -->
          <StickyNote v-if="!renaming && chat.note" role="img" aria-label="Has a note" class="size-3 shrink-0 text-text-muted" />

          <!-- Hydra Desk extras: account number, sub-items, elapsed time or age, limit reset. No CliMayte count of its own: the
               sub-item badges count the workers, and the dot runs while they do (owner, 2026-10-10: "drop the pill"). -->
          <!-- The elapsed counter and the age give their place to the three dots while the row is hovered or its menu open. -->
          <span v-if="!renaming && (account !== null || serviceWord || elapsed || aged || resets || $slots.default)" class="ms-2 flex shrink-0 items-center gap-1 text-ui-sm leading-4" :class="extrasPad">
            <span v-if="account !== null" class="shrink-0 rounded-sm bg-fill-5 px-1 text-2xs leading-4 text-text-muted tnum">#{{ account }}</span>
            <span v-if="serviceWord" class="shrink-0 rounded-sm bg-fill-5 px-1 text-2xs leading-4 text-text-muted">{{ serviceWord }}</span>
            <!-- The sub-item badges (SubBadges.vue), when the sidebar shows them as counts. -->
            <slot />
            <span v-if="elapsed" class="tnum text-text-muted" :class="compact && ['group-hover/row:hidden', { hidden: menuOpen }]">{{ elapsed }}</span>
            <RowAge v-else-if="aged" :class="compact && ['group-hover/row:hidden', { hidden: menuOpen }]" :at="chat.updatedAt" />
            <span v-if="resets" class="tnum text-(--status-limited-text)">resets {{ resets }}</span>
          </span>
          <!-- Nothing at the right end: the title still stops short of the status dot. -->
          <span v-else-if="!compact && !renaming" class="w-5 shrink-0" aria-hidden="true" />

      </DefineBody>
      <ContextMenu v-if="seen">
        <ContextMenuTrigger as-child>
        <div
          role="button"
          tabindex="0"
          :aria-current="selected ? 'page' : undefined"
          :aria-pressed="picked ?? undefined"
          class="group/row relative flex h-6.5 w-full cursor-default items-center gap-1 rounded-(--radius-6) px-0.5 text-ui leading-[19.5px] transition-colors duration-(--dur-fast) ease-(--ease-snap) select-none"
          :class="[
            lit ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover',
            menuOpen && !lit ? 'bg-fill-hover' : '',
            dimText(glyph, lit)
          ]"
          @click="(e: MouseEvent) => !renaming && emit('select', e)"
          @keydown.enter.self="(e: KeyboardEvent) => emit('select', e)"
          @keydown.f2.self="startRename"
        >
          <ReuseBody />
          <AudioButton v-if="!renaming" :chat-id="chat.id" :open="menuOpen" />
          <DropdownMenu v-if="!renaming" v-model:open="menuOpen">
            <DropdownMenuTrigger as-child>
              <button
                type="button"
                :aria-label="`More options for ${chat.title}`"
                class="absolute right-0.75 top-0.75 flex size-5 items-center justify-center rounded-(--radius-5) text-text-2 opacity-0 hover:bg-fill-hover hover:text-text focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
                @click.stop
              >
                <component :is="shellGlyphs.rowMore" class="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" :side-offset="4" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem" @close-auto-focus="onMenuClosed" @keydown.capture="(e: KeyboardEvent) => runShortcut(e, menu)">
              <RowMenuList :entries="menu" kind="dropdown" @run="run" />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
    <ContextMenuContent :class="MENU_CONTENT" @open-auto-focus="focusFirstItem" @close-auto-focus="onMenuClosed" @keydown.capture="(e: KeyboardEvent) => runShortcut(e, menu)">
      <RowMenuList :entries="menu" kind="context" @run="run" />
    </ContextMenuContent>
      </ContextMenu>
        <div
          v-else
          data-slot="context-menu-trigger"
          data-state="closed"
          role="button"
          tabindex="0"
          :aria-current="selected ? 'page' : undefined"
          :aria-pressed="picked ?? undefined"
          class="group/row relative flex h-6.5 w-full cursor-default items-center gap-1 rounded-(--radius-6) px-0.5 text-ui leading-[19.5px] transition-colors duration-(--dur-fast) ease-(--ease-snap) select-none"
          :class="[
            lit ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover',
            menuOpen && !lit ? 'bg-fill-hover' : '',
            dimText(glyph, lit)
          ]"
          @click="(e: MouseEvent) => !renaming && emit('select', e)"
          @keydown.enter.self="(e: KeyboardEvent) => emit('select', e)"
          @keydown.f2.self="startRename"
        >
          <ReuseBody />
          <AudioButton v-if="!renaming" :chat-id="chat.id" :open="menuOpen" />
          <button
            v-if="!renaming"
            type="button"
            data-slot="dropdown-menu-trigger"
            aria-haspopup="menu"
            aria-expanded="false"
            data-state="closed"
            :aria-label="`More options for ${chat.title}`"
            class="absolute right-0.75 top-0.75 flex size-5 items-center justify-center rounded-(--radius-5) text-text-2 opacity-0 hover:bg-fill-hover hover:text-text focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
            @click.stop
          >
            <component :is="shellGlyphs.rowMore" class="size-4" />
          </button>
        </div>
    </span>
  </Tip>
</template>
