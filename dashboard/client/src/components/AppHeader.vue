<script setup lang="ts">
import { computed } from 'vue'
import ThemeToggle from '@/components/ThemeToggle.vue'

const props = defineProps<{
  group: string
  page: string
  // Time of the last successful data load, and whether the latest load worked.
  refreshedAt: number | null
  live: boolean
}>()

const refreshed = computed(() =>
  props.refreshedAt === null
    ? ''
    : new Date(props.refreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
)
const liveText = computed(() => {
  if (props.refreshedAt === null) return props.live ? 'Connecting' : 'Not connected, retrying'
  return props.live ? `Live, ${refreshed.value}` : `Retrying, last update ${refreshed.value}`
})
</script>

<template>
  <header class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 md:px-6">
    <nav aria-label="Breadcrumb" class="flex items-center gap-2 text-[13px] text-muted-foreground">
      <span>{{ group }}</span>
      <span aria-hidden="true">/</span>
      <span class="font-medium text-foreground" aria-current="page">{{ page }}</span>
    </nav>

    <label class="ml-auto hidden min-h-9 min-w-[220px] items-center gap-2 rounded-lg border border-border px-2.5 text-[13px] text-muted-foreground md:flex" title="Search comes later">
      <svg class="size-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4.5 4.5" /></svg>
      <input
        type="search"
        disabled
        aria-label="Search, comes later"
        placeholder="Search incidents"
        class="min-w-0 flex-1 cursor-not-allowed border-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
      >
      <kbd class="rounded border border-border px-1.5 font-mono text-[11px]" aria-hidden="true">Ctrl K</kbd>
    </label>

    <span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground max-md:ml-auto">
      <span
        class="size-2 rounded-full"
        :class="refreshedAt === null && live ? 'border-2 border-idle' : live ? 'bg-okdot' : 'bg-tier-high-marker'"
        aria-hidden="true"
      />
      <span class="font-mono">{{ liveText }}</span>
    </span>

    <ThemeToggle class="hidden md:flex" />
  </header>
</template>
