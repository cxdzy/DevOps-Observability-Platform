<script setup lang="ts">
import type { Chat } from './chatStore'
import ChatListItem from './ChatListItem.vue'
import { LIMIT_REASON, MAX_CHATS } from './chatStore'

defineProps<{ chats: Chat[], activeId: number, canCreate: boolean }>()
const emit = defineEmits<{ select: [id: number], create: [], rename: [id: number, title: string], delete: [id: number] }>()
</script>

<template>
  <nav aria-label="Chats" class="flex min-w-0 flex-col gap-2">
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-[15px] font-semibold">Chats</h2>
      <button
        type="button"
        class="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-chip disabled:cursor-not-allowed disabled:opacity-50 md:min-h-8"
        :disabled="!canCreate"
        :aria-describedby="canCreate ? undefined : 'chat-limit-reason'"
        @click="emit('create')"
      >
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        New chat
      </button>
    </div>
    <p v-if="!canCreate" id="chat-limit-reason" class="text-xs text-muted-foreground">{{ LIMIT_REASON }}</p>
    <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
      <ChatListItem
        v-for="chat in chats"
        :key="chat.id"
        :chat="chat"
        :active="chat.id === activeId"
        @select="emit('select', chat.id)"
        @rename="emit('rename', chat.id, $event)"
        @delete="emit('delete', chat.id)"
      />
    </ul>
    <p class="text-xs text-muted-foreground">Up to {{ MAX_CHATS }} chats, kept on this page only. A reload clears them.</p>
  </nav>
</template>
