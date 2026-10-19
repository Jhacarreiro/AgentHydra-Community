<script setup lang="ts">
import { onMounted, ref } from 'vue'

type Message = { role: 'user' | 'assistant'; text: string }
const messages = ref<Message[]>([])
const status = ref('Connecting to ChatGPT…')

async function load() {
  status.value = 'Connecting to ChatGPT…'
  try {
    const response = await fetch('/api/chatgpt/visible', { cache: 'no-store' })
    if (!response.ok) {
      status.value = response.status === 503
        ? 'ChatGPT is not connected to this Hub yet.'
        : 'Unable to read ChatGPT from this Hub.'
      return
    }
    const data = await response.json() as { messages?: Message[] }
    messages.value = data.messages ?? []
    status.value = messages.value.length ? '' : 'No visible ChatGPT messages.'
  } catch {
    status.value = 'ChatGPT is temporarily unavailable.'
  }
}
onMounted(load)
</script>

<template>
  <main class="size-full overflow-y-auto p-6" aria-label="ChatGPT experimental view">
    <div class="mx-auto max-w-3xl">
      <div class="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 class="text-xl font-semibold">ChatGPT</h1>
          <p class="text-sm opacity-70">Experimental read-only view. The original ChatGPT conversation remains authoritative.</p>
        </div>
        <button class="rounded border px-3 py-2 text-sm" type="button" @click="load">Refresh</button>
      </div>
      <p v-if="status" role="status" class="rounded border p-4">{{ status }}</p>
      <div v-for="(message, index) in messages" :key="index" class="mb-4 rounded border p-4">
        <div class="mb-2 text-xs font-semibold uppercase opacity-60">{{ message.role }}</div>
        <p class="whitespace-pre-wrap break-words">{{ message.text }}</p>
      </div>
    </div>
  </main>
</template>
