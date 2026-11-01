<script setup lang="ts">
import type { ChatStats } from '@/components/chat/AssistantStats.vue'
import type { ChatEntry, ReplyKind } from '@/components/chat/ChatMessage.vue'
import axios from 'axios'
import { computed, nextTick, onUnmounted, ref } from 'vue'
import AssistantStats from '@/components/chat/AssistantStats.vue'
import ChatMessage from '@/components/chat/ChatMessage.vue'
import CommandChips from '@/components/chat/CommandChips.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { useAuth } from '@/composables/useAuth'

// ready: the stats call worked and Ollama answered; null until the first check.
const emit = defineEmits<{ status: [ready: boolean], openIncident: [start: number] }>()

interface ChatReply {
  kind: ReplyKind
  answer: string
  incidents: { start: number, tier: string | null }[]
  sources: string[]
  elapsed_s: number
  model: string | null
}

const MAX_CHARS = 500
// The server answers within 95 s (it allows for the Cloudflare limit of 100 s).
const CHAT_TIMEOUT_MS = 100000
const SLOW_AFTER_S = 10
const NO_ANSWER = 'The assistant did not answer. Nothing was changed.'

const { me } = useAuth()
const isAdmin = computed(() => me.value?.role === 'admin')

// The conversation lives in this component only; a reload or another view clears it.
const entries = ref<ChatEntry[]>([])
let nextId = 1
const draft = ref('')
const pending = ref(false)
const waitedS = ref(0)
let waitTimer: number | undefined
const bottom = ref<HTMLElement | null>(null)

const stats = ref<ChatStats | null>(null)
const statsLoading = ref(true)
const statsFailed = ref(false)

async function loadStats() {
  try {
    const { data } = await api.get<ChatStats>('/api/chat/stats')
    stats.value = data
    statsFailed.value = false
    emit('status', data.ollamaUp === true)
  } catch {
    statsFailed.value = true
    emit('status', false)
  } finally {
    statsLoading.value = false
  }
}
const { refresh: refreshStats } = usePoll(loadStats, 60000)

const count = computed(() => draft.value.length)
const canSend = computed(() => !pending.value && draft.value.trim().length > 0 && count.value <= MAX_CHARS)

function scrollDown() {
  nextTick(() => bottom.value?.scrollIntoView({ block: 'nearest' }))
}

function errorText(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const message = (err.response?.data as { error?: unknown } | undefined)?.error
    if (typeof message === 'string' && err.response && [400, 429, 503].includes(err.response.status)) return message
  }
  return NO_ANSWER
}

async function send(text: string) {
  const message = text.trim()
  if (!message || pending.value || message.length > MAX_CHARS) return
  entries.value.push({ id: nextId++, role: 'user', text: message })
  draft.value = ''
  pending.value = true
  waitedS.value = 0
  waitTimer = window.setInterval(() => { waitedS.value += 1 }, 1000)
  scrollDown()
  try {
    const { data } = await api.post<ChatReply>('/api/chat', { message }, { timeout: CHAT_TIMEOUT_MS })
    entries.value.push({
      id: nextId++,
      role: 'assistant',
      text: data.answer,
      kind: data.kind,
      sources: data.sources,
      elapsedS: data.elapsed_s,
      incidents: data.incidents,
    })
  } catch (err) {
    entries.value.push({ id: nextId++, role: 'assistant', text: errorText(err), error: true })
  } finally {
    window.clearInterval(waitTimer)
    pending.value = false
    scrollDown()
    refreshStats()
  }
}

function onKeydown(event: KeyboardEvent) {
  // Enter sends, Shift+Enter starts a new line; Enter that ends an IME composition does neither.
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  if (canSend.value) send(draft.value)
}

onUnmounted(() => window.clearInterval(waitTimer))
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold tracking-[-0.02em]">Chat</h1>
      <p class="mt-0.5 text-[13px] text-muted-foreground">Ask about incidents, anomaly scores and nodes. Read-only.</p>
    </div>
  </div>

  <div class="flex flex-col gap-6 md:flex-row md:items-start">
    <section aria-label="Conversation" class="mx-auto flex w-full max-w-[760px] min-w-0 flex-1 flex-col gap-4">
      <div role="log" aria-live="polite" aria-relevant="additions" class="flex flex-col gap-5">
        <div v-if="entries.length === 0 && !pending" class="rounded-xl border border-dashed border-border p-5 text-[13px] text-muted-foreground">
          <p class="font-medium text-foreground">No messages yet</p>
          <p class="mt-1">
            Ask a question or pick one below. Answers come from the live dashboard data, through a local model.
            The conversation is kept on this page only and is cleared when you reload or open another view.
          </p>
        </div>

        <ChatMessage v-for="entry in entries" :key="entry.id" :entry="entry" @open-incident="emit('openIncident', $event)" />

        <div v-if="pending" class="flex max-w-[92%] gap-3" aria-busy="true">
          <span class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
          </span>
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton class="h-4 w-[min(420px,100%)]" />
            <Skeleton class="h-4 w-[min(300px,80%)]" />
            <span class="text-xs text-faint" role="status">
              Waiting for the assistant, <span class="font-mono">{{ waitedS }}</span> s<template v-if="waitedS >= SLOW_AFTER_S">. Still working. The local model runs on CPU and can take up to 30 s</template>
            </span>
          </div>
        </div>
        <div ref="bottom" aria-hidden="true" />
      </div>

      <div class="flex flex-col gap-3 border-t border-border pt-4">
        <CommandChips :is-admin="isAdmin" :disabled="pending" @send="send" />
        <form class="flex items-end gap-2 rounded-xl border border-input py-2 pr-2 pl-3.5" @submit.prevent="send(draft)">
          <textarea
            v-model="draft"
            aria-label="Message"
            aria-describedby="chat-count chat-note"
            rows="2"
            :maxlength="MAX_CHARS"
            placeholder="Ask about incidents, scores or nodes"
            class="min-w-0 flex-1 resize-none border-0 bg-transparent py-1 text-foreground placeholder:text-muted-foreground"
            @keydown="onKeydown"
          />
          <div class="flex flex-col items-end gap-1">
            <span id="chat-count" class="font-mono text-[11px] text-faint">{{ count }} / {{ MAX_CHARS }}</span>
            <button
              type="submit"
              aria-label="Send"
              class="flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50 md:size-9"
              :disabled="!canSend"
            >
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
            </button>
          </div>
        </form>
        <p id="chat-note" class="text-xs text-muted-foreground">
          Answers use live data only. Viewers can ask questions; restart requests need an admin and a Telegram approval.
        </p>
      </div>
    </section>

    <div class="w-full shrink-0 border-border max-md:border-t max-md:pt-5 md:w-[240px] md:border-l md:pl-6">
      <AssistantStats :stats="stats" :loading="statsLoading" :failed="statsFailed" />
    </div>
  </div>
</template>
