<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ isAdmin: boolean, disabled: boolean }>()
const emit = defineEmits<{ send: [text: string] }>()

// The first three are answered from live data by fixed templates. The restart chip is shown to
// admins only; until restart requests are connected (6B-7) it gets the "not connected yet" reply.
const chips = computed(() => [
  { text: 'System status', icon: null },
  { text: 'Last incident', icon: null },
  { text: 'Health check', icon: null },
  ...(props.isAdmin ? [{ text: 'Restart sample-service', icon: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7' }] : []),
])
</script>

<template>
  <div role="group" aria-label="Quick questions" class="flex flex-wrap gap-2">
    <button
      v-for="chip in chips"
      :key="chip.text"
      type="button"
      class="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border px-3.5 text-[13px] hover:bg-chip disabled:cursor-not-allowed disabled:opacity-50 md:min-h-9"
      :disabled="disabled"
      @click="emit('send', chip.text)"
    >
      <svg v-if="chip.icon" class="size-[13px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="chip.icon" /></svg>
      {{ chip.text }}
    </button>
  </div>
</template>
