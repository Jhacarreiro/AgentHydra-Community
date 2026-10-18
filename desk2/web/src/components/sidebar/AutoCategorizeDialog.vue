<script setup lang="ts">
// Auto-categorize for a scratch group: shows each chat's project from its transcript, and moves them only when the owner
// confirms. A moved chat can go back (its group null: its folder's again). Mounted once by the sidebar; the menu opens it
// by setting `categorizing` to the folder.
import { computed, ref, watch } from 'vue'
import type { PlacementMove, PlacementProposal } from '@shared/protocol'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { applyPlacements, categorizing, proposeCategorize, stayReason } from './projectStats'

const items = ref<PlacementProposal[] | null>(null)
const error = ref<string | null>(null)
const busy = ref(false)
/** The chats this dialog moved (by id), and the ones it put back. */
const moved = ref<Set<string>>(new Set())
const failed = ref<Set<string>>(new Set())
const back = ref<Set<string>>(new Set())

const toMove = computed(() => (items.value ?? []).filter((i) => i.group && !moved.value.has(i.id)))
const staying = computed(() => (items.value ?? []).filter((i) => !i.group))

watch(categorizing, async (folder) => {
  items.value = null
  error.value = null
  moved.value = new Set()
  failed.value = new Set()
  back.value = new Set()
  if (!folder) return
  try {
    const out = await proposeCategorize(folder)
    if (categorizing.value === folder) items.value = out.items
  } catch (err) {
    if (categorizing.value === folder) error.value = (err as Error).message
  }
})

function close(): void {
  categorizing.value = null
}

async function confirm(): Promise<void> {
  const moves: PlacementMove[] = toMove.value.map((i) => ({ kind: i.kind, id: i.id, group: i.group }))
  if (!moves.length) return
  busy.value = true
  error.value = null
  try {
    const out = await applyPlacements(moves)
    const bad = new Set(out.failed.map((f) => f.id))
    moved.value = new Set(moves.filter((m) => !bad.has(m.id)).map((m) => m.id))
    failed.value = bad
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

async function putBack(item: PlacementProposal): Promise<void> {
  busy.value = true
  try {
    await applyPlacements([{ kind: item.kind, id: item.id, group: null }])
    back.value = new Set([...back.value, item.id])
    moved.value = new Set([...moved.value].filter((id) => id !== item.id))
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog :open="categorizing !== null" @update:open="(o: boolean) => !o && close()">
    <DialogContent :show-close-button="false" class="max-h-[80vh] gap-3 overflow-y-auto rounded-(--radius-12) p-4 shadow-(--shadow-popover) ring-0 sm:max-w-120">
      <DialogTitle class="text-ui-lg font-semibold leading-5 text-text">Auto-categorize chats</DialogTitle>
      <DialogDescription class="text-ui leading-4.75 text-text-2">
        Each chat moves to the project its transcript shows it worked in. Nothing moves until you confirm, and no session file is touched.
      </DialogDescription>

      <div v-if="items === null && !error" class="text-ui text-text-muted" role="status">Reading the chats...</div>
      <div v-if="error" class="text-ui text-text-2" role="alert">{{ error }}</div>

      <ul v-if="items" class="flex flex-col gap-1.5 text-ui leading-4.75 text-text">
        <li v-for="item in items" :key="item.id" class="flex items-baseline gap-2">
          <span class="min-w-0 flex-1 truncate">{{ item.title || 'Untitled chat' }}</span>
          <span v-if="moved.has(item.id)" class="shrink-0 text-text-2">moved to {{ item.project?.name }}</span>
          <span v-else-if="back.has(item.id)" class="shrink-0 text-text-muted">back in scratch</span>
          <span v-else-if="item.group" class="shrink-0 text-text-2">→ {{ item.project?.name }}</span>
          <span v-else class="shrink-0 text-text-muted">stays: could not tell ({{ stayReason(item) }})</span>
          <span v-if="failed.has(item.id)" class="shrink-0 text-text-2">not moved</span>
          <button
            v-if="moved.has(item.id)"
            type="button"
            class="shrink-0 rounded-md px-1.5 text-ui-sm text-text-2 underline-offset-2 hover:underline"
            :disabled="busy"
            @click="putBack(item)"
          >
            Move back to scratch
          </button>
        </li>
        <li v-if="!items.length" class="text-text-muted">No chats in this group are waiting to be categorized.</li>
      </ul>

      <div class="flex justify-end gap-2 pt-1">
        <button type="button" class="rounded-md px-3 py-1.5 text-ui text-text-2 hover:text-text" @click="close">Close</button>
        <button
          v-if="toMove.length"
          type="button"
          class="rounded-md bg-accent px-3 py-1.5 text-ui font-medium text-white disabled:opacity-50"
          :disabled="busy"
          @click="confirm"
        >
          Move {{ toMove.length }} {{ toMove.length === 1 ? 'chat' : 'chats' }}
        </button>
      </div>
      <span class="sr-only">{{ staying.length }} stay where they are</span>
    </DialogContent>
  </Dialog>
</template>
