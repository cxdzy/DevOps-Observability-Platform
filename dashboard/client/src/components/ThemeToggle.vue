<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { computed } from 'vue'
import { useTheme } from '@/composables/useTheme'
import { cn } from '@/lib/utils'

// The class prop is merged with cn, so a caller can change the size or hide it on phones.
const props = defineProps<{ class?: HTMLAttributes['class'] }>()

const { theme, toggle } = useTheme()
const label = computed(() => (theme.value === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'))
</script>

<template>
  <button
    type="button"
    :class="cn('flex size-9 items-center justify-center rounded-lg border border-border bg-transparent text-foreground hover:bg-chip', props.class)"
    :aria-label="label"
    :title="label"
    @click="toggle"
  >
    <svg v-if="theme === 'dark'" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
    <svg v-else class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
  </button>
</template>
