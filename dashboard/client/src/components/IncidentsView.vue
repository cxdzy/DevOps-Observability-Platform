<script setup lang="ts">
import type { Incident } from '@/types'
import type { Tier } from '@/lib/tier'
import { computed, ref } from 'vue'
import IncidentDetail from '@/components/IncidentDetail.vue'
import IncidentList from '@/components/IncidentList.vue'
import RangeSelect from '@/components/RangeSelect.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { FLAG_TIERS, TIER_STYLE, toTier } from '@/lib/tier'

const props = defineProps<{
  incidents: Incident[]
  loading: boolean
  failed: boolean
  loaded: boolean
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

const rangeText = computed(() =>
  hours.value > 24 && hours.value % 24 === 0 ? `${hours.value / 24} days` : `${hours.value} hours`,
)
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold tracking-[-0.02em]">Incidents</h1>
      <p class="mt-0.5 text-[13px] text-muted-foreground">
        <template v-if="loaded">{{ incidents.length }} in the last {{ rangeText }}, newest first</template>
        <template v-else>Last {{ rangeText }}, newest first</template>
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <div role="group" aria-label="Filter by tier" class="flex gap-0.5 rounded-lg bg-chip p-[3px]">
        <button
          v-for="f in FILTERS"
          :key="f.value"
          type="button"
          class="min-h-9 rounded-md px-3 text-[13px] md:min-h-8"
          :class="filter === f.value ? 'bg-card font-medium text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'"
          :aria-pressed="filter === f.value"
          @click="filter = f.value"
        >
          {{ f.label }}
        </button>
      </div>
      <RangeSelect v-model="hours" />
    </div>
  </div>

  <div v-if="loading" class="flex flex-col gap-3">
    <Skeleton v-for="n in 3" :key="n" class="h-14 rounded-xl" />
  </div>

  <p v-else-if="failed && !loaded" class="rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
    Incident data unavailable. Retrying every 30 seconds.
  </p>

  <template v-else>
    <p v-if="failed" class="rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg" role="status">
      Incident data could not be refreshed. Showing the last loaded data.
    </p>

    <div class="flex flex-wrap items-start gap-4">
      <div class="min-w-0 flex-[3_1_440px]">
        <p v-if="incidents.length === 0" class="rounded-xl border border-border py-16 text-center text-[13px] text-muted-foreground">No data in this range</p>
        <p v-else-if="visible.length === 0" class="rounded-xl border border-border py-16 text-center text-[13px] text-muted-foreground">No incidents match this filter</p>
        <IncidentList v-else :incidents="visible" :selected="selected" @select="selected = $event" />
      </div>
      <IncidentDetail class="min-w-0 flex-[2_1_320px]" :incident="incident" />
    </div>
  </template>
</template>
