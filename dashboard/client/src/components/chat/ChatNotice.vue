<script setup lang="ts">
import type { NoticeKind } from './chatStore'
import { computed } from 'vue'

// An inline notice in the conversation: the hourly limit, a full queue or the model being down.
const props = defineProps<{ kind: NoticeKind, text: string }>()

const tone = computed(() => (props.kind === 'model_down'
  ? 'bg-tier-high-bg text-tier-high-fg'
  : 'bg-tier-medium-bg text-tier-medium-fg'))
const heading = computed(() => ({
  hourly_limit: 'Hourly limit reached',
  queue_full: 'Assistant busy',
  model_down: 'Model not answering',
}[props.kind]))
</script>

<template>
  <div class="relative flex max-w-[92%] flex-col gap-0.5 rounded-lg px-3 py-2 text-[13px]" :class="tone" role="status">
    <span class="font-semibold">{{ heading }}</span>
    <span>{{ text }}</span>
  </div>
</template>
