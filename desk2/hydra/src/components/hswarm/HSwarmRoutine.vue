<script setup lang="ts">
// One routine's page: its state, headline, totals and settings (read-only, as the routine reports them), its last
// run and next due, Run now, and the work it started: CliMayte workers and HSwarm jobs, drawn by HSwarmJobs (filtered by
// the routine's id, lib/managers.ts). A click on that work opens it where those rows already open.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import type { Managers } from '@/composables/useManagers'
import HSwarmJobs from '@/components/hswarm/HSwarmJobs.vue'
import { EMBEDDED, openSettingsInDesk } from '@/lib/desk-embed'
import type { HswarmState } from '@/lib/hswarm-api'
import { timeAgo } from '@/lib/format'
import { MANAGER_DOT_CLASS, canRunRoutine, outcomeTone, routineDot } from '@/lib/managers'

const props = defineProps<{ routine: string; managers: Managers; state: HswarmState | null }>()
const emit = defineEmits<{ 'open-task': [id: string, wave: boolean] }>()
const { t } = useI18n()

const r = computed(() => props.managers.routines?.routines.find((x) => x.id === props.routine) ?? null)
const last = computed(() => r.value?.runs[0] ?? null)
const totals = computed(() => Object.entries(r.value?.totals ?? {}))
const settings = computed(() => Object.entries(r.value?.settings ?? {}))
const canRun = computed(() => !!r.value && props.managers.available !== false && canRunRoutine(r.value.state, props.managers.busy === props.routine))
const dueText = computed(() => {
  const x = r.value
  if (!x || x.state === 'off' || x.state === 'broken' || x.state === 'running' || x.state === 'paused' || x.state === 'ended') return '—'
  return x.nextRunAt == null ? t('hswarm.v.managers.routines.now') : new Date(x.nextRunAt).toLocaleString()
})

// The Run now button's answer: a started run is a toast; a refusal (busy, broken, paused, unknown) says why.
const running = ref(false)
async function runNow() {
  if (!r.value || running.value) return
  running.value = true
  try {
    await props.managers.act({ run: props.routine }, props.routine)
    toast.success(t('hswarm.v.managers.routine.runStarted', { name: r.value.name }))
  } catch (err) {
    toast.error(t('hswarm.v.managers.routine.runError', { error: err instanceof Error ? err.message : String(err) }))
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <Card size="sm">
      <CardHeader>
        <div class="flex flex-wrap items-center gap-2">
          <CardTitle size="lg">{{ r?.name ?? routine }}</CardTitle>
          <span v-if="r" class="inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs">
            <span class="size-2 rounded-full" :class="MANAGER_DOT_CLASS[routineDot(r.state)]" />
            {{ t(`hswarm.v.managers.state.${r.state}`) }}
          </span>
          <Button v-if="EMBEDDED" size="sm" variant="outline" class="ms-auto" @click="openSettingsInDesk('managers')">
            {{ t('hswarm.v.managers.settings') }}
          </Button>
          <Button size="sm" :disabled="!canRun || running" @click="runNow">
            {{ running || managers.busy === routine ? t('hswarm.v.managers.routine.running') : t('hswarm.v.managers.routine.runNow') }}
          </Button>
        </div>
        <CardDescription v-if="r?.headline">{{ r.headline }}</CardDescription>
      </CardHeader>
      <CardContent stack="sm">
        <p v-if="!r" class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.routine.notRegistered') }}</p>
        <p v-if="r && r.reason" class="text-xs text-muted-foreground">{{ r.reason }}</p>
        <p v-if="r?.askedBy" class="text-xs text-muted-foreground" :title="r.askedBy">
          {{ t('hswarm.v.managers.routine.askedBy') }}: {{ r.askedBy }}
        </p>

        <template v-if="r">
          <h3 class="text-sm font-medium">{{ t('hswarm.v.managers.routine.totals') }}</h3>
          <div v-if="totals.length" class="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <div v-for="[k, v] in totals" :key="k" class="min-w-0 rounded-lg border bg-card px-3 py-2">
              <div class="truncate text-xs text-muted-foreground">{{ k }}</div>
              <div class="text-2xl font-semibold leading-8">{{ v }}</div>
            </div>
          </div>
          <p v-else class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.nothingYet') }}</p>

          <h3 class="text-sm font-medium">{{ t('hswarm.v.managers.routine.lastRun') }}</h3>
          <p v-if="last" class="text-sm">
            <span :class="outcomeTone(last.outcome)">{{ t(`hswarm.v.managers.outcome.${last.outcome}`) }}</span>
            · {{ timeAgo(last.endedAt) }}
          </p>
          <p v-else class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.routine.noRun') }}</p>
          <p v-if="last?.lastLine" class="break-all rounded-md bg-muted/40 px-2 py-1 font-mono text-xs">{{ last.lastLine }}</p>
          <p class="text-xs text-muted-foreground">{{ t('hswarm.v.managers.routine.nextDue') }}: {{ dueText }}</p>

          <h3 class="text-sm font-medium">{{ t('hswarm.v.managers.routine.settings') }}</h3>
          <Table v-if="settings.length">
            <TableBody>
              <TableRow v-for="[k, v] in settings" :key="k">
                <TableCell class="text-xs text-muted-foreground">{{ k }}</TableCell>
                <TableCell class="break-all text-xs">{{ String(v) }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p v-else class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.routine.noSettings') }}</p>
        </template>
      </CardContent>
    </Card>

    <Card size="sm">
      <CardHeader>
        <CardTitle size="lg">{{ t('hswarm.v.managers.routine.work') }}</CardTitle>
        <CardDescription>{{ t('hswarm.v.managers.routine.workNote', { id: routine }) }}</CardDescription>
      </CardHeader>
      <CardContent>
        <HSwarmJobs v-if="state" :state="state" :routine="routine" @open-task="(id, wave) => emit('open-task', id, wave)" />
        <p v-else class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.routine.noHswarm') }}</p>
      </CardContent>
    </Card>
  </div>
</template>
