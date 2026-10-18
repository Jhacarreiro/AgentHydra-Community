<script setup lang="ts">
// The Babysitter's page (read-only): what GET /api/babysitter answers, the chats a usage limit stopped and what it did.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Managers } from '@/composables/useManagers'
import { timeAgo } from '@/lib/format'
import { EMBEDDED, openSettingsInDesk } from '@/lib/desk-embed'

const props = defineProps<{ managers: Managers }>()
const { t } = useI18n()

const s = computed(() => props.managers.babysitter)
const sourceName = (src: string) => t(`hswarm.v.managers.babysitter.source.${src}`, src)
const resetText = (ms: number | null) => (ms == null ? t('hswarm.v.managers.babysitter.noReset') : t('hswarm.v.managers.babysitter.resets', { when: new Date(ms).toLocaleString() }))
</script>

<template>
  <Card size="sm">
    <CardHeader>
      <div class="flex flex-wrap items-center gap-2">
        <CardTitle size="lg">{{ t('hswarm.v.managers.babysitter.title') }}</CardTitle>
        <span v-if="s" class="rounded-md border px-1.5 py-0.5 text-xs" :class="s.enabled ? 'text-success' : 'text-muted-foreground'">
          {{ s.enabled ? t('hswarm.v.managers.on') : t('hswarm.v.managers.off') }}
        </span>
        <Button v-if="EMBEDDED" size="sm" variant="outline" class="ms-auto" @click="openSettingsInDesk('managers')">
          {{ t('hswarm.v.managers.settings') }}
        </Button>
      </div>
      <CardDescription>{{ t('hswarm.v.managers.babysitter.caption') }}</CardDescription>
    </CardHeader>
    <CardContent stack="sm">
      <p v-if="managers.error" class="text-xs text-destructive">{{ t('hswarm.v.managers.readError', { error: managers.error }) }}</p>
      <p v-if="s?.error" class="text-xs text-destructive">{{ s.error }}</p>
      <p v-if="!s" class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.nothingYet') }}</p>

      <template v-if="s">
        <div class="grid grid-cols-2 gap-2">
          <div class="min-w-0 rounded-lg border bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">{{ t('hswarm.v.managers.babysitter.stopped') }}</div>
            <div class="text-2xl font-semibold leading-8">{{ s.stopped.length }}</div>
          </div>
          <div class="min-w-0 rounded-lg border bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">{{ t('hswarm.v.managers.babysitter.accounts') }}</div>
            <div class="text-2xl font-semibold leading-8">{{ s.accounts.length }}</div>
            <p class="truncate text-xs text-muted-foreground">
              {{ t('hswarm.v.managers.lastLook') }}: {{ timeAgo(s.checkedAt) }} · {{ t('hswarm.v.managers.nextLook') }}: {{ s.nextCheckAt ? new Date(s.nextCheckAt).toLocaleTimeString() : '—' }}
            </p>
          </div>
        </div>

        <h3 class="text-sm font-medium">{{ t('hswarm.v.managers.babysitter.chats') }}</h3>
        <p v-if="!s.stopped.length" class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.babysitter.noChats') }}</p>
        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>{{ t('hswarm.v.managers.babysitter.chatHead') }}</TableHead>
              <TableHead>{{ t('hswarm.v.managers.babysitter.resetHead') }}</TableHead>
              <TableHead>{{ t('hswarm.v.managers.babysitter.accountHead') }}</TableHead>
              <TableHead>{{ t('hswarm.v.managers.babysitter.stateHead') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="c in s.stopped" :key="c.id">
              <TableCell class="max-w-[16rem] truncate">{{ c.title }}</TableCell>
              <TableCell class="text-xs text-muted-foreground">{{ resetText(c.resetsAt) }}</TableCell>
              <TableCell class="text-xs">{{ sourceName(c.source) }} · {{ c.account }}</TableCell>
              <TableCell class="text-xs" :title="c.reason">{{ t(`hswarm.v.managers.babysitter.chatState.${c.state}`, c.state) }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <h3 class="text-sm font-medium">{{ t('hswarm.v.managers.babysitter.acts') }}</h3>
        <p v-if="!s.acts.length" class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.babysitter.noActs') }}</p>
        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>{{ t('hswarm.v.managers.babysitter.whenHead') }}</TableHead>
              <TableHead>{{ t('hswarm.v.managers.babysitter.chatHead') }}</TableHead>
              <TableHead>{{ t('hswarm.v.managers.babysitter.didHead') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="a in s.acts" :key="`${a.at}-${a.id}`">
              <TableCell class="whitespace-nowrap text-xs">{{ timeAgo(a.at) }}</TableCell>
              <TableCell class="max-w-[16rem] truncate">{{ a.title }}</TableCell>
              <TableCell class="text-xs">
                {{ t(`hswarm.v.managers.babysitter.did.${a.did}`, a.did) }}
                <span class="text-muted-foreground">· {{ a.detail }}</span>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </template>
    </CardContent>
  </Card>
</template>
