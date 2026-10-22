<script setup lang="ts">
import { computed } from 'vue'
import { RefreshCw } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import PaneSwitch from './PaneSwitch.vue'
import { BUTTON, FIELD } from './settings-styles'
import type { AgentHydraSettings, AhSettingsPatch, AhSettings } from './agenthydra'
import type { SettingsRowId } from './settings'

// The control of one AgentHydra row in the Settings dialog (the `ah` rows of settings.ts). Fields save
// when they change, as every Desk setting does; the SMTP password is never read back, so its box is
// always empty and only a typed value is sent.
const props = defineProps<{ id: SettingsRowId; label: string; ah: AgentHydraSettings }>()

type BoolKey = { [K in keyof AhSettings]: AhSettings[K] extends boolean ? K : never }[keyof AhSettings]
type NumKey = { [K in keyof AhSettings]: AhSettings[K] extends number ? K : never }[keyof AhSettings]
type TextKey = 'notifyEmailTo' | 'notifyEmailFrom' | 'notifySmtpHost' | 'notifySmtpUser'

const SWITCHES: Partial<Record<SettingsRowId, BoolKey>> = {
  ahAlerts: 'notifyEnabled',
  ahSessionReset: 'notifySessionReset',
  ahWeeklyReset: 'notifyWeeklyReset',
  ahDesktop: 'notifyDesktop',
  ahPersistent: 'notifyPersistent',
  ahEmail: 'notifyEmail',
  ahSmtpSecure: 'notifySmtpSecure',
  ahMcp: 'mcpRegisterClaudeCode',
  ahTray: 'hideTrayIcon',
  ahShowCli: 'showCliInstances',
  ahKeepalive: 'keepaliveEnabled',
  ahKeepAwake: 'keepAwakeWhileWorking',
  ahCloudSessions: 'cloudSessions',
  ahShowDesktop: 'showDesktopInstances',
  ahShowCodexDesktop: 'codexDesktopEnabled',
  ahShowCodexCli: 'codexCliEnabled',
  ahShowDsh: 'dshEnabled',
  ahExtraUsage: 'allowExtraUsage'
}
const NUMBERS: Partial<Record<SettingsRowId, { key: NumKey; min: number; max: number; unit: string }>> = {
  ahMinPct: { key: 'notifyMinPct', min: 0, max: 100, unit: '%' },
  ahSessionMaxWeekly: { key: 'notifySessionMaxWeeklyPct', min: 0, max: 100, unit: '%' },
  ahInterval: { key: 'notifyPersistentIntervalMin', min: 1, max: 1440, unit: 'minutes' },
  ahRepeats: { key: 'notifyPersistentMaxRepeats', min: 0, max: 200, unit: 'reminders' },
  ahSmtpPort: { key: 'notifySmtpPort', min: 1, max: 65535, unit: '' },
  ahKeepaliveFloor: { key: 'keepaliveWeeklyFloorPct', min: 0, max: 100, unit: '%' }
}
const TEXTS: Partial<Record<SettingsRowId, { key: TextKey; type: string }>> = {
  ahEmailTo: { key: 'notifyEmailTo', type: 'email' },
  ahEmailFrom: { key: 'notifyEmailFrom', type: 'email' },
  ahSmtpHost: { key: 'notifySmtpHost', type: 'text' },
  ahSmtpUser: { key: 'notifySmtpUser', type: 'text' }
}

const s = computed(() => props.ah.settings.value)
const sw = computed(() => SWITCHES[props.id])
const num = computed(() => NUMBERS[props.id])
const text = computed(() => TEXTS[props.id])

function saveNumber(e: Event) {
  const spec = num.value
  const box = e.target as HTMLInputElement
  if (!spec || !s.value) return
  const n = Math.round(Number(box.value))
  if (!Number.isFinite(n) || box.value.trim() === '') {
    box.value = String(s.value[spec.key])
    return
  }
  const v = Math.min(spec.max, Math.max(spec.min, n))
  box.value = String(v)
  if (v !== s.value[spec.key]) void props.ah.save({ [spec.key]: v } as AhSettingsPatch)
}
function saveText(e: Event) {
  const spec = text.value
  const v = (e.target as HTMLInputElement).value.trim()
  if (spec && s.value && v !== s.value[spec.key]) void props.ah.save({ [spec.key]: v } as AhSettingsPatch)
}
function savePassword(e: Event) {
  const box = e.target as HTMLInputElement
  if (!box.value) return
  void props.ah.save({ notifySmtpPass: box.value })
  box.value = ''
}

