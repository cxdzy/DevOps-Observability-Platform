<script setup lang="ts">
const hours = defineModel<number>({ required: true })

// The same four ranges on every view, because the range is shared between them.
const OPTIONS = [
  { hours: 6, label: '6 h', title: 'Last 6 hours' },
  { hours: 24, label: '24 h', title: 'Last 24 hours' },
  { hours: 72, label: '3 d', title: 'Last 3 days' },
  { hours: 168, label: '7 d', title: 'Last 7 days' },
]
</script>

<template>
  <div role="group" aria-label="Time range" class="flex gap-0.5 rounded-lg bg-chip p-[3px]">
    <button
      v-for="o in OPTIONS"
      :key="o.hours"
      type="button"
      class="min-h-9 rounded-md px-3 text-[13px] md:min-h-8"
      :class="hours === o.hours ? 'bg-card font-medium text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'"
      :aria-pressed="hours === o.hours"
      :title="o.title"
      @click="hours = o.hours"
    >
      {{ o.label }}
    </button>
  </div>
</template>
