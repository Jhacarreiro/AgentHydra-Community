<script setup lang="ts">
// A routine's Edit form, opened in its card (owner, 2026-10-13: "I need to be able to, like, edit them ... I can't rename them
// either"): its name, when it runs, what it runs, its folder, its timeout and its last day. Save sends only what changed
// (POST /api/routines `edit`); the server refuses a file that would not check out, and its reason shows here.
import { computed, ref } from 'vue'
import type { Routine } from '@shared/routines'
import { BUTTON, FIELD } from './settings-styles'
import { localZone, scheduleSentence } from './routine-view'

const props = defineProps<{
  routine: Routine
  /** A save is under way. */
  busy: boolean
  /** Why the last save was refused, or ''. */
  error: string
}>()
const emit = defineEmits<{ save: [set: Record<string, unknown>]; cancel: [] }>()

const r = props.routine
const name = ref(r.name)
const schedule = ref(r.schedule ?? '')
const windowsTask = ref(r.windowsTask ?? '')
const prompt = ref(r.prompt ?? '')
const command = ref((r.command ?? []).join('\n'))
const statusCommand = ref((r.statusCommand ?? []).join('\n'))
const cwd = ref(r.cwd ?? '')
const timeout = ref(r.timeoutMinutes ?? 120)
const until = ref(r.until ?? '')

const LABEL = 'grid min-w-0 gap-1 text-ui-sm leading-4.5 text-text-2'
const AREA =
  'w-full resize-y rounded-[var(--radius-6)] bg-fill-5 px-2 py-1.5 text-ui text-text shadow-[inset_0_0_0_1px_var(--border)] outline-none focus:shadow-[var(--focus-ring)]'
const SAVE =
  'flex h-7 shrink-0 cursor-default items-center rounded-[var(--radius-6)] bg-accent px-2.5 text-ui font-medium text-white transition-colors duration-[60ms] hover:bg-accent-hover focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-50'

/** A command as the form writes it: one argument per line. */
const argsOf = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
const sameArgs = (a: string[], b: string[] | null): boolean => JSON.stringify(a) === JSON.stringify(b ?? [])
const scheduleHint = computed(() => (schedule.value.trim() ? scheduleSentence(schedule.value.trim(), localZone()) : ''))

/** Only what changed; an emptied optional field is removed (null). */
const changes = computed(() => {
  const set: Record<string, unknown> = {}
  if (name.value.trim() !== r.name) set.name = name.value.trim()
  if (r.kind === 'schedule' && schedule.value.trim() !== r.schedule) set.schedule = schedule.value.trim()
  if (r.kind === 'windowsTask' && windowsTask.value.trim() !== r.windowsTask) set.windowsTask = windowsTask.value.trim()
  if (r.what === 'prompt' && prompt.value.trim() !== r.prompt) set.prompt = prompt.value.trim()
  if (r.what === 'run' && !sameArgs(argsOf(command.value), r.command)) set.run = argsOf(command.value)
  if (r.kind === 'status' && !sameArgs(argsOf(statusCommand.value), r.statusCommand)) set.status = argsOf(statusCommand.value)
  if (r.kind !== 'windowsTask') {
    if (cwd.value.trim() !== (r.cwd ?? '')) set.cwd = cwd.value.trim() || null
    if (Number(timeout.value) !== r.timeoutMinutes) set.timeoutMinutes = Number(timeout.value)
  }
  if (until.value !== (r.until ?? '')) set.until = until.value || null
  return set
})
const changed = computed(() => Object.keys(changes.value).length > 0)
</script>

<template>
  <form class="mt-3 grid gap-2 border-t border-[var(--border)] pt-3" @submit.prevent="emit('save', changes)">
    <label :class="LABEL">
      Name
      <input v-model="name" :class="[FIELD, 'w-full']" required />
    </label>
    <label v-if="routine.kind === 'schedule'" :class="LABEL">
      Schedule (cron, local time)
      <input v-model="schedule" :class="[FIELD, 'w-full font-mono']" spellcheck="false" />
      <span v-if="scheduleHint" class="text-text-muted">{{ scheduleHint }}</span>
    </label>
    <label v-if="routine.kind === 'windowsTask'" :class="LABEL">
      Windows task
      <input v-model="windowsTask" :class="[FIELD, 'w-full font-mono']" spellcheck="false" />
    </label>
    <label v-if="routine.what === 'prompt'" :class="LABEL">
      Prompt
      <textarea v-model="prompt" rows="6" :class="AREA" />
    </label>
    <label v-if="routine.what === 'run'" :class="LABEL">
      Command, one argument per line
      <textarea v-model="command" rows="4" :class="[AREA, 'font-mono text-ui-sm']" spellcheck="false" />
    </label>
    <label v-if="routine.kind === 'status'" :class="LABEL">
      Status command, one argument per line
      <textarea v-model="statusCommand" rows="3" :class="[AREA, 'font-mono text-ui-sm']" spellcheck="false" />
    </label>
    <div class="flex flex-wrap gap-2">
      <label v-if="routine.kind !== 'windowsTask'" :class="[LABEL, 'flex-1 basis-56']">
        Folder
        <input v-model="cwd" :class="[FIELD, 'w-full font-mono']" spellcheck="false" />
      </label>
      <label v-if="routine.kind !== 'windowsTask'" :class="[LABEL, 'w-28']">
        Timeout, min
        <input v-model.number="timeout" type="number" min="5" max="360" :class="[FIELD, 'tnum w-full']" />
      </label>
      <label :class="[LABEL, 'w-40']">
        Last day
        <input v-model="until" type="date" :class="[FIELD, 'w-full']" />
      </label>
    </div>
    <div v-if="error" role="alert" class="wrap-break-word text-ui-sm leading-4.5 text-danger-text">{{ error }}</div>
    <div class="flex flex-wrap gap-2">
      <button type="submit" :class="SAVE" :disabled="busy || !changed">Save</button>
      <button type="button" :class="BUTTON" :disabled="busy" @click="emit('cancel')">Cancel</button>
    </div>
  </form>
</template>
