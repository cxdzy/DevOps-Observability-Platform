<script setup lang="ts">
import { computed } from 'vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const hours = defineModel<number>({ required: true })

const OPTIONS = [
  { hours: 6, label: 'Last 6 hours' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 72, label: 'Last 3 days' },
  { hours: 168, label: 'Last 7 days' },
]

// The select works with strings; the model stays a number.
const value = computed({
  get: () => String(hours.value),
  set: (v: string) => { hours.value = Number(v) },
})
</script>

<template>
  <Select v-model="value">
    <SelectTrigger aria-label="Time range" class="w-36">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem v-for="o in OPTIONS" :key="o.hours" :value="String(o.hours)">
        {{ o.label }}
      </SelectItem>
    </SelectContent>
  </Select>
</template>
