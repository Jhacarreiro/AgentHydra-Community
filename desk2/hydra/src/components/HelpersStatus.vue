<script setup lang="ts">
// The header's always-on helpers chip (owner, 2026-10-12: the background servers and watchers were
// "random PowerShells that sit on their own, and Pythons that sit on their own"; the daemon owns them
// now, server/src/helpers.ts). At a glance: how many run and the memory they hold, amber when one is
// down. Open: each helper with its memory drawn against the largest, a restart on each, and Stop all,
// which acts at once and offers Undo. Hidden on a PC with no helpers.json.
import { Boxes, Power, PowerOff, RotateCw } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { HelperRow, HelpersView } from '@agenthydra/server/types'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import * as api from '@/lib/api'
import { visibleInterval } from '@/lib/visible-poll'
import IconTooltip from '@/shell/IconTooltip.vue'

const { t } = useI18n()
const view = shallowRef<HelpersView | null>(null)
const open = ref(false)
const busy = ref<string | null>(null)

async function load() {
  try {
    view.value = await api.getHelpers()
  } catch {
    // the next poll tries again; the chip keeps its last answer
  }
}

let stopPoll: (() => void) | null = null
onMounted(() => {
  void load()
  stopPoll = visibleInterval(() => void load(), 10_000)
})
onBeforeUnmount(() => stopPoll?.())

async function act(key: string, call: () => Promise<HelpersView>): Promise<boolean> {
  busy.value = key
  try {
    view.value = await call()
    return true
  } catch (e) {
    toast.error(t('helpers.failed', { reason: e instanceof Error ? e.message : String(e) }))
    return false
  } finally {
    busy.value = null
  }
}

function restart(id: string) {
  void act(id, () => api.restartHelper(id))
}

async function toggleAll() {
  if (view.value?.paused) return void act('all', api.startHelpers)
  if (!(await act('all', api.stopHelpers))) return
  toast(t('helpers.stoppedToast'), {
    action: { label: t('helpers.undo'), onClick: () => void act('all', api.startHelpers) },
  })
}

const rows = computed(() => view.value?.helpers ?? [])
const visible = computed(() => rows.value.some((h) => !h.managed) || !!view.value?.configError)
const down = computed(() => rows.value.filter((h) => !h.managed && h.state !== 'running').length)
const totalMB = computed(() => rows.value.reduce((sum, h) => sum + (h.memoryMB ?? 0), 0))
const largestMB = computed(() => Math.max(1, ...rows.value.map((h) => h.memoryMB ?? 0)))

function memory(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

const label = computed(() => {
  if (view.value?.paused) return t('helpers.chipStopped')
  if (down.value) return t('helpers.chipDown', { n: down.value })
  return t('helpers.chip', { n: rows.value.length, memory: memory(totalMB.value) })
})
const tone = computed(() => (view.value?.paused || down.value ? 'text-warning' : 'text-success/70'))

function dot(h: HelperRow): string {
  if (h.state === 'running') return 'bg-success'
  if (h.state === 'stopped') return 'bg-muted-foreground/50'
  return 'bg-warning'
}

function note(h: HelperRow): string | null {
  if (h.state === 'running') return null
  if (h.managed) return t('helpers.managed')
  if (h.lastError) return h.lastError
  if (h.state === 'starting') return t('helpers.starting')
  if (h.state === 'stopped') return t('helpers.stopped')
  return t('helpers.waiting')
}
</script>

<template>
  <!-- Popover inside IconTooltip, wrapped in a plain <span>, as SchedulerStatus.vue explains. -->
  <IconTooltip v-if="visible" :label="label" :description="t('helpers.tooltip')">
    <span class="inline-flex">
      <Popover v-model:open="open">
        <PopoverTrigger as-child>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            :class="tone"
            :aria-label="label"
          >
            <Boxes class="size-3.5" />
            <span class="hidden tabular-nums sm:inline">{{ label }}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-72">
          <div class="mb-2 flex items-baseline justify-between gap-2">
            <p class="text-xs font-medium">{{ $t('helpers.title') }}</p>
            <span class="text-2xs tabular-nums text-muted-foreground">{{ memory(totalMB) }}</span>
          </div>
          <p v-if="view?.configError" class="mb-2 text-2xs text-warning">
            {{ $t('helpers.configError', { error: view.configError }) }}
          </p>
          <ul class="flex flex-col gap-1.5">
            <li v-for="h in rows" :key="h.id" class="flex flex-col">
              <div class="flex items-center gap-2">
                <span class="size-2 shrink-0 rounded-full" :class="dot(h)" />
                <span class="min-w-0 flex-1 truncate text-xs" :title="h.label">{{ h.label }}</span>
                <span class="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-muted">
                  <span
                    class="block h-full rounded-full bg-foreground/40"
                    :style="{ width: `${Math.round(((h.memoryMB ?? 0) / largestMB) * 100)}%` }"
                  />
                </span>
                <span class="w-12 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
                  {{ h.memoryMB === null ? '' : memory(h.memoryMB) }}
                </span>
                <Button
                  v-if="!h.managed"
                  variant="ghost"
                  size="icon-xs"
                  :disabled="busy !== null"
                  :title="$t('helpers.restart', { name: h.label })"
                  :aria-label="$t('helpers.restart', { name: h.label })"
                  @click="restart(h.id)"
                >
                  <RotateCw :class="busy === h.id ? 'animate-spin' : ''" />
                </Button>
                <span v-else class="size-5 shrink-0" />
              </div>
              <p v-if="note(h)" class="ms-4 truncate text-2xs text-warning" :title="note(h) ?? ''">{{ note(h) }}</p>
            </li>
          </ul>
          <Button
            variant="ghost"
            size="xs"
            class="mt-2 w-full justify-start"
            :disabled="busy !== null"
            @click="toggleAll()"
          >
            <component :is="view?.paused ? Power : PowerOff" class="size-3.5" />
            {{ $t(view?.paused ? 'helpers.startAll' : 'helpers.stopAll') }}
          </Button>
        </PopoverContent>
      </Popover>
    </span>
  </IconTooltip>
</template>
