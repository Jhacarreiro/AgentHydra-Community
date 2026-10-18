<script setup lang="ts">
import { onMounted } from 'vue'
import { Clock, Hash, ListChecks } from '@lucide/vue'
import { icons } from '@/lib/icons'
import { useClock } from '@/lib/clock'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { refreshAhInstances } from '@/components/session-header/instances'
import { useShellSource } from '@/components/shell/source'
import { timeAgo, type RowMenuEntry, type RowMenuItem } from './logic'
import { refreshChatServices } from './services'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR, MENU_SHORTCUT } from './menuClasses'

// The row menu's entries inside a right-click menu or a "..." menu: one list, either primitive set.
const props = defineProps<{ entries: RowMenuEntry[]; kind: 'context' | 'dropdown' }>()
const emit = defineEmits<{ run: [item: RowMenuItem] }>()

const ui =
  props.kind === 'context'
    ? { Item: ContextMenuItem, Separator: ContextMenuSeparator, Shortcut: ContextMenuShortcut, Sub: ContextMenuSub, SubTrigger: ContextMenuSubTrigger, SubContent: ContextMenuSubContent }
    : { Item: DropdownMenuItem, Separator: DropdownMenuSeparator, Shortcut: DropdownMenuShortcut, Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent }

// The first line's account name, Move to account and Duplicate to account read AgentHydra's account list: an opened menu
// asks for it (the list mounts with the menu), and the entries follow when it answers.
const ACCOUNT_ACTIONS = new Set<RowMenuItem['action']>(['moveToAccount', 'duplicateToAccount'])
// The Last action line's age moves while the menu is open (the list mounts with it); its tooltip is the moment itself.
const now = useClock(30_000)
const exactTime = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
// Pin service's Codex and ChatGPT are offered once AgentHydra's services have answered (sidebar/services.ts), read the same way.
const src = useShellSource()
onMounted(() => {
  if (props.entries.some((e) => e !== 'separator' && ('items' in e ? e.items.some((s) => s !== 'separator' && ACCOUNT_ACTIONS.has(s.action)) : e.identity))) void refreshAhInstances()
  if (props.entries.some((e) => e !== 'separator' && 'items' in e && e.items.some((s) => s !== 'separator' && s.action === 'pinService')))
    void refreshChatServices(() => src.chatServices())
})
</script>

<template>
  <template v-for="(entry, i) in entries" :key="i">
    <component :is="ui.Separator" v-if="entry === 'separator'" :class="MENU_SEPARATOR" />
    <component :is="ui.Sub" v-else-if="'items' in entry">
      <component :is="ui.SubTrigger" :class="MENU_ITEM">{{ entry.label }}</component>
      <component :is="ui.SubContent" :side-offset="4" :class="MENU_CONTENT" class="max-h-[60vh] overflow-y-auto">
        <template v-for="(sub, j) in entry.items" :key="j">
          <component :is="ui.Separator" v-if="sub === 'separator'" :class="MENU_SEPARATOR" />
          <component
            :is="ui.Item"
            v-else
            :disabled="sub.disabled"
            :title="sub.title"
            :role="sub.checked !== undefined ? 'menuitemradio' : undefined"
            :aria-checked="sub.checked"
            :class="MENU_ITEM"
            @select="emit('run', sub)"
          >
            <span class="min-w-0 flex-1 truncate">{{ sub.label }}</span>
            <span v-if="sub.hint" class="ms-3 shrink-0 text-ui-sm text-text-muted">{{ sub.hint }}</span>
            <component :is="icons.check" v-if="sub.checked" class="ms-3" />
          </component>
        </template>
      </component>
    </component>
    <!-- The first line: the row's id and its account, muted beside it; a click copies the whole id. -->
    <component
      :is="ui.Item"
      v-else-if="entry.identity"
      :title="entry.title"
      :aria-label="`Copy the ID ${entry.value}${entry.hint ? `, on ${entry.hint}` : ''}`"
      :class="MENU_ITEM"
      @select="emit('run', entry)"
    >
      <Hash class="size-3.5 shrink-0 text-text-muted" />
      <span class="shrink-0 font-mono text-ui-sm text-text-2">{{ entry.label }}</span>
      <span v-if="entry.hint" class="ms-auto min-w-0 truncate ps-4 text-ui-sm text-text-muted">{{ entry.hint }}</span>
    </component>
    <!-- Rows picked together (bulkMenu): the first line counts them; text, not a command. -->
    <div v-else-if="entry.action === 'picked'" role="none" :class="MENU_ITEM" class="flex items-center select-none">
      <ListChecks class="size-3.5 shrink-0 text-text-muted" />
      <span class="shrink-0 text-ui-sm text-text-2">{{ entry.label }}</span>
    </div>
    <!-- The line under it: how long ago the row last did something, the exact time in its tooltip; text, not a command. -->
    <div v-else-if="entry.since !== undefined" role="none" :title="exactTime(entry.since)" :class="MENU_ITEM" class="flex items-center select-none">
      <Clock class="size-3.5 shrink-0 text-text-muted" />
      <span class="shrink-0 text-ui-sm text-text-2">{{ entry.label }}</span>
      <span class="ms-auto ps-4 text-ui-sm text-text-muted tnum">{{ timeAgo(entry.since, now) }}</span>
    </div>
    <component
      :is="ui.Item"
      v-else
      :variant="entry.danger ? 'destructive' : 'default'"
      :disabled="entry.disabled"
      :title="entry.title"
      :data-shortcut="entry.shortcut"
      :class="MENU_ITEM"
      @select="emit('run', entry)"
    >
      <span class="flex-1">{{ entry.label }}</span>
      <component :is="ui.Shortcut" v-if="entry.shortcut" :class="MENU_SHORTCUT">{{ entry.shortcut }}</component>
    </component>
  </template>
</template>
