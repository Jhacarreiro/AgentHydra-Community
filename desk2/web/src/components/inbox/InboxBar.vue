<script setup lang="ts">
import { computed } from 'vue'
import { Check, ChevronDown, Clock, SkipForward, X } from '@lucide/vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { MENU_CONTENT, MENU_ITEM, focusFirstItem } from '@/components/sidebar/menuClasses'
import { HOLD_MS, useInbox } from './store'
import type { HeldKind } from './hold'

// Waiting on you's bar over the conversation (store.ts): where the queue is, the conversation's source, and what moves
// it on. Answering in the conversation below (its composer, a permission, a plan, a question) moves on by itself while
// Auto-advance is on; Done is for one with nothing to answer, Later puts it at the end. Under it, the send that still
// waits for Undo.
const inbox = useInbox()
const entries = inbox.entries
const current = inbox.current
const pending = inbox.pending
const position = computed(() => (current.value ? entries.value.indexOf(current.value) + 1 : 0))
const total = computed(() => inbox.waiting.value.length)
const seconds = Math.round(HOLD_MS / 1000)
const WHAT: Record<HeldKind, string> = { message: 'Your reply', permission: 'Your permission answer', plan: 'Your plan answer', question: 'Your answer', form: 'Your form answer' }

const BTN =
  'flex h-7 shrink-0 items-center gap-1.5 rounded-(--radius-6) px-2 text-ui text-text-2 transition-colors duration-60 hover:bg-fill-hover hover:text-text disabled:opacity-50'
</script>

<template>
  <div role="region" aria-label="Waiting on you" data-testid="inbox-bar" class="shrink-0 border-b border-border bg-bg-page px-4 py-1">
    <div class="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-2 gap-y-1">
      <span class="text-ui font-medium text-text">Waiting on you</span>
      <DropdownMenu v-if="entries.length">
        <DropdownMenuTrigger as-child>
          <button type="button" :class="BTN" aria-label="Everything waiting on you">
            <template v-if="current">{{ position }} of {{ entries.length }}</template>
            <template v-else>{{ total }} waiting</template>
            <ChevronDown class="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" :class="[MENU_CONTENT, 'max-h-96 overflow-y-auto']" @open-auto-focus="focusFirstItem">
          <DropdownMenuItem v-for="e in entries" :key="e.key" :class="MENU_ITEM" @select="inbox.open(e)">
            <span class="size-1.5 shrink-0 rounded-full" :class="e.blocking ? 'bg-warning' : 'bg-text-muted'" aria-hidden="true" />
            <span class="max-w-72 truncate" :class="e.key === current?.key && 'font-medium'">{{ e.title }}</span>
            <span class="ms-auto ps-3 text-ui-sm text-text-muted">{{ e.source }}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span v-if="current" class="min-w-0 truncate text-ui text-text-muted">
        {{ current.source }}<template v-if="current.blocking"><span class="text-warning-text"> · agent stopped, waiting on you</span></template>
      </span>
      <span v-else-if="!entries.length" class="text-ui text-text-muted">Nothing is waiting on you. New ones show up here as they stop.</span>

      <div class="ms-auto flex items-center gap-0.5">
        <button v-if="current && !current.blocking" type="button" :class="BTN" title="Nothing to answer: leave the queue until it writes again" @click="inbox.done()">
          <Check class="size-3.5" />Done
        </button>
        <button v-if="current" type="button" :class="BTN" title="To the end of the queue" @click="inbox.later()">
          <Clock class="size-3.5" />Later
        </button>
        <button v-if="entries.length && !(current && entries.length === 1)" type="button" :class="BTN" @click="inbox.next()">
          <SkipForward class="size-3.5" />{{ current ? 'Next' : 'Open the first' }}
        </button>
        <button
          type="button"
          role="switch"
          :aria-checked="inbox.auto.value"
          :class="BTN"
          title="Move to the next conversation as soon as you answer this one"
          @click="inbox.setAuto(!inbox.auto.value)"
        >
          <span class="relative inline-block h-3.5 w-6 rounded-full transition-colors duration-60" :class="inbox.auto.value ? 'bg-accent' : 'bg-fill-selected'" aria-hidden="true">
            <span class="absolute top-0.5 size-2.5 rounded-full bg-text transition-[left] duration-60" :class="inbox.auto.value ? 'left-3' : 'left-0.5'" />
          </span>
          Auto-advance
        </button>
        <button type="button" :class="BTN" aria-label="Close Waiting on you" title="Close Waiting on you" @click="inbox.stop()">
          <X class="size-3.5" />
        </button>
      </div>
    </div>
    <div v-if="pending" role="status" class="mx-auto flex w-full max-w-3xl items-center gap-2 pb-0.5 text-ui text-text-2">
      <span class="min-w-0 truncate">{{ WHAT[pending.kind] }} to {{ pending.title }} goes in {{ seconds }} s</span>
      <button type="button" class="rounded-(--radius-6) px-1.5 font-medium text-accent-text hover:bg-fill-hover" @click="inbox.undo()">Undo</button>
    </div>
  </div>
</template>
