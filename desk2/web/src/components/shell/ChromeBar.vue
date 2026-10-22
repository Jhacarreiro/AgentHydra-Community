<script setup lang="ts">
import { Cloud, EllipsisVertical, Rows3, Server } from '@lucide/vue'
import { agentHydraIcon, shellGlyphs, shellIcons } from '@/lib/icons'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR, MENU_SHORTCUT, focusFirstItem } from '@/components/sidebar/menuClasses'
import { markUpdateSeen, updateSeen, type UpdateOffer } from '@/lib/server-update'
import { CHROME_COLLAPSED, CHROME_OPEN } from '@/components/sidebar/width'
import type { SidebarSide } from '@/components/sidebar/side'
import { CAPTION_W } from '@/lib/host-window'

// The custom chrome bar (h36, z21) that lies over the top of the sidebar: Menu and Hide sidebar (28px, r7).
// The real app's Chat / Code mode switch is left out: Hydra Desk is Code only. Its Back and Forward arrows
// are gone too (owner, 2026-10-06); Alt + Left / Right still go back and forward (DeskFrame).
// AgentHydra 2.0 adds six: AgentHydra (slides AgentHydra in beside the sidebar), Cloud (the sidebar lists
// every session of both PCs), CliMayte (each session's running CliMayte tasks listed under it,
// sidebar/tasks.ts), Dev servers (the sidebar lists the projects and servers AgentHydra runs, servers/DevServersList.vue),
// Clean sidebar (rows without their account number and times, sidebar/clean.ts) and Compact sidebar (no project
// headers, each chat shows its project's icon in a ring, sidebar/compact.ts; owner, 2026-10-10).
// Each shows when it is on: AgentHydra pressed and Dev servers blue. Cloud, CliMayte tasks, the details and Compact sidebar
// are items of one More options menu (owner, 2026-10-12), each with a check mark while on; the details item is checked while
// the rows show their details (owner, 2026-10-08: "invert this. Make it default on. not blue and blue is off"). A thin
// divider sets More options apart from Menu and Hide sidebar, with 8px each side (owner, 2026-10-10: "a little bit more gap"). AgentHydra and Dev servers sit at the right end, after another: with the sidebar open, at its right edge; hidden, right after Compact sidebar. The bar's
// width follows the sidebar's slide (`sliding`, DeskFrame's 300 ms snap), so the two glide left and right with it.
// data-peek-zone: pointing at the toggle opens the collapsed sidebar's flyout (DeskFrame). title-drag: with the window's
// own title bar (lib/host-window.ts) its gaps drag the window, as Claude Desktop's do.
// `update`: the server's code changed after it started (lib/server-update.ts): a blue dot on Menu, and Menu has
// Restart to update (or, for a server the launcher did not start, how to restart it).
defineProps<{ sidebarOpen: boolean; width: number; side?: SidebarSide; sliding?: boolean; hydraOpen?: boolean; cloudOn?: boolean; tasksOn?: boolean; devOn?: boolean; cleanOn?: boolean; compactOn?: boolean; update?: UpdateOffer | null }>()
const emit = defineEmits<{ new: []; search: []; 'toggle-sidebar': []; settings: []; hydra: []; 'hydra-intent': []; cloud: []; tasks: []; dev: []; clean: []; compact: []; restart: [] }>()

// The colour is apart so the cloud's blue replaces it: two colour utilities on one button resolve by
// stylesheet order, not by which came last.
const BTN_SHAPE =
  'flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-7)] transition-colors duration-[60ms] hover:bg-fill-hover disabled:opacity-50 disabled:hover:bg-transparent aria-expanded:bg-fill-hover'
const BTN = `${BTN_SHAPE} text-text`
/**
 * Hidden, the bar is just its buttons: 12 + 5 buttons of 28 + 6 gaps of 4 + two 1px dividers + 12 of divider margins
 * (the More options divider's 4px each side, the right divider's 4px on its right) + 4 = 194 (sidebar/width.ts CHROME_COLLAPSED).
 * Open, it is the sidebar's width, and never less than this less the 4px right padding plus 8px more (CHROME_OPEN, 198):
 * over a narrower sidebar it reaches past its edge, and the title bar starts after it (DeskFrame titlePad).
 */
</script>