const versionColor = computed(() => {
  switch (props.ah.updateState.value) {
    case 'up-to-date':
      return 'text-success-text'
    case 'available':
      return 'text-warning'
    case 'blocked':
    case 'no-source':
      return 'text-danger-text'
    default:
      return 'text-text-2'
  }
})
const updateLabel = computed(() => {
  if (props.ah.applying.value) return 'Updating…'
  if (props.ah.checking.value) return 'Checking…'
  return props.ah.updateState.value === 'available' ? 'Install update' : 'Check for updates'
})
function onUpdateButton() {
  if (props.ah.checking.value || props.ah.applying.value) return
  if (props.ah.updateState.value === 'available') void props.ah.applyUpdate()
  else void props.ah.checkUpdate()
}
</script>

<template>
  <PaneSwitch
    v-if="id === 'ahTooltips'"
    label="Show tooltips"
    :model-value="ah.tooltips.value"
    @update:model-value="(v: boolean) => (ah.tooltips.value = v)"
  />
  <PaneSwitch
    v-else-if="id === 'ahPrivacy'"
    label="Privacy mode"
    :model-value="ah.privacy.value"
    @update:model-value="(v: boolean) => (ah.privacy.value = v)"
  />

  <Tip v-else-if="ah.down.value" :label="ah.down.value">
    <span class="text-ui leading-4.75 text-text-muted">AgentHydra is not answering</span>
  </Tip>

  <div v-else-if="id === 'ahVersion'" class="flex shrink-0 items-center gap-3">
    <span class="font-mono text-ui leading-4.75">
      <span :class="versionColor">{{ ah.update.value?.currentVersion ? `v${ah.update.value.currentVersion}` : '…' }}</span>
      <span v-if="ah.update.value?.currentCommit" class="text-text-muted"> · {{ ah.update.value.currentCommit.slice(0, 7) }}</span>
    </span>
    <button
      type="button"
      :class="BUTTON"
      class="gap-1.5"
      :disabled="ah.checking.value || ah.applying.value || ah.updateState.value === 'no-source'"
      @click="onUpdateButton"
    >
      <RefreshCw v-if="ah.checking.value || ah.applying.value" class="size-3.5 animate-spin" />
      {{ updateLabel }}
    </button>
  </div>

  <PaneSwitch
    v-else-if="id === 'ahAutoUpdate'"
    label="Auto-update"
    :disabled="ah.autoUpdate.value === null || ah.updateState.value === 'no-source'"
    :model-value="!!ah.autoUpdate.value"
    @update:model-value="(v: boolean) => ah.setAutoUpdate(v)"
  />

  <span v-else-if="!s" class="text-ui leading-4.75 text-text-muted">Loading…</span>

  <PaneSwitch v-else-if="sw" :label="label" :model-value="s[sw]" @update:model-value="(v: boolean) => ah.save({ [sw!]: v } as AhSettingsPatch)" />

  <div v-else-if="num" class="flex shrink-0 items-center gap-2 text-ui leading-4.75 text-text-muted">
    <input
      :key="s[num.key]"
      type="number"
      :min="num.min"
      :max="num.max"
      :value="s[num.key]"
      :aria-label="label"
      :class="[FIELD, 'tnum w-20 text-end [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none']"
      @change="saveNumber"
      @keydown.enter="($event.target as HTMLInputElement).blur()"
    />
    {{ num.unit }}
  </div>

  <input
    v-else-if="text"
    :key="s[text.key]"
    :type="text.type"
    :value="s[text.key]"
    :aria-label="label"
    spellcheck="false"
    :class="[FIELD, 'w-56']"
    @change="saveText"
    @keydown.enter="($event.target as HTMLInputElement).blur()"
  />

  <input
    v-else-if="id === 'ahSmtpPass'"
    type="password"
    autocomplete="new-password"
    :aria-label="label"
    :placeholder="s.notifySmtpPassSet ? 'Stored' : ''"
    :class="[FIELD, 'w-56']"
    @change="savePassword"
    @keydown.enter="($event.target as HTMLInputElement).blur()"
  />

  <button v-else-if="id === 'ahTest'" type="button" :class="BUTTON" @click="ah.sendTest()">Send</button>

  <button v-else-if="id === 'ahQuickShortcut'" type="button" :class="BUTTON" @click="ah.createQuickShortcut()">Add to Desktop</button>

  <button v-else-if="id === 'ahRepair'" type="button" :class="BUTTON" :disabled="ah.applying.value" @click="ah.repair()">
    {{ ah.applying.value ? 'Repairing…' : 'Repair' }}
  </button>
</template>
