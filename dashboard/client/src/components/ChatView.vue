<script lang="ts">
import type { ChatReply, ChatStore } from '@/components/chat/chatStore'
import { reactive } from 'vue'
import { createChatStore } from '@/components/chat/chatStore'
import { postChat } from '@/composables/useApi'

// One store for the page, kept in memory while the app runs: chats survive a switch to another
// view, and a reload clears them.
let store: ChatStore | null = null
function useChats(): ChatStore {
  store ??= createChatStore({ post: (message, context) => postChat<ChatReply>(message, context), wrap: v => reactive(v) as typeof v })
  return store
}
</script>

<script setup lang="ts">
import type { ChatStats } from '@/components/chat/AssistantStats.vue'
import type { ReplyChip } from '@/components/chat/chatStore'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import AssistantStats from '@/components/chat/AssistantStats.vue'
import BusyLine from '@/components/chat/BusyLine.vue'
import ChatList from '@/components/chat/ChatList.vue'
import ChatMessage from '@/components/chat/ChatMessage.vue'
import ChatSheet from '@/components/chat/ChatSheet.vue'
import CommandChips from '@/components/chat/CommandChips.vue'
import ContextChip from '@/components/chat/ContextChip.vue'
import DeleteChatDialog from '@/components/chat/DeleteChatDialog.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { useAuth } from '@/composables/useAuth'

// ready: the stats call worked and Ollama answered; null until the first check.
const emit = defineEmits<{ status: [ready: boolean], openIncident: [start: number] }>()

const MAX_CHARS = 500
const SLOW_AFTER_S = 10
// The busy line waits a second, so a quick template answer in another chat does not flash it.
const BUSY_AFTER_S = 1

const { me } = useAuth()
const isAdmin = computed(() => me.value?.role === 'admin')

const chats = useChats()
const chat = computed(() => chats.active())
const sheetOpen = ref(false)
const deleteId = ref<number | null>(null)
const deleteTitle = computed(() => (deleteId.value === null ? null : chats.find(deleteId.value)?.title ?? null))
const bottom = ref<HTMLElement | null>(null)
const input = ref<HTMLTextAreaElement | null>(null)

// A clock for the seconds shown while any chat waits.
const tick = ref(Date.now())
let tickTimer: number | undefined
const anyPending = computed(() => chats.state.chats.some(c => c.pending !== null))
watch(anyPending, (on) => {
  window.clearInterval(tickTimer)
  if (on) tickTimer = window.setInterval(() => { tick.value = Date.now() }, 1000)
}, { immediate: true })

const waitedS = computed(() => {
  const p = chat.value.pending
  return p ? Math.max(0, Math.floor((tick.value - p.since) / 1000)) : 0
})
const behind = computed(() => {
  void tick.value
  return chats.waitingBehind(chat.value.id)
})
const busy = computed(() => {
  void tick.value
  const b = chats.busyFor(chat.value.id)
  return b && b.seconds >= BUSY_AFTER_S ? b : null
})

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

const count = computed(() => chat.value.draft.length)
const canSend = computed(() => !chat.value.pending && chat.value.draft.trim().length > 0 && count.value <= MAX_CHARS)

function scrollDown() {
  nextTick(() => bottom.value?.scrollIntoView({ block: 'nearest' }))
}

async function run(job: Promise<void>, id: number) {
  if (chat.value.id === id) scrollDown()
  await job
  if (chat.value.id === id) scrollDown()
  refreshStats()
}

function send(text: string) {
  const message = text.trim()
  if (!message || chat.value.pending || message.length > MAX_CHARS) return
  const id = chat.value.id
  run(chats.send(message, id), id)
}

function choose(chip: ReplyChip) {
  const id = chat.value.id
  run(chats.chooseIncident(chip, id), id)
}

function onKeydown(event: KeyboardEvent) {
  // Enter sends, Shift+Enter starts a new line; Enter that ends an IME composition does neither.
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  if (canSend.value) send(chat.value.draft)
}

// Each chat keeps its own scroll position.
function switchTo(id: number) {
  if (id === chat.value.id) {
    sheetOpen.value = false
    return
  }
  chat.value.scrollTop = window.scrollY
  chats.select(id)
  sheetOpen.value = false
  const top = chat.value.scrollTop
  nextTick(() => window.scrollTo({ top }))
}

function createChat() {
  chat.value.scrollTop = window.scrollY
  if (chats.newChat()) {
    sheetOpen.value = false
    nextTick(() => input.value?.focus())
  }
}

