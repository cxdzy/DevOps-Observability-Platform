<script setup lang="ts">
import type { AnomalyPoint, Incident } from '@/types'
import { computed } from 'vue'
import TierBadge from '@/components/TierBadge.vue'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { fixed, localDateTime, orDash } from '@/lib/format'
import { explanationFallback } from '@/lib/incident'

const props = defineProps<{
  point: AnomalyPoint | null
  incident: Incident | null
}>()

const rows = computed(() => {
  const p = props.point
  if (!p) return []
  const deployed = p.recent_deployment === true || p.recent_deployment === 1
  return [
    ['Score', fixed(p.score)],
    ['Threshold', fixed(p.threshold)],
    ['Signal', orDash(p.signal)],
    ['CPU rate', fixed(p.cpu_rate)],
    ['Memory MB', fixed(p.memory_mb, 1)],
    ['Latency ms', fixed(p.latency_ms, 1)],
    ['Deployment', deployed ? 'Yes' : 'No'],
    ['Model', orDash(p.model)],
  ]
})
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>Selected minute</CardTitle>
    </CardHeader>
    <CardContent class="flex flex-col gap-3 text-sm">
      <p v-if="!point" class="text-muted-foreground">Click a point on the chart</p>
      <template v-else>
        <div class="flex items-center justify-between gap-2">
          <span>{{ localDateTime(point.time) }}</span>
          <TierBadge :tier="point.tier" />
        </div>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <template v-for="[label, value] in rows" :key="label">
            <dt class="text-muted-foreground">{{ label }}</dt>
            <dd class="text-right font-mono break-all">{{ value }}</dd>
          </template>
        </dl>

        <template v-if="incident">
          <Separator />
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">Incident</span>
            <TierBadge :tier="incident.tier" />
            <span class="text-muted-foreground">action: {{ orDash(incident.action) }}</span>
          </div>
          <p class="whitespace-pre-wrap break-words">{{ incident.explanation ?? explanationFallback(incident) }}</p>
        </template>
      </template>
    </CardContent>
  </Card>
</template>
