<script setup lang="ts">
import type { AnomalyPoint, Incident } from '@/types'
import { computed } from 'vue'
import TierBadge from '@/components/TierBadge.vue'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { fixed } from '@/lib/format'
import { FLAG_TIERS, toTier } from '@/lib/tier'

const props = defineProps<{
  points: AnomalyPoint[]
  incidents: Incident[]
  incidentsFailed: boolean
}>()

const latest = computed(() => props.points[props.points.length - 1] ?? null)
const flaggedMinutes = computed(() => props.points.filter(p => p.is_anomaly === 1).length)
const counts = computed(() =>
  FLAG_TIERS.map(tier => ({
    tier,
    count: props.incidents.filter(i => toTier(i.tier) === tier).length,
  })),
)
</script>

<template>
  <div class="grid gap-4 sm:grid-cols-3">
    <Card size="sm">
      <CardHeader>
        <CardTitle class="text-sm font-medium text-muted-foreground">Latest score</CardTitle>
      </CardHeader>
      <CardContent class="flex items-center justify-between gap-2">
        <span class="font-mono text-2xl font-semibold">{{ fixed(latest?.score) }}</span>
        <TierBadge v-if="latest" :tier="latest.tier" />
      </CardContent>
    </Card>

    <Card size="sm">
      <CardHeader>
        <CardTitle class="text-sm font-medium text-muted-foreground">Flagged minutes</CardTitle>
      </CardHeader>
      <CardContent>
        <span class="font-mono text-2xl font-semibold">{{ flaggedMinutes }}</span>
      </CardContent>
    </Card>

    <Card size="sm">
      <CardHeader>
        <CardTitle class="text-sm font-medium text-muted-foreground">Incidents by tier</CardTitle>
      </CardHeader>
      <CardContent>
        <p v-if="incidentsFailed" class="text-sm text-muted-foreground">Unavailable</p>
        <div v-else class="flex flex-wrap gap-3">
          <span v-for="c in counts" :key="c.tier" class="flex items-center gap-1.5">
            <TierBadge :tier="c.tier" />
            <span class="font-mono font-semibold">{{ c.count }}</span>
          </span>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