function confirmDelete() {
  if (deleteId.value !== null) chats.remove(deleteId.value)
  deleteId.value = null
}

onUnmounted(() => window.clearInterval(tickTimer))
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold tracking-[-0.02em]">Chat</h1>
      <p class="mt-0.5 text-[13px] text-muted-foreground">Ask about incidents, anomaly scores and nodes. Read-only.</p>
    </div>
    <button
      type="button"
      class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-chip lg:hidden"
      aria-haspopup="dialog"
      @click="sheetOpen = true"
    >
      <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5z" /></svg>
      Chats
      <span class="font-mono text-xs text-muted-foreground">{{ chats.state.chats.length }}</span>
    </button>
  </div>

  <div class="flex gap-6 lg:items-start">
    <aside aria-label="Chats and assistant" class="hidden w-[272px] shrink-0 flex-col gap-6 border-r border-border pr-5 lg:sticky lg:top-2 lg:flex lg:max-h-[calc(100dvh-1rem)] lg:overflow-y-auto">
      <ChatList
        :chats="chats.state.chats"
        :active-id="chats.state.activeId"
        :can-create="chats.canCreate()"
        @select="switchTo"
        @create="createChat"
        @rename="(id, title) => chats.rename(id, title)"
        @delete="deleteId = $event"
      />
      <div class="mt-auto border-t border-border pt-5">
        <AssistantStats :stats="stats" :loading="statsLoading" :failed="statsFailed" />
      </div>
    </aside>

    <section :aria-label="`Conversation: ${chat.title}`" class="mx-auto flex w-full max-w-[760px] min-w-0 flex-1 flex-col gap-4">
      <div role="log" aria-live="polite" aria-relevant="additions" class="flex flex-col gap-5">
        <div v-if="chat.messages.length === 0 && !chat.pending" class="rounded-xl border border-dashed border-border p-5 text-[13px] text-muted-foreground">
          <p class="font-medium text-foreground">No messages yet</p>
          <p class="mt-1">
            Ask a question or pick one below. Answers come from the live dashboard data, through fixed templates or a local model.
            After a question about an incident you can ask follow-ups such as "why did it happen?" or "and the one before?".
            Chats are kept on this page only and are cleared when you reload.
          </p>
        </div>

        <ChatMessage
          v-for="entry in chat.messages"
          :key="entry.id"
          :entry="entry"
          :disabled="chat.pending !== null"
          @open-incident="emit('openIncident', $event)"
          @choose="choose"
        />

        <div v-if="chat.pending" class="flex max-w-[92%] gap-3" aria-busy="true">
          <span class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
          </span>
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton class="h-4 w-[min(420px,100%)]" />
            <Skeleton class="h-4 w-[min(300px,80%)]" />
            <span v-if="behind" class="text-xs text-faint" role="status">Waiting for another chat to finish first, <span class="font-mono">{{ waitedS }}</span> s</span>
            <span v-else class="text-xs text-faint" role="status">
              Waiting for the assistant, <span class="font-mono">{{ waitedS }}</span> s<template v-if="waitedS >= SLOW_AFTER_S">. Still working. The local model runs on CPU and can take up to 30 s</template>
            </span>
          </div>
        </div>
        <div ref="bottom" aria-hidden="true" />
      </div>

      <div class="flex flex-col gap-3 border-t border-border pt-4">
        <BusyLine v-if="busy" :title="busy.title" :seconds="busy.seconds" @go="switchTo(busy.chatId)" />
        <CommandChips :is-admin="isAdmin" :disabled="chat.pending !== null" @send="send" />
        <ContextChip :context="chat.context" @clear="chats.clearContext(chat.id)" />
        <form class="flex items-end gap-2 rounded-xl border border-input py-2 pr-2 pl-3.5" @submit.prevent="send(chat.draft)">
          <textarea
            ref="input"
            v-model="chat.draft"
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
  </div>

  <ChatSheet :open="sheetOpen" @close="sheetOpen = false">
    <ChatList
      :chats="chats.state.chats"
      :active-id="chats.state.activeId"
      :can-create="chats.canCreate()"
      @select="switchTo"
      @create="createChat"
      @rename="(id, title) => chats.rename(id, title)"
      @delete="deleteId = $event"
    />
    <div class="border-t border-border pt-4">
      <AssistantStats :stats="stats" :loading="statsLoading" :failed="statsFailed" />
    </div>
  </ChatSheet>

  <DeleteChatDialog :title="deleteTitle" @confirm="confirmDelete" @cancel="deleteId = null" />
</template>
