<script setup lang="ts">
// Routines' page (read-only): on or off, the routines in a table, and how many proposals wait for the owner's yes
// (those are answered in Settings > Managers > Routines, never here). A click opens one routine's page.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Managers } from '@/composables/useManagers'
import { EMBEDDED, openSettingsInDesk } from '@/lib/desk-embed'
import { timeAgo } from '@/lib/format'
import { MANAGER_DOT_CLASS, outcomeTone, routineDot } from '@/lib/managers'

const props = defineProps<{ managers: Managers }>()
const emit = defineEmits<{ open: [path: string[]] }>()
const { t } = useI18n()

const a = computed(() => props.managers.routines)
const nextDue = (ms: number | null) => (ms == null ? t('hswarm.v.managers.routines.now') : new Date(ms).toLocaleString())
</script>

<template>
  <Card size="sm">
    <CardHeader>
      <div class="flex flex-wrap items-center gap-2">
        <CardTitle size="lg">{{ t('hswarm.v.managers.routines.title') }}</CardTitle>
        <span v-if="a" class="rounded-md border px-1.5 py-0.5 text-xs" :class="a.enabled ? 'text-success' : 'text-muted-foreground'">
          {{ a.enabled ? t('hswarm.v.managers.on') : t('hswarm.v.managers.off') }}
        </span>
        <Button v-if="EMBEDDED" size="sm" variant="outline" class="ms-auto" @click="openSettingsInDesk('managers')">
          {{ t('hswarm.v.managers.settings') }}
        </Button>
      </div>
      <CardDescription>{{ t('hswarm.v.managers.routines.caption') }}</CardDescription>
    </CardHeader>
    <CardContent stack="sm">
      <p v-if="managers.error" class="text-xs text-destructive">{{ t('hswarm.v.managers.readError', { error: managers.error }) }}</p>
      <p v-if="a?.error" class="text-xs text-destructive">{{ a.error }}</p>
      <p v-if="!a" class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.nothingYet') }}</p>

      <template v-if="a">
        <p class="text-xs text-muted-foreground">
          {{ t('hswarm.v.managers.lastLook') }}: {{ timeAgo(a.checkedAt) }} · {{ t('hswarm.v.managers.nextLook') }}: {{ a.nextCheckAt ? new Date(a.nextCheckAt).toLocaleTimeString() : '—' }}
        </p>
        <p v-if="a.proposals.length" class="text-sm text-warning">
          {{ t('hswarm.v.managers.routines.waiting') }}: {{ a.proposals.length }}
        </p>
        <h3 class="text-sm font-medium">{{ t('hswarm.v.managers.routines.routines') }}</h3>
        <p v-if="!a.routines.length" class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.routines.noRoutines') }}</p>
        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>{{ t('hswarm.v.managers.routines.name') }}</TableHead>
              <TableHead>{{ t('hswarm.v.managers.routines.state') }}</TableHead>
              <TableHead>{{ t('hswarm.v.managers.routines.lastRun') }}</TableHead>
              <TableHead>{{ t('hswarm.v.managers.routines.nextDue') }}</TableHead>
              <TableHead>{{ t('hswarm.v.managers.routines.headline') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="r in a.routines" :key="r.id">
              <TableCell>
                <button type="button" class="font-medium hover:underline" @click="emit('open', ['managers', 'routines', r.id])">
                  {{ r.name }}
                </button>
              </TableCell>
              <TableCell class="whitespace-nowrap text-xs">
                <span class="inline-flex items-center gap-1.5">
                  <span class="size-2 rounded-full" :class="MANAGER_DOT_CLASS[routineDot(r.state)]" />
                  {{ t(`hswarm.v.managers.state.${r.state}`) }}
                </span>
              </TableCell>
              <TableCell class="whitespace-nowrap text-xs">
                <template v-if="r.runs[0]">
                  <span :class="outcomeTone(r.runs[0].outcome)">{{ t(`hswarm.v.managers.outcome.${r.runs[0].outcome}`) }}</span>
                  · {{ timeAgo(r.runs[0].endedAt) }}
                </template>
                <template v-else>{{ t('hswarm.v.managers.routine.noRun') }}</template>
              </TableCell>
              <TableCell class="whitespace-nowrap text-xs">{{ r.state === 'off' || r.state === 'broken' || r.state === 'paused' || r.state === 'ended' ? '—' : nextDue(r.nextRunAt) }}</TableCell>
              <TableCell class="max-w-[18rem] truncate text-xs" :title="r.reason">{{ r.headline ?? r.reason }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </template>
    </CardContent>
  </Card>
</template>
