<script setup lang="ts">
import type { AnomalyPoint, Incident } from '@/types'
import { computed, defineAsyncComponent } from 'vue'
import ChartLoadError from '@/components/ChartLoadError.vue'
import ChartSkeleton from '@/components/ChartSkeleton.vue'
import PointDetail from '@/components/PointDetail.vue'
import RangeSelect from '@/components/RangeSelect.vue'
import SummaryCards from '@/components/SummaryCards.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { incidentAt } from '@/lib/incident'

// ECharts is most of the bundle, so the chart is downloaded only when this view first shows it.
const AnomalyChart = defineAsyncComponent({
  loader: () => import('@/components/AnomalyChart.vue'),
  loadingComponent: ChartSkeleton,
  errorComponent: ChartLoadError,
  delay: 0,
  timeout: 30000,
})

const props = defineProps<{
  points: AnomalyPoint[]
  incidents: Incident[]
  loading: boolean
  pointsFailed: boolean
  incidentsFailed: boolean
  pointsLoaded: boolean
  incidentsLoaded: boolean
}>()
const hours = defineModel<number>('hours', { required: true })
const selected = defineModel<number | null>('selected', { required: true })

const point = computed(() =>
  selected.value === null ? null : props.points.find(p => p.time === selected.value) ?? null,
)
const incident = computed(() => (point.value ? incidentAt(props.incidents, point.value.time) : null))

const warning = 'rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg'
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold tracking-[-0.02em]">Anomaly scores</h1>
      <p class="mt-0.5 text-[13px] text-muted-foreground">One score per minute, local time</p>
    </div>
    <RangeSelect v-model="hours" />
  </div>

  <template v-if="loading">
    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
      <Skeleton v-for="n in 4" :key="n" class="h-[116px] rounded-xl" />
    </div>
    <ChartSkeleton />
  </template>

  <p v-else-if="pointsFailed && !pointsLoaded" class="rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
    Anomaly data unavailable. Retrying every 30 seconds.
  </p>

  <template v-else>
    <p v-if="pointsFailed" :class="warning" role="status">
      Anomaly data could not be refreshed. Showing the last loaded data.
    </p>

    <SummaryCards :points="points" :incidents="incidents" :incidents-failed="incidentsFailed && !incidentsLoaded" />

    <p v-if="incidentsFailed" :class="warning" role="status">
      {{ incidentsLoaded ? 'Incident details could not be refreshed. Showing the last loaded data.' : 'Incident details unavailable' }}
    </p>

    <div class="flex flex-wrap items-stretch gap-4">
      <section aria-label="Anomaly score chart" class="min-w-0 flex-[2_1_520px] rounded-xl border border-border px-[18px] py-4">
        <div class="mb-2">
          <h2 class="text-[15px] font-semibold">Score over time</h2>
          <p class="text-xs text-muted-foreground">Click a minute to see its details</p>
        </div>
        <p v-if="points.length === 0" class="py-16 text-center text-[13px] text-muted-foreground">No data in this range</p>
        <AnomalyChart v-else :points="points" :hours="hours" :selected="selected" @select="selected = $event" />
      </section>
      <PointDetail class="min-w-0 flex-[1_1_280px]" :point="point" :incident="incident" />
    </div>
  </template>
</template>
