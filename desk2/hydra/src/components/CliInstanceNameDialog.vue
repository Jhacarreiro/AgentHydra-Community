<script setup lang="ts">
// The one small text-input dialog every instance table renames with; `namespace` points it at the
// table's own wording. Nothing is named on create any more: the daemon names a new instance.
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { CLI_INSTANCE_DIALOG_KEYS, type CliDialogNamespace } from '@/lib/instance-dialog-i18n'

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  namespace?: CliDialogNamespace
  currentName?: string | null
  submitting?: boolean
  errorMessage?: string | null
}>()

const emit = defineEmits<{
  submit: [name: string]
}>()

const name = ref('')

// Rename starts from the current name.
watch(open, (isOpen) => {
  if (isOpen) name.value = props.currentName ?? ''
})

const keys = computed(() => CLI_INSTANCE_DIALOG_KEYS[props.namespace ?? 'cliInstances'])
const titleKey = computed(() => keys.value.renameDialogTitle)
const descriptionKey = computed(() => keys.value.renameDialogDescription)
const submitKey = computed(() => keys.value.renameDialogSubmit)
const submittingKey = computed(() => keys.value.renameDialogRenaming)

function handleSubmit() {
  const trimmed = name.value.trim()
  if (!trimmed) return
  emit('submit', trimmed)
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <form @submit.prevent="handleSubmit">
        <DialogHeader>
          <DialogTitle>{{ $t(titleKey) }}</DialogTitle>
          <DialogDescription>{{ $t(descriptionKey) }}</DialogDescription>
        </DialogHeader>

        <div class="mt-3 flex flex-col gap-1.5">
          <label for="cli-instance-name" class="text-xs font-medium text-muted-foreground">
            {{ $t(keys.nameLabel) }}
          </label>
          <Input
            id="cli-instance-name"
            v-model="name"
            :placeholder="$t(keys.namePlaceholder)"
            :disabled="submitting"
            autofocus
          />
          <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
        </div>

        <DialogFooter class="mt-4">
          <Button type="submit" :disabled="submitting || !name.trim()">
            {{ submitting ? $t(submittingKey) : $t(submitKey) }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
