<script setup lang="ts">
import type { AnomalyPoint, Incident } from '@/types'
import { computed } from 'vue'
import AnomalyChart from '@/components/AnomalyChart.vue'
import PointDetail from '@/components/PointDetail.vue'
import RangeSelect from '@/components/RangeSelect.vue'
import SummaryCards from '@/components/SummaryCards.vue'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { incidentAt } from '@/lib/incident'

const props = defineProps<{
  points: AnomalyPoint[]
  incidents: Incident[]
  loading: boolean
  pointsFailed: boolean
  incidentsFailed: boolean
}>()
const hours = defineModel<number>('hours', { required: true })
const selected = defineModel<number | null>('selected', { required: true })

const point = computed(() =>
  selected.value === null ? null : props.points.find(p => p.time === selected.value) ?? null,
)
const incident = computed(() => (point.value ? incidentAt(props.incidents, point.value.time) : null))
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">Anomaly scores</h2>
      <RangeSelect v-model="hours" />
    </div>

    <div v-if="loading" class="flex flex-col gap-4">
      <div class="grid gap-4 sm:grid-cols-3">
        <Skeleton v-for="n in 3" :key="n" class="h-24" />
      </div>
      <Skeleton class="h-[260px] md:h-[320px]" />
    </div>

    <p v-else-if="pointsFailed" class="rounded-lg border border-red-200 bg-red-50 p-3 text-center text-sm text-red-800">
      Anomaly data unavailable. Retrying every 30 seconds.
    </p>

    <template v-else>
      <SummaryCards :points="points" :incidents="incidents" :incidents-failed="incidentsFailed" />

      <p v-if="incidentsFailed" class="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
        Incident details unavailable
      </p>

      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card class="min-w-0">
          <CardContent>
            <p v-if="points.length === 0" class="py-16 text-center text-sm text-muted-foreground">No data in this range</p>
            <AnomalyChart v-else :points="points" :hours="hours" :selected="selected" @select="selected = $event" />
          </CardContent>
        </Card>
        <PointDetail :point="point" :incident="incident" />
      </div>
    </template>
  </div>
</template>
