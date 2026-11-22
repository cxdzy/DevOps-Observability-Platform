<script setup lang="ts">
import type { Chat } from './chatStore'
import { computed, nextTick, ref } from 'vue'
import { TIER_SHAPE, TIER_STYLE, toTier } from '@/lib/tier'
import { mytClock, RENAME_CHARS } from './chatStore'

const props = defineProps<{ chat: Chat, active: boolean }>()
const emit = defineEmits<{ select: [], rename: [title: string], delete: [] }>()

// The incident this chat is talking about (its follow-up context), shown beside the last message
// time as the tier shape and the incident's start time. No context, no mark.
const topic = computed(() => {
  const incident = props.chat.context?.last_incident
  const ms = incident ? Date.parse(incident.start) : Number.NaN
  if (!incident || !Number.isFinite(ms)) return null
  const tier = toTier(incident.tier)
  return { time: mytClock(ms), tier, shape: TIER_SHAPE[tier], colour: `var(${TIER_STYLE[tier].markerVar})` }
})

const lastText = computed(() => (props.chat.lastAt ? mytClock(props.chat.lastAt) : 'No messages'))

// "Kenapa?, last message 08:32, talking about the 07:43 medium incident"
const accessibleName = computed(() => {
  const parts = [props.chat.title, props.chat.lastAt ? `last message ${lastText.value}` : 'no messages']
  if (topic.value) parts.push(`talking about the ${topic.value.time}${topic.value.tier === 'none' ? '' : ` ${topic.value.tier}`} incident`)
  if (props.chat.pending) parts.push('waiting for a reply')
  return parts.join(', ')
})

const editing = ref(false)
const name = ref('')
const input = ref<HTMLInputElement | null>(null)
const renameButton = ref<HTMLButtonElement | null>(null)

async function startRename() {
  name.value = props.chat.title
  editing.value = true
  await nextTick()
  input.value?.focus()
  input.value?.select()
}

async function finish(save: boolean) {
  if (!editing.value) return
  if (save) emit('rename', name.value)
  editing.value = false
  await nextTick()
  renameButton.value?.focus()
}
</script>

<template>
  <li class="group relative flex items-center gap-1 rounded-lg" :class="active ? 'bg-chip' : 'hover:bg-accent'">
    <form v-if="editing" class="flex min-w-0 flex-1 items-center gap-1 p-1" @submit.prevent="finish(true)">
      <input
        ref="input"
        v-model="name"
        :maxlength="RENAME_CHARS"
        aria-label="Chat name"
        class="min-h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[13px]"
        @keydown.esc.prevent="finish(false)"
        @blur="finish(true)"
      >
    </form>
    <template v-else>
      <button
        type="button"
        class="flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center rounded-lg px-2.5 py-1.5 text-left"
        :aria-current="active ? 'true' : undefined"
        :aria-label="accessibleName"
        @click="emit('select')"
      >
        <span class="flex w-full min-w-0 items-center gap-1.5 text-[13px]" :class="active ? 'font-medium text-foreground' : 'text-foreground'">
          <span class="min-w-0 truncate">{{ chat.title }}</span>
          <span v-if="chat.pending" class="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" />
        </span>
        <span class="flex items-center gap-2 font-mono text-[11px] text-faint" aria-hidden="true">
          <span>{{ lastText }}</span>
          <span v-if="topic" class="inline-flex items-center gap-1 text-muted-foreground">
            <svg class="size-2" viewBox="0 0 12 12"><path :d="topic.shape" :style="{ fill: topic.colour }" /></svg>
            {{ topic.time }}
          </span>
        </span>
      </button>
      <div class="flex shrink-0 items-center pr-1 opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
        <button
          ref="renameButton"
          type="button"
          :aria-label="`Rename ${chat.title}`"
          class="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground md:size-7"
          @click="startRename"
        >
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
        </button>
        <button
          type="button"
          :aria-label="`Delete ${chat.title}`"
          class="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground md:size-7"
          @click="emit('delete')"
        >
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
        </button>
      </div>
    </template>
  </li>
</template>