<template>
  <div
    class="title-drag absolute left-0 top-0 z-21 flex h-9 items-center gap-1 ps-3"
    :class="[sidebarOpen ? 'pe-2' : 'pe-1', sliding ? 'transition-[width,padding] duration-(--dur-slow) ease-(--ease-snap) motion-reduce:transition-none' : '']"
    :style="{ width: `${sidebarOpen ? Math.max(width, CHROME_OPEN) : CHROME_COLLAPSED}px`, ...(side === 'right' ? { left: 'auto', right: `${CAPTION_W}px` } : {}) }"
    data-peek-zone="keep"
  >
    <Tip label="Menu">
      <span class="inline-flex">
    <DropdownMenu @update:open="(open: boolean) => open && update && markUpdateSeen(true)">
        <DropdownMenuTrigger as-child>
          <button type="button" :class="[BTN, 'relative']" :aria-label="update && !updateSeen ? 'Menu (update ready)' : 'Menu'">
            <component :is="shellGlyphs.menu" class="size-4" />
            <span v-if="update && !updateSeen" class="absolute right-1 top-1 size-1.5 rounded-full bg-accent" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
      <DropdownMenuContent align="start" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
        <DropdownMenuItem :class="MENU_ITEM" @select="emit('new')">New session<DropdownMenuShortcut :class="MENU_SHORTCUT">Ctrl + N</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem :class="MENU_ITEM" @select="emit('search')">Search<DropdownMenuShortcut :class="MENU_SHORTCUT">Ctrl + K</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem :class="MENU_ITEM" @select="emit('toggle-sidebar')">
          {{ sidebarOpen ? 'Hide sidebar' : 'Show sidebar' }}<DropdownMenuShortcut :class="MENU_SHORTCUT">Ctrl + B</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator :class="MENU_SEPARATOR" />
        <DropdownMenuItem :class="MENU_ITEM" @select="emit('settings')">Settings</DropdownMenuItem>
        <template v-if="update">
          <DropdownMenuSeparator :class="MENU_SEPARATOR" />
          <DropdownMenuItem v-if="update.restartable" :class="MENU_ITEM" :disabled="update.restarting" @select="emit('restart')">
            {{ update.restarting ? 'Restarting...' : 'Restart to update' }}
          </DropdownMenuItem>
          <DropdownMenuItem v-else :class="MENU_ITEM" disabled>Server out of date: run launcher/restart.ps1</DropdownMenuItem>
          <DropdownMenuItem v-if="update.error" :class="[MENU_ITEM, 'whitespace-normal']" disabled>{{ update.error }}</DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>
      </span>
    </Tip>
    <Tip :label="`${sidebarOpen ? 'Hide' : 'Show'} sidebar (Ctrl + B)`">
      <button type="button" :class="BTN" :aria-label="sidebarOpen ? 'Hide sidebar' : 'Show sidebar'" data-peek-zone="open" @click="emit('toggle-sidebar')">
        <component :is="shellGlyphs.sidebarToggle" class="size-4" />
      </button>
    </Tip>
    <!-- A divider before Cloud, 8px each side: the bar's 4px gap and 4px more (owner, 2026-10-07: "a little normal amount", not pushed
         off to the right as AgentHydra and Dev servers are; 2026-10-10: "a little bit more gap"). -->
    <span class="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
    <!-- The four view toggles (Cloud sessions, CliMayte tasks, the details, compact mode) are items here, each checked while on
         (owner, 2026-10-12). A check mark shows the state; choosing one emits what its button did and the menu stays open, as
         the cloud filter's items do (owner, 2026-10-12: "don't close this menu when I select something so I can click
         through them faster"). Labels are the tooltips they replace, so they name the state too. It opens to the right of
         the button with a small dark shadow that shows on the dark window, where the menus' soft 24px one is lost (owner,
         2026-10-12: "fly out to the right of the icon ... add a tiny shadow to the flyout"). -->
    <Tip label="More options">
      <span class="inline-flex">
    <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button type="button" :class="[BTN, 'no-drag']" aria-label="More options">
            <EllipsisVertical class="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" :class="[MENU_CONTENT, 'shadow-[inset_0_0_0_1px_#ffffff1a,0_2px_8px_#000000a6]']" @open-auto-focus="focusFirstItem">
          <DropdownMenuCheckboxItem :class="MENU_ITEM" :model-value="!!cloudOn" @select.prevent="emit('cloud')">
            <Cloud class="size-4" />{{ cloudOn ? 'Disable cloud sessions' : 'Enable cloud sessions' }}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem :class="MENU_ITEM" :model-value="!!tasksOn" @select.prevent="emit('tasks')">
            <component :is="shellIcons.climayte" class="size-4" />{{ tasksOn ? 'Hide CliMayte tasks' : 'Show CliMayte tasks' }}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem :class="MENU_ITEM" :model-value="!cleanOn" @select.prevent="emit('clean')">
            <component :is="shellGlyphs.cleanSidebar" class="size-4" />{{ cleanOn ? 'Show more details' : 'Show fewer details' }}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem :class="MENU_ITEM" :model-value="!!compactOn" @select.prevent="emit('compact')">
            <Rows3 class="size-4" />{{ compactOn ? 'Disable compact mode' : 'Enable compact mode' }}
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
      </span>
    </Tip>
    <!-- AgentHydra and Dev servers sit at the bar's right end, after a thin divider (owner, 2026-10-07), with 8px on its right (owner, 2026-10-10). -->
    <span class="ms-auto me-1 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
    <Tip :label="hydraOpen ? 'Back to chats' : 'Open AgentHydra'">
      <button type="button" :class="[BTN, hydraOpen ? 'bg-fill-selected' : '']" aria-label="AgentHydra" :aria-pressed="!!hydraOpen" @click="emit('hydra')" @pointerenter="emit('hydra-intent')" @focus="emit('hydra-intent')">
        <component :is="agentHydraIcon" class="size-4" />
      </button>
    </Tip>
    <Tip :label="devOn ? 'Hide dev servers' : 'Show dev servers'">
      <button type="button" :class="[BTN_SHAPE, devOn ? 'text-accent-text' : 'text-text']" aria-label="Dev servers" :aria-pressed="!!devOn" @click="emit('dev')">
        <Server class="size-4" />
      </button>
    </Tip>
  </div>
</template>
