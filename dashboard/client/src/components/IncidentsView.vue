<script setup lang="ts">
import type { Incident } from '@/types'
import type { Tier } from '@/lib/tier'
import { computed, ref } from 'vue'
import IncidentDetail from '@/components/IncidentDetail.vue'
import IncidentList from '@/components/IncidentList.vue'
import RangeSelect from '@/components/RangeSelect.vue'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { FLAG_TIERS, TIER_STYLE, toTier } from '@/lib/tier'

const props = defineProps<{
  incidents: Incident[]
  loading: boolean
  failed: boolean
}>()
const hours = defineModel<number>('hours', { required: true })
const selected = defineModel<number | null>('selected', { required: true })

const filter = ref<Tier | 'all'>('all')
const FILTERS = [
  { value: 'all' as const, label: 'All' },
  ...FLAG_TIERS.map(t => ({ value: t, label: TIER_STYLE[t].label })),
]

const visible = computed(() =>
  filter.value === 'all' ? props.incidents : props.incidents.filter(i => toTier(i.tier) === filter.value),
)
const incident = computed(() => props.incidents.find(i => i.start === selected.value) ?? null)
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">Incident timeline</h2>
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex gap-1" role="group" aria-label="Filter by tier">
          <Button
            v-for="f in FILTERS"
            :key="f.value"
            size="sm"
            :variant="filter === f.value ? 'default' : 'outline'"
            :aria-pressed="filter === f.value"
            @click="filter = f.value"
          >
            {{ f.label }}
          </Button>
        </div>
        <RangeSelect v-model="hours" />
      </div>
    </div>

    <div v-if="loading" class="flex flex-col gap-3">
      <Skeleton v-for="n in 3" :key="n" class="h-24" />
    </div>

    <p v-else-if="failed" class="rounded-lg border border-red-200 bg-red-50 p-3 text-center text-sm text-red-800">
      Incident data unavailable. Retrying every 30 seconds.
    </p>

    <div v-else class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div class="min-w-0">
        <p v-if="incidents.length === 0" class="py-16 text-center text-sm text-muted-foreground">No data in this range</p>
        <p v-else-if="visible.length === 0" class="py-16 text-center text-sm text-muted-foreground">No incidents match this filter</p>
        <IncidentList v-else :incidents="visible" :selected="selected" @select="selected = $event" />
      </div>
      <IncidentDetail :incident="incident" />
    </div>
  </div>
</template>
