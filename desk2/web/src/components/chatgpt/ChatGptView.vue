<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import MarkdownBlock from '@/components/transcript/parts/MarkdownBlock.vue'
import { ago, type Conversation, errorWords, nextReadMs, running, STATE_WORDS, type Summary } from './logic'

// ChatGPT through the AgentHydra that holds the browser bridge. The account stays authoritative: nothing here is
// kept, and a message goes to ChatGPT only when the person presses Send.
const list = shallowRef<Summary[]>([])
const listError = ref('')
const openId = ref<string | null>(null)
const conversation = shallowRef<Conversation | null>(null)
const readError = ref('')
const draft = ref('')
const sending = ref(false)
const sendError = ref('')
const sentAt = ref<number | null>(null)
const scroller = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let listTimer: ReturnType<typeof setInterval> | undefined

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...init })
  const data = (await response.json().catch(() => null)) as (T & { code?: string }) | null
  if (!response.ok || !data) throw new Error(errorWords(data?.code))
  return data
}

async function loadList() {
  try {
    list.value = (await call<{ conversations: Summary[] }>('/api/chatgpt/conversations?limit=50')).conversations
    listError.value = ''
  } catch (e) {
    listError.value = (e as Error).message
  }
}

const atBottom = () => {
  const el = scroller.value
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

async function read(id: string) {
  clearTimeout(timer)
  try {
    const stick = atBottom()
    const next = await call<Conversation>(`/api/chatgpt/conversations/${id}`)
    if (openId.value !== id) return
    const grew = next.messages.length !== conversation.value?.messages.length
    conversation.value = next
    readError.value = ''
    if (!running(next.state) && sentAt.value !== null && next.messages.at(-1)?.role === 'assistant') sentAt.value = null
    if (grew || stick) await nextTick(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight }))
  } catch (e) {
    if (openId.value === id) readError.value = (e as Error).message
  }
  if (openId.value === id && document.visibilityState !== 'hidden')
    timer = setTimeout(() => read(id), nextReadMs(conversation.value?.state, sentAt.value))
}

function open(id: string | null) {
  openId.value = id
  conversation.value = null
  readError.value = sendError.value = ''
  sentAt.value = null
  clearTimeout(timer)
  if (id) void read(id)
}

async function send() {
  const text = draft.value.trim()
  if (!text || sending.value) return
  sending.value = true
  sendError.value = ''
  const id = openId.value
  try {
    const path = id ? `/api/chatgpt/conversations/${id}/messages` : '/api/chatgpt/conversations'
    const result = await call<{ id: string | null }>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    draft.value = ''
    // open() starts a new conversation's view afresh, so the send time is set after it.
    if (!id && result.id) open(result.id)
    sentAt.value = Date.now()
    if (id) void read(id)
    void loadList()
  } catch (e) {
    sendError.value = (e as Error).message
  } finally {
    sending.value = false
  }
}

async function stop() {
  if (!openId.value) return
  try {
    await call(`/api/chatgpt/conversations/${openId.value}/stop`, { method: 'POST' })
    void read(openId.value)
  } catch (e) {
    sendError.value = (e as Error).message
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}

function onVisible() {
  if (document.visibilityState === 'visible' && openId.value) void read(openId.value)
}

const title = computed(() => conversation.value?.title || (openId.value ? 'ChatGPT' : 'New conversation'))
const state = computed(() => conversation.value?.state)

onMounted(() => {
  void loadList()
  listTimer = setInterval(() => document.visibilityState === 'visible' && loadList(), 60_000)
  document.addEventListener('visibilitychange', onVisible)
})
onBeforeUnmount(() => {
  clearTimeout(timer)
  clearInterval(listTimer)
  document.removeEventListener('visibilitychange', onVisible)
})
</script>

<template>
  <main class="flex size-full min-h-0" aria-label="ChatGPT">
    <nav class="flex w-72 shrink-0 flex-col border-r" aria-label="ChatGPT conversations">
      <div class="flex items-center justify-between gap-2 p-3">
        <div class="flex items-center gap-2">
          <a class="rounded border px-2 py-1 text-ui-sm" href="#/" aria-label="Back to AgentHydra">Back</a>
          <h1 class="text-ui-lg font-semibold">ChatGPT</h1>
        </div>
        <button class="rounded border px-2 py-1 text-ui-sm" type="button" @click="open(null)">New</button>
      </div>
      <p v-if="listError" role="status" class="mx-3 rounded border p-3 text-ui-sm">{{ listError }}</p>
      <ul class="min-h-0 flex-1 overflow-y-auto">
        <li v-for="item in list" :key="item.id">
          <button
            type="button"
            class="flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left text-ui hover:bg-black/5 dark:hover:bg-white/5"
            :class="item.id === openId ? 'bg-black/10 dark:bg-white/10' : ''"
            @click="open(item.id)"
          >
            <span class="truncate">{{ item.title || 'Untitled' }}</span>
            <span class="shrink-0 text-2xs opacity-60">{{ ago(item.updatedAt) }}</span>
          </button>
        </li>
      </ul>
    </nav>
    <section class="flex min-w-0 flex-1 flex-col" :aria-label="title">
      <header class="flex items-center justify-between gap-3 border-b px-4 py-3">
        <h2 class="truncate text-ui-lg font-semibold">{{ title }}</h2>
        <div class="flex shrink-0 items-center gap-2">
          <span v-if="state" role="status" class="rounded-full border px-2 py-0.5 text-2xs" :class="running(state) ? 'animate-pulse' : ''">{{ STATE_WORDS[state] }}</span>
          <button v-if="running(state)" type="button" class="rounded border px-2 py-1 text-ui-sm" @click="stop">Stop</button>
        </div>
      </header>
      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div class="mx-auto max-w-3xl">
          <p v-if="readError" role="status" class="mb-4 rounded border p-3 text-ui-sm">{{ readError }}</p>
          <p v-if="!openId" class="text-ui opacity-70">Write below to start a new ChatGPT conversation, or pick one on the left. The conversation stays in ChatGPT; AgentHydra keeps no copy.</p>
          <p v-else-if="!conversation && !readError" class="text-ui opacity-70">Reading the conversation…</p>
          <p v-if="conversation?.truncated" class="mb-4 text-ui-sm opacity-60">Only the latest messages are shown.</p>
          <div v-for="message in conversation?.messages ?? []" :key="message.id" class="mb-4" :class="message.role === 'user' ? 'flex justify-end' : ''">
            <p v-if="message.role === 'user'" class="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-black/5 px-4 py-2 text-ui dark:bg-white/10">{{ message.text }}</p>
            <MarkdownBlock v-else :text="message.text" :streaming="state === 'generating' && message === conversation?.messages.at(-1)" />
          </div>
        </div>
      </div>
      <form class="border-t p-3" @submit.prevent="send">
        <div class="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            v-model="draft"
            rows="3"
            class="min-h-0 flex-1 resize-none rounded border bg-transparent p-2 text-ui"
            :placeholder="openId ? 'Reply to ChatGPT' : 'Message ChatGPT'"
            aria-label="Message ChatGPT"
            :disabled="sending"
            @keydown="onKey"
          />
          <button type="submit" class="rounded border px-3 py-2 text-ui-sm" :disabled="sending || !draft.trim() || running(state)">
            {{ sending ? 'Sending…' : 'Send' }}
          </button>
        </div>
        <p v-if="sendError" role="alert" class="mx-auto mt-2 max-w-3xl text-ui-sm">{{ sendError }}</p>
      </form>
    </section>
  </main>
</template>
