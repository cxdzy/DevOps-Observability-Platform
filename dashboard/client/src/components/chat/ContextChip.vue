<script setup lang="ts">
import type { ChatContext } from './chatStore'
import { computed } from 'vue'
import { mytClock } from './chatStore'

// "Talking about: 18:37 medium memory" above the input. Hidden when there is no context.
const props = defineProps<{ context: ChatContext | null }>()
const emit = defineEmits<{ clear: [] }>()

const label = computed(() => {
  const i = props.context?.last_incident
  if (!i) return null
  const ms = Date.parse(i.start)
  if (!Number.isFinite(ms)) return null
  return `${mytClock(ms)} ${i.tier} ${i.signal}`
})
</script>

<template>
  <div v-if="label" class="inline-flex w-fit max-w-full items-center gap-1 rounded-full bg-chip py-0.5 pr-0.5 pl-3 text-xs">
    <span class="min-w-0 truncate"><span class="text-muted-foreground">Talking about:</span> <span class="font-mono">{{ label }}</span></span>
    <button
      type="button"
      aria-label="Clear context"
      class="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground md:size-6"
      @click="emit('clear')"
    >
      <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
  </div>
</template>
