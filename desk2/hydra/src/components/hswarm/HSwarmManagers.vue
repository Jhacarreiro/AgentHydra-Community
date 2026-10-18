<script setup lang="ts">
// The Managers node: the three managers Desk keeps, each a page of its own in the tree (HSwarmView.vue).
import { ChevronRight } from '@lucide/vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { Managers } from '@/composables/useManagers'
import { EMBEDDED, openSettingsInDesk } from '@/lib/desk-embed'
import { MANAGER_DOT_CLASS, managerDot } from '@/lib/managers'

const props = defineProps<{ managers: Managers }>()
const emit = defineEmits<{ open: [path: string[]] }>()
const { t } = useI18n()

const rows = computed(() => {
  const m = props.managers
  return [
    {
      id: 'babysitter',
      title: t('hswarm.v.managers.babysitter.title'),
      dot: managerDot(m.babysitter?.enabled, false),
      line: m.babysitter ? `${m.babysitter.stopped.length} ${t('hswarm.v.managers.babysitter.stopped').toLowerCase()}` : '',
    },
    {
      id: 'orchestrator',
      title: t('hswarm.v.managers.orchestrator.title'),
      dot: managerDot(m.orchestrator ? m.orchestrator.mode === 'armed' : undefined, false),
      line: m.orchestrator ? (m.orchestrator.mode === 'armed' ? t('hswarm.v.managers.orchestrator.armed') : t('hswarm.v.managers.orchestrator.shadow')) : '',
    },
    {
      id: 'routines',
      title: t('hswarm.v.managers.routines.title'),
      dot: managerDot(m.routines?.enabled, false),
      line: m.routines ? `${m.routines.routines.length} ${t('hswarm.v.managers.routines.routines').toLowerCase()}` : '',
    },
  ]
})
</script>

<template>
  <Card size="sm">
    <CardHeader>
      <CardTitle size="lg">{{ t('hswarm.v.managers.title') }}</CardTitle>
      <CardDescription>{{ t('hswarm.v.managers.caption') }}</CardDescription>
    </CardHeader>
    <CardContent stack="sm">
      <div class="grid gap-2 sm:grid-cols-3">
        <button
          v-for="r in rows"
          :key="r.id"
          type="button"
          class="flex min-w-0 items-center gap-2 rounded-lg border bg-card px-3 py-2 text-start hover:bg-accent/60"
          @click="emit('open', ['managers', r.id])"
        >
          <span
            class="size-2 shrink-0 rounded-full"
            :class="r.dot ? MANAGER_DOT_CLASS[r.dot] : 'border border-muted-foreground'"
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ r.title }}</span>
            <span class="block truncate text-xs text-muted-foreground">{{ r.line }}</span>
          </span>
          <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
        </button>
      </div>
      <Button v-if="EMBEDDED" size="sm" variant="outline" class="self-start" @click="openSettingsInDesk('managers')">
        {{ t('hswarm.v.managers.settings') }}
      </Button>
    </CardContent>
  </Card>
</template>
