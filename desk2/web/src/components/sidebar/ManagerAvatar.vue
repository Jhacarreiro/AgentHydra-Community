<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { PHOTO_TYPES, managerFace, uploadPhoto, type ChatManager } from './manager-face'

// The manager a chat is on, left of its row's title (manager-face.ts): its photo or its initial, 16px round. A click opens
// its card, without selecting the row: the photo larger, the name, title, one-line description and stats line, and Change photo,
// which replaces the photo for every row of that manager (a Hydra Core lead or seat who is no manager has none). `open` tells the row, which hides its own tooltip meanwhile.
const props = defineProps<{ manager: ChatManager }>()
const open = defineModel<boolean>('open', { default: false })

const face = computed(() => managerFace(props.manager))
// A photo that fails to load (gone from disk since the list came) draws the initial instead, until its version changes.
const broken = ref(false)
watch(() => face.value.src, () => (broken.value = false))
const photo = computed(() => (broken.value ? null : face.value.src))

const picker = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const error = ref('')
watch(open, (o) => o && (error.value = ''))

async function onPicked() {
  const file = picker.value?.files?.[0]
  if (picker.value) picker.value.value = ''
  if (!file) return
  busy.value = true
  error.value = ''
  try {
    await uploadPhoto(props.manager.slug, file)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Popover v-model:open="open">
    <!-- The Tip goes outside the trigger: between them, the armed tooltip drops the trigger's click (as the row's own menus found).
         The card hangs off the span, which stays while the Tip swaps its stand-in for the real tooltip (lib/first-interest.ts): a
         press that arms the Tip opens the card on the stand-in, and anchored to that button the card drew at the window's corner. -->
    <PopoverAnchor as-child>
      <span class="flex shrink-0">
        <Tip :label="open ? '' : face.label" side="top">
          <PopoverTrigger as-child>
            <button
              type="button"
              data-testid="manager-avatar"
              :aria-label="face.label"
              class="flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full outline-none focus-visible:ring-1 focus-visible:ring-accent aria-expanded:ring-1 aria-expanded:ring-text-muted"
              :style="photo ? undefined : { backgroundColor: face.tone.bg, color: face.tone.fg }"
              @click.stop
              @keydown.enter.stop
            >
              <!-- Zoomed from the top so a head-and-shoulders portrait shows its face at 16px; the card shows the whole photo. -->
              <img v-if="photo" :src="photo" alt="" decoding="async" class="size-full origin-top scale-160 object-cover" @error="broken = true" />
              <span v-else class="text-3xs font-semibold leading-none">{{ face.initial }}</span>
            </button>
          </PopoverTrigger>
        </Tip>
      </span>
    </PopoverAnchor>
    <PopoverContent side="bottom" align="start" :side-offset="6" :align-offset="-6" :collision-padding="8" class="w-68 gap-2.5 p-3" data-testid="manager-card">
      <div class="flex items-center gap-2.5">
        <span
          class="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full"
          :style="photo ? undefined : { backgroundColor: face.tone.bg, color: face.tone.fg }"
        >
          <img v-if="photo" :src="photo" alt="" class="size-full object-cover" @error="broken = true" />
          <span v-else class="text-ui-lg font-semibold">{{ face.initial }}</span>
        </span>
        <span class="flex min-w-0 flex-col">
          <span class="truncate text-ui font-semibold text-text">{{ manager.name }}</span>
          <span v-if="manager.title" class="truncate text-ui-sm text-text-muted">{{ manager.title }}</span>
        </span>
      </div>
      <p v-if="manager.oneLiner" class="line-clamp-3 text-ui-sm leading-4.5 text-text-2" :title="manager.oneLiner">{{ manager.oneLiner }}</p>
      <!-- Its analytics, one line as the server words it; nothing before there is data. -->
      <p v-if="manager.statsLine" data-testid="manager-stats" class="tnum truncate text-2xs text-text-muted" :title="manager.statsLine">{{ manager.statsLine }}</p>
      <!-- A persona who is no manager (a Hydra Core lead or seat) has its photo from elsewhere: nothing here changes it. -->
      <div v-if="face.canChangePhoto" class="flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="busy" @click="picker?.click()">{{ busy ? 'Saving photo…' : 'Change photo' }}</Button>
        <span class="text-2xs text-text-muted">Up to 2 MB</span>
      </div>
      <p v-if="error" role="alert" class="text-ui-sm leading-4.5 text-danger-text">{{ error }}</p>
      <input v-if="face.canChangePhoto" ref="picker" type="file" :accept="PHOTO_TYPES.join(',')" class="hidden" aria-label="Choose a photo" @change="onPicked" />
    </PopoverContent>
  </Popover>
</template>
